// Falling back to another backend when a command cannot run where it was sent.
//
// The exec tool tells a model to retry on a heavier backend only after a
// "command not found" or a similar capability error. The Workspace's
// `fallback` option makes that retry itself: when a command on any other
// command backend ends with a capability error, the runtime runs the same
// command on the fallback backend (typically a ContainerBackend) and the
// caller sees one execution. An ordinary failure — a type error, a failing
// test, a non-zero build — is the command's answer, not a capability error,
// and is never retried.

import type { Database } from "@cloudflare/dofs";

import type { WorkspaceModuleBackendHandle, WorkspaceRuntimeEvent } from "./types";

/** How a command ended, as the fallback test sees it. */
export interface WorkspaceCommandExit {
  readonly backend: string;
  readonly exitCode: number;
  /** The end of the command's stderr, decoded as UTF-8. */
  readonly stderr: string;
}

export interface WorkspaceFallbackOptions {
  /** The registered command backend that runs commands the others cannot. */
  backend: string;
  /** Whether an exit is a capability error. Defaults to `isCapabilityError`. */
  when?: (exit: WorkspaceCommandExit) => boolean;
}

// Kitebuild's applets exit with this and print one marker line per
// unsupported feature before doing any work (see @cloudflare/kitebuild-ci).
const KITEBUILD_UNSUPPORTED_EXIT = 3;
const KITEBUILD_UNSUPPORTED_MARKER = "kitebuild: unsupported: ";

// How much stderr the test sees: enough for the shell's last message.
export const FALLBACK_STDERR_TAIL = 4096;

// What shells print for a program they cannot find: bash's "command not
// found", dash's and BusyBox's "not found", and BusyBox's "can't execute
// 'x': No such file or directory" when PATH lookup finds nothing to run.
const MISSING_PROGRAM = /not found|can't execute '[^']*': No such file or directory/i;

/**
 * A capability error: the shell found no such program (exit 127 with
 * "not found" or BusyBox's "can't execute"), or a Kitebuild applet
 * reported an unsupported feature.
 */
export function isCapabilityError(exit: WorkspaceCommandExit): boolean {
  if (exit.exitCode === 127) return MISSING_PROGRAM.test(exit.stderr);
  if (exit.exitCode === KITEBUILD_UNSUPPORTED_EXIT)
    return exit.stderr.includes(KITEBUILD_UNSUPPORTED_MARKER);
  return false;
}

type Sync = { pushed: number; outcome: Promise<unknown> };

export interface FallbackRun {
  events: ReadableStream<WorkspaceRuntimeEvent>;
  sync?: Sync;
}

/**
 * The first run's events, or — when it ends with a capability error — its
 * output, a note, and the fallback run's events in its place. The fallback
 * run's sync bracket settles before the stream closes, so its file changes
 * are in the Workspace when the caller sees the end. If the fallback cannot
 * start, the note says why and the first run's exit stands.
 */
export function withFallback(
  backend: string,
  first: ReadableStream<WorkspaceRuntimeEvent>,
  options: Required<WorkspaceFallbackOptions>,
  rerun: () => Promise<FallbackRun>,
  onSwitch: () => void,
): ReadableStream<WorkspaceRuntimeEvent> {
  const decoder = new TextDecoder();
  let stderr = "";
  let lastSeq = 0;
  const note = (id: string, text: string): WorkspaceRuntimeEvent => ({
    id,
    seq: ++lastSeq,
    name: "stderr",
    value: new TextEncoder().encode(`computer: ${text}\n`),
  });
  return first.pipeThrough(
    new TransformStream<WorkspaceRuntimeEvent, WorkspaceRuntimeEvent>({
      async transform(event, controller) {
        lastSeq = Math.max(lastSeq, event.seq);
        if (event.name === "stderr") {
          stderr = (stderr + decoder.decode(event.value, { stream: true })).slice(
            -FALLBACK_STDERR_TAIL,
          );
        }
        if (event.name !== "exit") {
          controller.enqueue(event);
          return;
        }
        const exit = { backend, exitCode: event.code, stderr };
        if (!options.when(exit)) {
          controller.enqueue(event);
          return;
        }
        let run: FallbackRun;
        try {
          run = await rerun();
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          controller.enqueue(
            note(
              event.id,
              `fallback backend ${JSON.stringify(options.backend)} is unavailable: ${reason}`,
            ),
          );
          controller.enqueue({ ...event, seq: ++lastSeq });
          return;
        }
        onSwitch();
        controller.enqueue(
          note(
            event.id,
            `${JSON.stringify(backend)} cannot run this command; running it on ${JSON.stringify(options.backend)}`,
          ),
        );
        const base = lastSeq;
        const reader = run.events.getReader();
        try {
          for (;;) {
            const next = await reader.read();
            if (next.done) break;
            lastSeq = base + next.value.seq;
            controller.enqueue({ ...next.value, id: event.id, seq: lastSeq });
          }
        } finally {
          reader.releaseLock();
        }
        // Pulls the fallback's file changes back before the caller sees the end.
        await run.sync?.outcome;
      },
    }),
  );
}

/**
 * Where executions moved to a fallback backend went, by the backend they
 * started on and their id, so lookups by id after the handle is gone (or
 * the Durable Object restarted) reach both runs.
 */
export interface FallbackRoutes {
  get(backend: string, id: string): string | undefined;
  remember(backend: string, id: string, fallback: string): void;
  forget(backend: string, id: string): void;
}

/** Routes kept in memory, for a runtime without a database. */
export class MemoryFallbackRoutes implements FallbackRoutes {
  readonly #routes = new Map<string, string>();
  get(backend: string, id: string): string | undefined {
    return this.#routes.get(JSON.stringify([backend, id]));
  }
  remember(backend: string, id: string, fallback: string): void {
    this.#routes.set(JSON.stringify([backend, id]), fallback);
  }
  forget(backend: string, id: string): void {
    this.#routes.delete(JSON.stringify([backend, id]));
  }
}

/** Routes kept in the Workspace database, so they survive a restart. */
export class SqlFallbackRoutes implements FallbackRoutes {
  constructor(private readonly db: Database) {
    db.run(`
      CREATE TABLE IF NOT EXISTS computer_execution_fallback (
        backend TEXT NOT NULL,
        execution_id TEXT NOT NULL,
        fallback TEXT NOT NULL,
        PRIMARY KEY (backend, execution_id)
      )
    `);
  }
  get(backend: string, id: string): string | undefined {
    return this.db.scalar<string>(
      "SELECT fallback FROM computer_execution_fallback WHERE backend = ? AND execution_id = ?",
      backend,
      id,
    );
  }
  remember(backend: string, id: string, fallback: string): void {
    this.db.run(
      `INSERT INTO computer_execution_fallback (backend, execution_id, fallback) VALUES (?, ?, ?)
       ON CONFLICT(backend, execution_id) DO UPDATE SET fallback = excluded.fallback`,
      backend,
      id,
      fallback,
    );
  }
  forget(backend: string, id: string): void {
    this.db.run(
      "DELETE FROM computer_execution_fallback WHERE backend = ? AND execution_id = ?",
      backend,
      id,
    );
  }
}

/**
 * A handle for an execution that moved from `first` (backend `backend`) to
 * `second` (backend `fallback`). Replays rebuild the stream the caller saw
 * live: the first run up to its exit, the note, then the fallback run, with
 * the same sequence numbers. Kills go to the fallback run, which is the one
 * that can still be running; dispose removes both.
 */
export function movedExecution(
  backend: string,
  first: WorkspaceModuleBackendHandle,
  fallback: string,
  second: WorkspaceModuleBackendHandle,
): WorkspaceModuleBackendHandle {
  return {
    exec: (input) => second.exec(input),
    async getExec({ id, after }) {
      if (after === "tail") {
        // Only what the fallback run has yet to print, numbered after the
        // first run's exit and the note.
        const base = (await lastSeq((await first.getExec({ id })).events)) + 1;
        const tail = await second.getExec({ id, after: "tail" });
        return { ...tail, id, events: renumber(tail.events, id, base) };
      }
      const start = await first.getExec({ id });
      const combined = withFallback(
        backend,
        start.events,
        { backend: fallback, when: () => true },
        async () => ({ events: (await second.getExec({ id })).events }),
        () => {},
      );
      return {
        id,
        events:
          after === undefined
            ? combined
            : combined.pipeThrough(
                new TransformStream<WorkspaceRuntimeEvent, WorkspaceRuntimeEvent>({
                  transform(event, controller) {
                    if (event.seq > after) controller.enqueue(event);
                  },
                }),
              ),
      };
    },
    killExec: (input) => second.killExec(input),
    async disposeExec(input) {
      await first.disposeExec({ id: input.id });
      await second.disposeExec(input);
    },
  };
}

async function lastSeq(events: ReadableStream<WorkspaceRuntimeEvent>): Promise<number> {
  let last = 0;
  for await (const event of events) last = Math.max(last, event.seq);
  return last;
}

function renumber(
  events: ReadableStream<WorkspaceRuntimeEvent>,
  id: string,
  base: number,
): ReadableStream<WorkspaceRuntimeEvent> {
  return events.pipeThrough(
    new TransformStream<WorkspaceRuntimeEvent, WorkspaceRuntimeEvent>({
      transform(event, controller) {
        controller.enqueue({ ...event, id, seq: base + event.seq });
      },
    }),
  );
}

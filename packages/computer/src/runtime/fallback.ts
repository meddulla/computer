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

import type { WorkspaceRuntimeEvent } from "./types";

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
  if (exit.exitCode === KITEBUILD_UNSUPPORTED_EXIT) return exit.stderr.includes(KITEBUILD_UNSUPPORTED_MARKER);
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
          stderr = (stderr + decoder.decode(event.value, { stream: true })).slice(-FALLBACK_STDERR_TAIL);
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
          controller.enqueue(note(event.id, `fallback backend ${JSON.stringify(options.backend)} is unavailable: ${reason}`));
          controller.enqueue({ ...event, seq: ++lastSeq });
          return;
        }
        onSwitch();
        controller.enqueue(
          note(event.id, `${JSON.stringify(backend)} cannot run this command; running it on ${JSON.stringify(options.backend)}`),
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

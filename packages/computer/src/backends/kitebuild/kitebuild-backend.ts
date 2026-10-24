// KitebuildBackend: shell commands on a Kitebuild machine, the BusyBox
// userland busyworker runs inside a Worker by emulating the Linux
// syscall ABI.
//
// The machine lives in the Durable Object that owns the Workspace and
// mounts the Workspace store directly (./workspace-mount.ts), so the
// handle declares sync: "none". Commands are real processes: pipes,
// background jobs and signals work, and output streams as it is
// written. `git` is Kitebuild's git by default, working on the
// machine's own files, or the Workspace's git client when asked. The
// Worker shell's `assets` and `artifacts` commands are built in
// (./workspace-commands.ts); other programs beyond BusyBox come from
// toolsets the caller installs and passes in.

import type { ExecEvent, ShellRPC, SyncRPC, WorkspaceRPC } from "@cloudflare/computer-rpc";
import { coalesceChanges, currentRev, SQLiteWorkspaceProvider } from "@cloudflare/dofs";
import {
  type EgressPolicy,
  type FsNode,
  type LocalFetcher,
  Machine,
  ProgramRegistry,
  type Toolset,
} from "@cloudflare/kitebuild-core";
import BUSYBOX from "@cloudflare/kitebuild-core/artifacts/busybox.wasm";
import INITRAMFS from "@cloudflare/kitebuild-core/artifacts/initramfs.wasm";
import { git as kitebuildGit } from "@cloudflare/kitebuild-git";

import type { BackendHandle, WorkspaceBackend, WorkspaceBackendHost } from "../../backend";
import { hostEgressFetch, type WorkspaceEgressPolicy } from "../../runtime/egress";
import { ExecJournal } from "./exec-journal";
import { workspacePrograms } from "./workspace-commands";
import { mountWorkspace, type WorkspaceMount } from "./workspace-mount";

export interface KitebuildBackendOptions {
  /** Selector for runtime.exec({ backend }). Defaults to "kitebuild". */
  id?: string;
  /**
   * Programs beyond BusyBox, each with the host values it needs. A
   * toolset's `extras` are merged into the machine's extras.
   */
  tools?: readonly Toolset[];
  /**
   * Workspace directories mounted at the same path in the machine.
   * Created in the Workspace when missing. Defaults to ["/workspace"].
   */
  paths?: readonly string[];
  /** Outbound network for commands. Defaults to { mode: "none" }. */
  egress?: WorkspaceEgressPolicy;
  /** Most file bytes cached in memory for reads. Defaults to 8 MiB. */
  cacheBytes?: number;
  /** Environment every command starts with, before its own `env`. */
  env?: Record<string, string>;
  /** Most commands running at once. Defaults to 4. */
  maxExecs?: number;
  /**
   * Which `git` the shell has. "kitebuild" (the default) is Kitebuild's
   * git (@cloudflare/kitebuild-git), run on the machine's own files. Its
   * HTTP follows `egress` like every other command: refused under "none",
   * sent directly under "direct", and through the gateway under
   * "http-gateway". `{ fetch }` is the same with each request handed to
   * `fetch` first, for example to add credentials; it sends the request on
   * with `egressFetch`, which applies the policy. "workspace" is the
   * Workspace's git client, as in the Worker shell, which runs on the host
   * and does not follow `egress`. A toolset program at /usr/bin/git
   * replaces any.
   */
  git?: "kitebuild" | "workspace" | { fetch: KitebuildGitFetch };
}

/** A caller's step in front of Kitebuild git's HTTP; see `KitebuildBackendOptions.git`. */
export type KitebuildGitFetch = (
  request: Request,
  egressFetch: (request: Request) => Promise<Response>,
) => Promise<Response>;

const DEFAULT_ENV = { HOME: "/root", PATH: "/usr/bin:/bin:/usr/sbin:/sbin", TERM: "dumb" };
const SIGNALS = { SIGHUP: 1, SIGINT: 2, SIGKILL: 9, SIGTERM: 15 } as const;
const KILL_GRACE_MS = 5_000;
// Finished executions kept for getExec, oldest dropped first.
const RETAINED_EXECS = 64;
const CHAR_DEVICE = 0o020000;

/**
 * Runs shell commands on a Kitebuild machine in the host Durable Object.
 *
 * Experimental: this API may change in any release and is not yet
 * suitable for production use.
 */
export class KitebuildBackend implements WorkspaceBackend {
  readonly type = "kitebuild";
  readonly id: string;
  readonly description: string;
  readonly #options: KitebuildBackendOptions;

  constructor(options: KitebuildBackendOptions = {}) {
    this.id = options.id ?? "kitebuild";
    this.#options = options;
    const extra = (options.tools ?? []).flatMap((tool) =>
      tool.programs.map((p) => p.path.split("/").pop()),
    );
    const more =
      extra.length > 0 ? `, plus ${extra.join(", ")}.` : ". Cannot run binaries outside that set.";
    this.description = `A BusyBox Linux userland in the Workspace's Durable Object, with real processes, pipes, background jobs and signals, and output that streams as it is written. Workspace files are shared directly with the file tools. Has sh, awk, sed, grep, find, xargs, tar, gzip, xz, diff, patch, vi, wget and the rest of BusyBox, git, and the assets and artifacts commands${more}`;
  }

  async connect(host: WorkspaceBackendHost): Promise<BackendHandle> {
    const runtime = new KitebuildRuntime(this.id, host, this.#options);
    const rpc: WorkspaceRPC = { sync: refuseSync(), shell: runtime.shell() };
    return { rpc, sync: "none", close: async () => runtime.close() };
  }
}

interface ExecLog {
  events: ExecEvent[];
  done: boolean;
  listeners: Set<() => void>;
  pgid?: number;
  timer?: ReturnType<typeof setTimeout>;
}

class KitebuildRuntime {
  readonly #machine: Machine;
  readonly #mounts: WorkspaceMount[];
  readonly #host: WorkspaceBackendHost;
  readonly #env: Record<string, string>;
  readonly #maxExecs: number;
  readonly #execs = new Map<string, ExecLog>();
  readonly #journal: ExecJournal;
  #running = 0;
  #rev: number;

  constructor(backendId: string, host: WorkspaceBackendHost, options: KitebuildBackendOptions) {
    this.#host = host;
    this.#journal = new ExecJournal(host.db, backendId);
    this.#env = { ...DEFAULT_ENV, ...options.env };
    this.#maxExecs = options.maxExecs ?? 4;
    const gitOption = options.git ?? "kitebuild";
    // The applet's toolset comes first, so a caller's toolset still replaces it.
    const tools = [
      ...(gitOption === "workspace"
        ? []
        : [
            // Pushing is allowed, as with the Workspace's git client; credentials
            // come from the environment or from the caller's fetch.
            kitebuildGit({
              push: true,
              fetch: gitFetch(
                options.egress ?? { mode: "none" },
                gitOption === "kitebuild" ? undefined : gitOption.fetch,
              ),
            }),
          ]),
      ...(options.tools ?? []),
    ];
    this.#machine = new Machine({
      programs: new ProgramRegistry({
        defaultProgram: { module: BUSYBOX, abi: "linux" },
        // Built-in commands first, so a toolset can replace them.
        programs: [
          ...workspacePrograms({
            host,
            git: gitOption === "workspace",
            flush: () => {
              for (const mount of this.#mounts) mount.flush();
            },
            refreshAfter: (since) => this.#refresh(since),
          }),
          ...tools.flatMap((tool) => tool.programs),
        ],
      }),
      initramfs: INITRAMFS,
      egress: egressPolicy(options.egress ?? { mode: "none" }),
      extras: Object.assign({}, ...tools.map((tool) => tool.extras ?? {})),
      wsSend() {},
      log() {},
    });
    this.#machine.setupFs();
    const provider = new SQLiteWorkspaceProvider(host.db);
    this.#mounts = (options.paths ?? ["/workspace"]).map((path) => {
      provider.mkdirSync(path, { recursive: true });
      return mountWorkspace(this.#machine.vfs, path, provider, { cacheBytes: options.cacheBytes });
    });
    this.#rev = currentRev(host.db);
  }

  shell(): ShellRPC {
    return {
      exec: (input) => this.#exec(input),
      getExec: async ({ id, after }) => ({ id, events: this.#stream(this.#log(id), after) }),
      killExec: async ({ id, signal }) => {
        const log = this.#log(id);
        if (!log.done && log.pgid !== undefined)
          this.#machine.killGroup(log.pgid, SIGNALS[signal ?? "SIGTERM"]);
      },
      disposeExec: async ({ id }) => {
        const log = this.#execs.get(id);
        if (log?.done === false) return;
        this.#execs.delete(id);
        this.#journal.dispose(id);
      },
    };
  }

  close(): void {
    for (const log of this.#execs.values()) {
      if (!log.done && log.pgid !== undefined) this.#machine.killGroup(log.pgid, SIGNALS.SIGKILL);
    }
    for (const mount of this.#mounts) mount.flush();
  }

  async #exec(
    input: Parameters<ShellRPC["exec"]>[0],
  ): Promise<{ id: string; events: ReadableStream<ExecEvent> }> {
    // Pick up Workspace writes made outside the machine since the last
    // look. The tree keeps its nodes, so running commands are unaffected.
    const rev = currentRev(this.#host.db);
    if (rev !== this.#rev) {
      const since = this.#rev;
      this.#rev = rev;
      await this.#refresh(since);
    }

    const id = input.id ?? crypto.randomUUID();
    if (this.#execs.get(id)?.done === false)
      throw shellError("EEXEC_BUSY", `exec ${id} is already running`);
    if (this.#running >= this.#maxExecs) {
      throw shellError("EEXEC_BUSY", `${this.#running} commands are already running`);
    }

    const log: ExecLog = { events: [], done: false, listeners: new Set() };
    this.#execs.set(id, log);
    this.#retain();
    this.#journal.start(id);
    let seq = 0;
    const emit = (event: ExecEvent): void => {
      log.events.push(event);
      this.#journal.append(event);
      for (const listener of log.listeners) listener();
    };
    const output = (name: "stdout" | "stderr") =>
      outputNode((bytes) => emit({ id, seq: ++seq, name, value: bytes }));

    const env = { ...this.#env, ...input.env };
    const proc = this.#machine.spawn({
      argv: ["sh", "-c", input.source],
      envp: Object.entries(env).map(([name, value]) => `${name}=${value}`),
      fdEntries: new Map([
        [0, { node: inputNode(input.stdin), flags: 0, offset: 0 }],
        [1, { node: output("stdout"), flags: 1, offset: 0 }],
        [2, { node: output("stderr"), flags: 1, offset: 0 }],
      ]),
      cwd: input.cwd ?? "/",
      parentPid: 0,
    });
    log.pgid = proc.pgid;
    this.#running++;

    if (input.timeoutMs !== undefined && input.timeoutMs > 0) {
      log.timer = setTimeout(() => {
        this.#machine.killGroup(proc.pgid, SIGNALS.SIGTERM);
        log.timer = setTimeout(
          () => this.#machine.killGroup(proc.pgid, SIGNALS.SIGKILL),
          KILL_GRACE_MS,
        );
      }, input.timeoutMs);
    }

    void proc.exitedPromise.then((code) => {
      clearTimeout(log.timer);
      this.#running--;
      let exitCode = code;
      try {
        for (const mount of this.#mounts) mount.flush();
      } catch (error) {
        const message = new TextEncoder().encode(
          `kitebuild: saving files failed: ${String(error)}\n`,
        );
        emit({ id, seq: ++seq, name: "stderr", value: message });
        if (exitCode === 0) exitCode = 1;
      }
      if (this.#running === 0) this.#rev = currentRev(this.#host.db);
      log.done = true;
      emit({ id, seq: ++seq, name: "exit", code: exitCode });
      this.#journal.finish(id, exitCode);
    });

    return { id, events: this.#stream(log, undefined) };
  }

  // Apply every Workspace path changed after `since` to the mounts.
  async #refresh(since: number): Promise<void> {
    const changed: string[] = [];
    for await (const entry of coalesceChanges(this.#host.db, since)) changed.push(entry.path);
    for (const mount of this.#mounts) mount.refresh(changed);
  }

  // An execution from memory, or replayed from the journal after the
  // Durable Object restarted.
  #log(id: string): ExecLog {
    const log = this.#execs.get(id);
    if (log !== undefined) return log;
    const events = this.#journal.load(id);
    if (events === undefined) throw shellError("ENOENT", `no such exec: ${id}`);
    return { events, done: true, listeners: new Set() };
  }

  #stream(log: ExecLog, after: number | "tail" | undefined): ReadableStream<ExecEvent> {
    let next =
      after === "tail"
        ? log.events.length
        : after === undefined
          ? 0
          : log.events.findIndex((e) => e.seq > after);
    if (next < 0) next = log.events.length;
    let wake: (() => void) | undefined;
    return new ReadableStream<ExecEvent>({
      pull: async (controller) => {
        while (next >= log.events.length) {
          if (log.done) {
            controller.close();
            return;
          }
          await new Promise<void>((resolve) => {
            wake = resolve;
            log.listeners.add(resolve);
          });
          if (wake) log.listeners.delete(wake);
        }
        const event = log.events[next++];
        controller.enqueue(event);
        if (event.name === "exit") controller.close();
      },
      cancel: () => {
        if (wake) log.listeners.delete(wake);
      },
    });
  }

  #retain(): void {
    const finished = [...this.#execs].filter(([, log]) => log.done);
    for (const [id] of finished.slice(0, Math.max(0, finished.length - RETAINED_EXECS)))
      this.#execs.delete(id);
    this.#journal.prune();
  }
}

// A write-only character device that hands every write to `sink`.
function outputNode(sink: (bytes: Uint8Array) => void): FsNode {
  return {
    type: "char",
    mode: CHAR_DEVICE | 0o666,
    uid: 0,
    gid: 0,
    mtime: 0,
    ino: 0,
    special: {
      write: (memory, buf, count) => {
        if (count > 0) sink(memory.slice(buf, buf + count));
        return count;
      },
      read: () => 0,
      poll: () => 4,
    },
  };
}

// A read-only character device serving `bytes`, then end of file.
function inputNode(bytes: Uint8Array | undefined): FsNode {
  let offset = 0;
  return {
    type: "char",
    mode: CHAR_DEVICE | 0o444,
    uid: 0,
    gid: 0,
    mtime: 0,
    ino: 0,
    special: {
      read: (memory, buf, count) => {
        if (bytes === undefined || offset >= bytes.byteLength) return 0;
        const n = Math.min(count, bytes.byteLength - offset);
        memory.set(bytes.subarray(offset, offset + n), buf);
        offset += n;
        return n;
      },
      write: () => -9,
      poll: () => 1,
    },
  };
}

// Kitebuild git's HTTP under the shell's egress policy, with the caller's
// step, when there is one, in front.
function gitFetch(
  policy: WorkspaceEgressPolicy,
  caller: KitebuildGitFetch | undefined,
): (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> {
  const egressFetch =
    hostEgressFetch(policy).fetch ??
    ((request: Request) =>
      Promise.reject(
        new Error(`network access is off for this shell (egress "none"); refused ${request.url}`),
      ));
  return (input, init) => {
    const request = new Request(input, init);
    return caller === undefined ? egressFetch(request) : caller(request, egressFetch);
  };
}

function egressPolicy(policy: WorkspaceEgressPolicy): EgressPolicy | undefined {
  switch (policy.mode) {
    case "none":
      return () => "deny";
    case "direct":
      return undefined;
    case "http-gateway": {
      // Every connection goes to the gateway as HTTP, by the Host the
      // guest sent, so names only have to resolve to something. Answer
      // every lookup locally instead of sending DNS through the gateway.
      const gateway = policy.gateway as unknown as LocalFetcher;
      return (target) => (target.kind === "dns" ? LOCAL_RESOLVER : gateway);
    }
  }
}

// Gateway-mode DNS: answers each A query with one unroutable address
// and every other query with no records.
const GATEWAY_ADDRESS = [192, 0, 2, 1];
const LOCAL_RESOLVER: LocalFetcher = {
  async fetch(_input: RequestInfo | URL, init?: RequestInit) {
    const query = new Uint8Array(await new Response(init?.body).arrayBuffer());
    return new Response(dnsAnswer(query), {
      headers: { "content-type": "application/dns-message" },
    });
  },
};

function dnsAnswer(query: Uint8Array): Uint8Array<ArrayBuffer> {
  let end = 12;
  while (end < query.length && query[end] !== 0) end += query[end] + 1;
  end += 5;
  if (end > query.length) return new Uint8Array(0);
  const isA = query[end - 4] === 0 && query[end - 3] === 1;
  const record = isA ? [0xc0, 0x0c, 0, 1, 0, 1, 0, 0, 0, 60, 0, 4, ...GATEWAY_ADDRESS] : [];
  const response = new Uint8Array(end + record.length);
  response.set(query.subarray(0, end));
  response[2] |= 0x80;
  response[3] = 0x80;
  response[5] = 1;
  response.fill(0, 6, 12);
  response[7] = isA ? 1 : 0;
  response.set(record, end);
  return response;
}

function shellError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

function refuseSync(): SyncRPC {
  const refuse = (name: string): never => {
    throw new Error(
      `KitebuildBackend: sync.${name} must not be called; the handle declares sync: "none"`,
    );
  };
  return {
    push: () => refuse("push"),
    fetchChanges: () => refuse("fetchChanges"),
    readEntry: () => refuse("readEntry"),
    hasObjects: () => refuse("hasObjects"),
    fetchObjects: () => refuse("fetchObjects"),
    pushObjects: () => refuse("pushObjects"),
    watermarks: () => refuse("watermarks"),
  };
}

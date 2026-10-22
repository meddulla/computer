// KitebuildBackend: shell commands on a Kitebuild machine, the BusyBox
// userland busyworker runs inside a Worker by emulating the Linux
// syscall ABI.
//
// The machine lives in the Durable Object that owns the Workspace and
// mounts the Workspace store directly (./workspace-mount.ts), so the
// handle declares sync: "none". Commands are real processes: pipes,
// background jobs and signals work, and output streams as it is
// written. The Worker shell's `assets` and `artifacts` commands are
// built in (./workspace-commands.ts); other programs beyond BusyBox
// come from toolsets the caller installs and passes in, such as
// @cloudflare/kitebuild-git-applet.

import type { ExecEvent, ShellRPC, SyncRPC, WorkspaceRPC } from "@cloudflare/computer-rpc";
import { currentRev, SQLiteWorkspaceProvider } from "@cloudflare/dofs";
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

import type { BackendHandle, WorkspaceBackend, WorkspaceBackendHost } from "../../backend";
import type { WorkspaceEgressPolicy } from "../../runtime/egress";
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
}

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
    this.description = `A BusyBox Linux userland in the Workspace's Durable Object, with real processes, pipes, background jobs and signals, and output that streams as it is written. Workspace files are shared directly with the file tools. Has sh, awk, sed, grep, find, xargs, tar, gzip, xz, diff, patch, vi, wget and the rest of BusyBox, and the assets and artifacts commands${more}`;
  }

  async connect(host: WorkspaceBackendHost): Promise<BackendHandle> {
    const runtime = new KitebuildRuntime(host, this.#options);
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
  #running = 0;
  #rev: number;
  // Set when the store changed under a running command and the mounts
  // could not reload then; the next command reloads them.
  #stale = false;

  constructor(host: WorkspaceBackendHost, options: KitebuildBackendOptions) {
    this.#host = host;
    this.#env = { ...DEFAULT_ENV, ...options.env };
    this.#maxExecs = options.maxExecs ?? 4;
    const tools = options.tools ?? [];
    this.#machine = new Machine({
      programs: new ProgramRegistry({
        defaultProgram: { module: BUSYBOX, abi: "linux" },
        // Built-in commands first, so a toolset can replace them.
        programs: [
          ...workspacePrograms({
            host,
            flush: () => {
              for (const mount of this.#mounts) mount.flush();
            },
            reload: () => this.#reload(),
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
      exec: async (input) => this.#exec(input),
      getExec: async ({ id, after }) => ({ id, events: this.#stream(this.#log(id), after) }),
      killExec: async ({ id, signal }) => {
        const log = this.#log(id);
        if (!log.done && log.pgid !== undefined)
          this.#machine.killGroup(log.pgid, SIGNALS[signal ?? "SIGTERM"]);
      },
      disposeExec: async ({ id }) => {
        const log = this.#execs.get(id);
        if (log?.done) this.#execs.delete(id);
      },
    };
  }

  close(): void {
    for (const log of this.#execs.values()) {
      if (!log.done && log.pgid !== undefined) this.#machine.killGroup(log.pgid, SIGNALS.SIGKILL);
    }
    for (const mount of this.#mounts) mount.flush();
  }

  #exec(input: Parameters<ShellRPC["exec"]>[0]): { id: string; events: ReadableStream<ExecEvent> } {
    const id = input.id ?? crypto.randomUUID();
    if (this.#execs.get(id)?.done === false)
      throw shellError("EEXEC_BUSY", `exec ${id} is already running`);
    if (this.#running >= this.#maxExecs) {
      throw shellError("EEXEC_BUSY", `${this.#running} commands are already running`);
    }

    // Pick up Workspace writes made outside the machine since the last
    // command. Only between commands, so a running one keeps its tree.
    if (this.#running === 0 && (this.#stale || currentRev(this.#host.db) !== this.#rev)) {
      for (const mount of this.#mounts) mount.reset();
      this.#stale = false;
    }

    const log: ExecLog = { events: [], done: false, listeners: new Set() };
    this.#execs.set(id, log);
    this.#retain();
    let seq = 0;
    const emit = (event: ExecEvent): void => {
      log.events.push(event);
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
    });

    return { id, events: this.#stream(log, undefined) };
  }

  // Reload the mounts for a program that wrote the store through the
  // host, if its own command is the only one running.
  #reload(): void {
    if (this.#running === 1) {
      for (const mount of this.#mounts) mount.reset();
    } else {
      this.#stale = true;
    }
  }

  #log(id: string): ExecLog {
    const log = this.#execs.get(id);
    if (log === undefined) throw shellError("ENOENT", `no such exec: ${id}`);
    return log;
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

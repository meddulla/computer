// Workerd harness for the KitebuildBackend integration tests.
//
// HostDO owns one Workspace with two Kitebuild backends: the default,
// with no network and a small JS applet toolset, and "gateway", whose
// egress goes through the Gateway entrypoint below. The test calls
// HostDO's methods directly through its stub.

import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import { writeFdBytes } from "@cloudflare/kitebuild-core";
import type { JsProgramCtx, Toolset } from "@cloudflare/kitebuild-core";

import { KitebuildBackend } from "../src/backends/kitebuild/index";
import { Workspace } from "../src/index";

export interface Env {
  HOST: DurableObjectNamespace<HostDO>;
}

export interface ExecOptions {
  backend?: string;
  cwd?: string;
  env?: Record<string, string>;
  stdin?: string;
  timeoutMs?: number;
  id?: string;
}

export interface ExecResult {
  status: string;
  exitCode: number;
  stdout: string;
  stderr: string;
}

// A toolset with one JS applet that prints an extra the toolset
// supplies, to show toolsets reach the machine.
const greeter: Toolset = {
  programs: [
    {
      path: "/usr/bin/greet",
      abi: "js",
      main: (ctx: JsProgramCtx) => {
        const bytes = new TextEncoder().encode(
          `${String(ctx.machine.extras.GREETING)} ${ctx.argv[1] ?? ""}\n`,
        );
        writeFdBytes(ctx.proc.fdt, 1, bytes, 0, bytes.length);
        return 0;
      },
    },
  ],
  extras: { GREETING: "hello" },
};

export class Gateway extends WorkerEntrypoint {
  override async fetch(request: Request): Promise<Response> {
    return new Response(`gateway saw ${request.method} ${request.url}\n`);
  }
}

export class HostDO extends DurableObject<Env> {
  readonly #workspace: Workspace;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.#workspace = new Workspace({
      storage: ctx.storage,
      backends: [
        new KitebuildBackend({ tools: [greeter], env: { CI: "1" } }),
        new KitebuildBackend({
          id: "gateway",
          egress: { mode: "http-gateway", gateway: ctx.exports.Gateway({}) },
        }),
      ],
    });
  }

  async writeFile(path: string, body: string): Promise<void> {
    await this.#workspace.fs.mkdir(path.slice(0, path.lastIndexOf("/")) || "/", {
      recursive: true,
    });
    await this.#workspace.fs.writeFile(path, body);
  }

  async readFile(path: string): Promise<string | null> {
    try {
      return await this.#workspace.fs.readFile(path, "utf8");
    } catch {
      return null;
    }
  }

  async mode(path: string): Promise<number> {
    return (await this.#workspace.fs.stat(path)).mode & 0o7777;
  }

  async exec(command: string, options: ExecOptions = {}): Promise<ExecResult> {
    using handle = await this.#workspace.runtime.exec(command, { ...options, encoding: "utf8" });
    const result = await handle.result();
    return {
      status: result.status,
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  }

  // Events as they arrive, each with the time since the exec began.
  async events(command: string): Promise<Array<{ name: string; text: string; ms: number }>> {
    const started = Date.now();
    using handle = await this.#workspace.runtime.exec(command, { encoding: "utf8" });
    const events: Array<{ name: string; text: string; ms: number }> = [];
    for await (const event of handle) {
      events.push({
        name: event.name,
        text: event.name === "exit" ? String(event.code) : event.value,
        ms: Date.now() - started,
      });
    }
    return events;
  }

  async killAfter(
    command: string,
    ms: number,
    signal: "SIGTERM" | "SIGKILL",
  ): Promise<ExecResult & { ms: number }> {
    const started = Date.now();
    using handle = await this.#workspace.runtime.exec(command, { encoding: "utf8" });
    await new Promise((resolve) => setTimeout(resolve, ms));
    await handle.kill(signal);
    const result = await handle.result();
    return {
      status: result.status,
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      ms: Date.now() - started,
    };
  }

  async replay(id: string): Promise<string> {
    using handle = await this.#workspace.runtime.getExec(id, { resume: "full", encoding: "utf8" });
    return (await handle.result()).stdout;
  }
}

export default {
  fetch: () => new Response("kitebuild backend tests"),
};

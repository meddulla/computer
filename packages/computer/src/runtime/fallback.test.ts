import { describe, expect, it, vi } from "vitest";

import type { WorkspaceBackend } from "../backend";
import { isCapabilityError } from "./fallback";
import { WorkspaceRuntime } from "./runtime";
import type {
  ModuleExecutionEnvelope,
  WorkspaceModuleBackend,
  WorkspaceModuleBackendHandle,
  WorkspaceRegisteredBackend,
  WorkspaceRuntimeEvent,
} from "./types";

const encoder = new TextEncoder();

function out(seq: number, text: string): WorkspaceRuntimeEvent {
  return { id: "e", seq, name: "stdout", value: encoder.encode(text) };
}
function err(seq: number, text: string): WorkspaceRuntimeEvent {
  return { id: "e", seq, name: "stderr", value: encoder.encode(text) };
}
function exit(seq: number, code: number): WorkspaceRuntimeEvent {
  return { id: "e", seq, name: "exit", code };
}

function stream(events: WorkspaceRuntimeEvent[]): ReadableStream<WorkspaceRuntimeEvent> {
  return new ReadableStream({
    start(controller) {
      for (const event of events) controller.enqueue(event);
      controller.close();
    },
  });
}

// A backend whose exec replays fixed events, with an optional sync bracket.
function handle(
  events: WorkspaceRuntimeEvent[],
  sync?: ModuleExecutionEnvelope["sync"],
): WorkspaceModuleBackendHandle {
  return {
    exec: vi.fn<WorkspaceModuleBackendHandle["exec"]>(async (input) => ({
      id: input.id ?? "exec",
      events: stream(events),
      ...(sync === undefined ? {} : { sync }),
    })),
    getExec: vi.fn<WorkspaceModuleBackendHandle["getExec"]>(async (input) => ({
      id: input.id,
      events: stream(events),
    })),
    killExec: vi.fn<WorkspaceModuleBackendHandle["killExec"]>(async () => {}),
    disposeExec: vi.fn<WorkspaceModuleBackendHandle["disposeExec"]>(async () => {}),
  };
}

function commandBackend(id: string): WorkspaceBackend {
  return { id, type: "test", connect: async () => ({}) } as unknown as WorkspaceBackend;
}

function runtimeWith(
  handles: Record<string, WorkspaceModuleBackendHandle>,
  registered: WorkspaceRegisteredBackend[] = [commandBackend("shell"), commandBackend("container")],
  fallback: { backend: string } | null = { backend: "container" },
): WorkspaceRuntime {
  return new WorkspaceRuntime({
    backends: new Map(registered.map((backend) => [backend.id, backend])),
    backendHandle: async (id) => {
      const found = handles[id];
      if (found === undefined) throw new Error(`no backend ${id}`);
      return found;
    },
    resolveBackendId: (id) => id ?? registered[0]?.id ?? "",
    ...(fallback === null ? {} : { fallback }),
  });
}

describe("isCapabilityError", () => {
  it("is a missing program or a Kitebuild unsupported feature", () => {
    expect(isCapabilityError({ backend: "shell", exitCode: 127, stderr: "sh: uname: not found\n" })).toBe(true);
    expect(isCapabilityError({ backend: "shell", exitCode: 127, stderr: "bash: apt: command not found\n" })).toBe(true);
    expect(
      isCapabilityError({
        backend: "shell",
        exitCode: 127,
        stderr: "sh: can't execute 'python3': No such file or directory\n",
      }),
    ).toBe(true);
    expect(
      isCapabilityError({
        backend: "shell",
        exitCode: 3,
        stderr: "kitebuild: unsupported: config-key build.lib: library mode\n",
      }),
    ).toBe(true);
  });

  it("is not an ordinary failure", () => {
    expect(isCapabilityError({ backend: "shell", exitCode: 1, stderr: "error TS2322\n" })).toBe(false);
    expect(isCapabilityError({ backend: "shell", exitCode: 127, stderr: "exit 127 by hand\n" })).toBe(false);
    expect(isCapabilityError({ backend: "shell", exitCode: 3, stderr: "three\n" })).toBe(false);
  });
});

describe("WorkspaceRuntime fallback", () => {
  it("runs a command that is not found again on the fallback backend", async () => {
    const shell = handle([out(1, "before\n"), err(2, "sh: uname: not found\n"), exit(3, 127)]);
    const container = handle([out(1, "Linux\n"), exit(2, 0)]);
    const runtime = runtimeWith({ shell, container });

    const run = await runtime.exec("echo before; uname", { encoding: "utf8", cwd: "/workspace", env: { A: "1" } });
    const result = await run.result();

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("before\nLinux\n");
    expect(result.stderr).toContain("sh: uname: not found");
    expect(result.stderr).toContain('computer: "shell" cannot run this command; running it on "container"');
    expect(container.exec).toHaveBeenCalledWith(
      expect.objectContaining({ source: "echo before; uname", cwd: "/workspace", env: { A: "1" }, id: "exec" }),
    );
  });

  it("runs a Kitebuild unsupported feature on the fallback backend", async () => {
    const shell = handle([err(1, "kitebuild: unsupported: config-key build.lib: library mode\n"), exit(2, 3)]);
    const container = handle([out(1, "built\n"), exit(2, 0)]);
    const result = await (await runtimeWith({ shell, container }).exec("vite build", { encoding: "utf8" })).result();
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("built\n");
  });

  it("keeps an ordinary failure", async () => {
    const shell = handle([err(1, "a.ts(1,7): error TS2322\n"), exit(2, 1)]);
    const container = handle([exit(1, 0)]);
    const result = await (await runtimeWith({ shell, container }).exec("tsc", { encoding: "utf8" })).result();
    expect(result.exitCode).toBe(1);
    expect(container.exec).not.toHaveBeenCalled();
  });

  it("keeps the first exit when the fallback cannot start", async () => {
    const shell = handle([err(1, "sh: python3: not found\n"), exit(2, 127)]);
    const container = handle([]);
    vi.mocked(container.exec).mockRejectedValue(new Error("containers are disabled"));
    const result = await (await runtimeWith({ shell, container }).exec("python3", { encoding: "utf8" })).result();
    expect(result.exitCode).toBe(127);
    expect(result.stderr).toContain('fallback backend "container" is unavailable: containers are disabled');
  });

  it("does not fall back from the fallback backend itself", async () => {
    const shell = handle([]);
    const container = handle([err(1, "sh: nope: not found\n"), exit(2, 127)]);
    const result = await (
      await runtimeWith({ shell, container }).exec("nope", { backend: "container", encoding: "utf8" })
    ).result();
    expect(result.exitCode).toBe(127);
    expect(shell.exec).not.toHaveBeenCalled();
  });

  it("does not fall back without the option", async () => {
    const shell = handle([err(1, "sh: uname: not found\n"), exit(2, 127)]);
    const container = handle([exit(1, 0)]);
    const runtime = runtimeWith({ shell, container }, undefined, null);
    const result = await (await runtime.exec("uname", { encoding: "utf8" })).result();
    expect(result.exitCode).toBe(127);
    expect(container.exec).not.toHaveBeenCalled();
  });

  it("does not fall back from a module backend", async () => {
    const js = handle([err(1, "x: not found\n"), exit(2, 127)]);
    const container = handle([exit(1, 0)]);
    const moduleBackend = { id: "js", protocol: "module" } as unknown as WorkspaceModuleBackend;
    const runtime = runtimeWith({ js, container }, [moduleBackend, commandBackend("container")]);
    const result = await (await runtime.exec("export default 1", { encoding: "utf8" })).result();
    expect(result.exitCode).toBe(127);
    expect(container.exec).not.toHaveBeenCalled();
  });

  it("waits for the fallback's sync before the result", async () => {
    let pulled!: (value: { applied: number; skipped: []; sync: { status: "complete"; applied: number; skipped: [] } }) => void;
    const outcome = new Promise<Parameters<typeof pulled>[0]>((resolve) => (pulled = resolve));
    const shell = handle([err(1, "sh: make: not found\n"), exit(2, 127)]);
    const container = handle([exit(1, 0)], { pushed: 4, outcome });
    const run = await runtimeWith({ shell, container }).exec("make", { encoding: "utf8" });
    const result = run.result();
    let settled = false;
    void result.then(() => (settled = true));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(settled).toBe(false);
    pulled({ applied: 2, skipped: [], sync: { status: "complete", applied: 2, skipped: [] } });
    expect(await result).toMatchObject({ exitCode: 0, pushed: 4, pulled: 2 });
  });

  it("kills the fallback run once the command has moved there", async () => {
    const shell = handle([err(1, "sh: sleep2: not found\n"), exit(2, 127)]);
    let finish!: () => void;
    const container: WorkspaceModuleBackendHandle = {
      ...handle([]),
      exec: vi.fn<WorkspaceModuleBackendHandle["exec"]>(async (input) => ({
        id: input.id ?? "exec",
        events: new ReadableStream<WorkspaceRuntimeEvent>({
          start(controller) {
            controller.enqueue(out(1, "started\n"));
            finish = () => {
              controller.enqueue(exit(2, 137));
              controller.close();
            };
          },
        }),
      })),
    };
    const run = await runtimeWith({ shell, container }).exec("sleep2", { encoding: "utf8" });
    const reader = run.getReader();
    for (;;) {
      const next = await reader.read();
      if (next.done || (next.value.name === "stdout" && next.value.value === "started\n")) break;
    }
    await run.kill("SIGKILL");
    expect(container.killExec).toHaveBeenCalledWith(expect.objectContaining({ id: "exec", signal: "SIGKILL" }));
    expect(shell.killExec).not.toHaveBeenCalled();
    finish();
  });
});

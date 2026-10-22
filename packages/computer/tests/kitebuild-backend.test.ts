// Integration tests for KitebuildBackend in workerd: a real Kitebuild
// machine running BusyBox in the host Durable Object, with the
// Workspace store mounted at /workspace.

import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import type { Env } from "./kitebuild-backend-worker";

declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}

let counter = 0;
const host = () => env.HOST.get(env.HOST.idFromName(`case-${++counter}`));

describe("KitebuildBackend", () => {
  it("runs a pipeline in a BusyBox shell", async () => {
    const result = await host().exec(
      "printf 'b\\na\\nb\\n' | sort | uniq -c | sed 's/^ *//'; uname -m",
    );
    expect(result).toMatchObject({
      status: "completed",
      exitCode: 0,
      stdout: "1 a\n2 b\nwasm32\n",
    });
  });

  it("reports exit codes and separates stderr", async () => {
    const result = await host().exec("echo out; echo err >&2; exit 3");
    expect(result).toMatchObject({ exitCode: 3, stdout: "out\n", stderr: "err\n" });
  });

  it("passes cwd, env and stdin", async () => {
    const result = await host().exec('pwd; echo "$CI $GREETING_TARGET"; tr a-z A-Z', {
      cwd: "/workspace",
      env: { GREETING_TARGET: "world" },
      stdin: "from stdin\n",
    });
    expect(result.stdout).toBe("/workspace\n1 world\nFROM STDIN\n");
  });

  it("shares files with the Workspace in both directions", async () => {
    const stub = host();
    await stub.writeFile("/workspace/in.txt", "from the agent\n");
    const result = await stub.exec(
      "cat in.txt; mkdir -p out/deep && echo from the shell > out/deep/f.txt && mv out/deep/f.txt out/g.txt && chmod 755 out/g.txt",
      { cwd: "/workspace" },
    );
    expect(result.stdout).toBe("from the agent\n");
    expect(await stub.readFile("/workspace/out/g.txt")).toBe("from the shell\n");
    expect(await stub.readFile("/workspace/out/deep/f.txt")).toBeNull();
    expect(await stub.mode("/workspace/out/g.txt")).toBe(0o755);
  });

  it("sees Workspace writes made between commands", async () => {
    const stub = host();
    await stub.writeFile("/workspace/a.txt", "one");
    expect((await stub.exec("cat /workspace/a.txt")).stdout).toBe("one");
    await stub.writeFile("/workspace/a.txt", "two, longer");
    await stub.writeFile("/workspace/b.txt", "new");
    expect((await stub.exec("cat /workspace/a.txt; echo; ls /workspace")).stdout).toBe(
      "two, longer\na.txt\nb.txt\n",
    );
  });

  it("extracts and checks an archive round trip", async () => {
    const stub = host();
    const result = await stub.exec(
      "mkdir -p src && for i in $(seq 1 50); do echo file $i > src/f$i.txt; done && " +
        "tar czf src.tgz src && rm -rf src && tar xzf src.tgz && cat src/f*.txt | wc -l && md5sum src/f7.txt",
      { cwd: "/workspace" },
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/^50\n[0-9a-f]{32} {2}src\/f7.txt\n$/);
    expect(await stub.readFile("/workspace/src/f50.txt")).toBe("file 50\n");
  });

  it("streams output while the command runs", async () => {
    const events = await host().events("echo first; sleep 1; echo second");
    expect(events.map((event) => [event.name, event.text])).toEqual([
      ["stdout", "first\n"],
      ["stdout", "second\n"],
      ["exit", "0"],
    ]);
    expect(events[1].ms - events[0].ms).toBeGreaterThanOrEqual(900);
  });

  it("stops a command on kill", async () => {
    const result = await host().killAfter("echo started; sleep 30; echo never", 300, "SIGKILL");
    expect(result.stdout).toBe("started\n");
    expect(result.exitCode).not.toBe(0);
    expect(result.ms).toBeLessThan(10_000);
  });

  it("stops a command at its timeout", async () => {
    const result = await host().exec("sleep 30", { timeoutMs: 200 });
    expect(result.exitCode).not.toBe(0);
  });

  it("replays a finished execution by id", async () => {
    const stub = host();
    await stub.exec("echo kept", { id: "run-1" });
    expect(await stub.replay("run-1")).toBe("kept\n");
  });

  it("runs programs from a toolset with its extras", async () => {
    expect((await host().exec("greet world")).stdout).toBe("hello world\n");
  });

  it("has no network by default", async () => {
    const result = await host().exec(
      "wget -q -O - http://192.0.2.1/ 2>&1; wget -q -O - http://example.com/ 2>&1",
    );
    expect(result.stdout).toContain("Permission denied");
    expect(result.stdout).toContain("bad address 'example.com'");
  });

  it("sends traffic through an http-gateway by host name", async () => {
    const result = await host().exec(
      "wget -q -O - http://example.com/plain; wget -q -O - https://example.com/secure",
      { backend: "gateway" },
    );
    expect(result.stdout).toBe(
      "gateway saw GET http://example.com/plain\ngateway saw GET https://example.com/secure\n",
    );
  });
});

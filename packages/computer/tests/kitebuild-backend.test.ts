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
    expect((await stub.replay("run-1")).stdout).toBe("kept\n");
  });

  it("replays a finished execution after the Durable Object restarts", async () => {
    const stub = host();
    await stub.exec("echo kept; echo warned >&2; exit 3", { id: "run-2" });
    await stub.restart();
    expect(await stub.replay("run-2")).toMatchObject({
      exitCode: 3,
      stdout: "kept\n",
      stderr: "warned\n",
    });
  });

  it("settles a command the restart interrupted as failed", async () => {
    const stub = host();
    await stub.start("echo started; sleep 30", "run-3");
    await stub.restart();
    expect(await stub.replay("run-3")).toMatchObject({
      exitCode: 1,
      stdout: "started\n",
      stderr: "kitebuild: the command stopped when its Durable Object restarted\n",
    });
  });

  it("forgets a disposed execution, including after a restart", async () => {
    const stub = host();
    await stub.exec("echo gone", { id: "run-4" });
    await stub.dispose("run-4");
    await stub.restart();
    expect(await stub.replayError("run-4")).toBe("ENOENT");
  });

  describe("git", () => {
    const identity = {
      GIT_AUTHOR_NAME: "Ada",
      GIT_AUTHOR_EMAIL: "ada@example.com",
      GIT_COMMITTER_NAME: "Ada",
      GIT_COMMITTER_EMAIL: "ada@example.com",
    };

    it("runs Kitebuild's git by default", async () => {
      const stub = host();
      const result = await stub.exec(
        "mkdir repo && cd repo && git init -q && echo hi > a.txt && git add a.txt && " +
          "git commit -q -m first >/dev/null && git log --oneline | wc -l && git rev-parse --abbrev-ref HEAD",
        { cwd: "/workspace", env: identity },
      );
      expect(result).toMatchObject({ exitCode: 0, stdout: "1\nmain\n" });
      // The machine's files are the Workspace's, so the agent sees the repo.
      expect(await stub.readFile("/workspace/repo/.git/HEAD")).toBe("ref: refs/heads/main\n");
    });

    it("commits files the same command wrote", async () => {
      const result = await host().exec(
        "git init -q r && cd r && printf 'one\\ntwo\\n' > notes.txt && git add notes.txt && " +
          "git commit -q -m notes >/dev/null && echo three >> notes.txt && git status",
        { cwd: "/workspace", env: identity },
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toMatch(/modified:\s+notes\.txt/);
    });

    it("has no network for git under the default egress", async () => {
      const result = await host().exec("git clone https://github.com/honojs/starter app", {
        cwd: "/workspace",
      });
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("egress policy denied GET https://github.com/honojs/starter");
    });

    it("refuses git's requests under the default egress before the given fetch sees them", async () => {
      const stub = host();
      const result = await stub.exec("git clone https://git.example.test/repo.git", {
        backend: "gitfetch",
        cwd: "/workspace",
      });
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("egress policy denied");
      expect(await stub.gitFetchRequests()).toEqual([]);
    });

    it("puts the given fetch in front of git's requests under direct egress", async () => {
      const stub = host();
      await stub.exec("git clone https://git.example.test/repo.git", {
        backend: "gitdirect",
        cwd: "/workspace",
      });
      expect(await stub.gitFetchRequests()).toEqual([
        "https://git.example.test/repo.git/info/refs?service=git-upload-pack",
      ]);
    });

    it("sends git's requests through an http-gateway, with the given fetch in front", async () => {
      const stub = host();
      await stub.exec("git clone https://git.example.test/repo.git", {
        backend: "gitgateway",
        cwd: "/workspace",
      });
      expect(await stub.gitFetchResponses()).toEqual([
        "gateway saw GET https://git.example.test/repo.git/info/refs?service=git-upload-pack\n",
      ]);
    });

    it("pushes through the gateway", async () => {
      const stub = host();
      await stub.exec(
        "git init -q r && cd r && echo hi > a && git add a && git commit -q -m first >/dev/null && " +
          "git remote add origin https://git.example.test/repo.git && git push -u origin main",
        { backend: "gitgateway", cwd: "/workspace", env: identity },
      );
      expect(await stub.gitFetchResponses()).toEqual([
        "gateway saw GET https://git.example.test/repo.git/info/refs?service=git-receive-pack\n",
      ]);
    });

    it("runs the Workspace's git client when asked", async () => {
      const stub = host();
      const result = await stub.exec(
        "mkdir repo && cd repo && git init >/dev/null && echo hi > a.txt && git add a.txt && " +
          "git commit -m first >/dev/null && git log --oneline | wc -l && test -f .git/HEAD && echo has-head",
        { backend: "wsgit", cwd: "/workspace", env: identity },
      );
      expect(result).toMatchObject({ exitCode: 0, stdout: "1\nhas-head\n" });
    });

    it("reports a Workspace without git", async () => {
      const result = await host().exec("git status", { backend: "nogit", cwd: "/workspace" });
      expect(result).toMatchObject({
        exitCode: 1,
        stderr: "git: Workspace git is not configured.\n",
      });
    });

    it("can be replaced by a toolset", async () => {
      const result = await host().exec("git status", { backend: "gateway" });
      expect(result).toMatchObject({ exitCode: 0, stdout: "replaced /usr/bin/git\n" });
    });
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

  describe("assets", () => {
    it("publishes a file written earlier in the same command", async () => {
      const stub = host();
      // fd 3 stays open, so the file is still in a write buffer.
      const result = await stub.exec(
        "exec 3> out.txt && printf 'fresh bytes' >&3 && assets publish out.txt 5m",
        { cwd: "/workspace" },
      );
      expect(result).toMatchObject({
        exitCode: 0,
        stdout: "https://assets.example/out.txt\n",
        stderr: "",
      });
      expect((await stub.records()).published).toEqual([
        { path: "/workspace/out.txt", expiresAfter: 5 * 60_000, body: "fresh bytes" },
      ]);
    });

    it("reports a Workspace without an assets client", async () => {
      const stub = host();
      await stub.writeFile("/workspace/out.txt", "x");
      const result = await stub.exec("assets publish /workspace/out.txt", { backend: "fakes" });
      expect(result).toMatchObject({
        exitCode: 1,
        stdout: "",
        stderr: "assets: publishing is not configured for this workspace\n",
      });
    });

    it("can be replaced by a toolset", async () => {
      const result = await host().exec("assets publish /workspace/out.txt", { backend: "gateway" });
      expect(result).toMatchObject({ exitCode: 0, stdout: "replaced /usr/bin/assets\n" });
    });

    it("prints usage for bad arguments", async () => {
      const stub = host();
      for (const command of ["assets", "assets publish", "assets nope x", "assets publish x 5y"]) {
        const result = await stub.exec(command);
        expect(result.exitCode, command).toBe(2);
        expect(result.stdout, command).toBe("");
      }
      expect((await stub.exec("assets publish")).stderr).toBe(
        "usage: assets publish <path> [<expiry>]\n",
      );
      expect((await stub.exec("assets publish x 5y")).stderr).toBe('assets: invalid expiry "5y"\n');
      expect((await stub.records()).published).toEqual([]);
    });
  });

  describe("artifacts", () => {
    it("forwards argv and env to the artifacts client", async () => {
      const stub = host();
      const result = await stub.exec("TOKEN=t artifacts repo list --json", {
        backend: "fakes",
        env: { CI: "1" },
      });
      expect(result).toMatchObject({ exitCode: 4, stdout: "", stderr: "artifacts: failed\n" });
      const [call] = (await stub.records()).artifacts;
      expect(call.argv).toEqual(["repo", "list", "--json"]);
      expect(call.env).toMatchObject({ CI: "1", TOKEN: "t", HOME: "/root" });
    });

    it("shows the remote create adds to the rest of the command", async () => {
      const stub = host();
      await stub.writeFile("/workspace/repo/remotes.txt", "none\n");
      const result = await stub.exec(
        "cat remotes.txt && artifacts create demo && cat remotes.txt",
        { backend: "fakes", cwd: "/workspace/repo" },
      );
      expect(result).toMatchObject({
        exitCode: 0,
        stdout: "none\ncreated demo\norigin https://x/repo.git\n",
      });
    });

    it("shows the remote at once while another command is running", async () => {
      const stub = host();
      await stub.writeFile("/workspace/repo/remotes.txt", "none\n");
      const [, during] = await stub.overlapping(
        "sleep 2",
        "cat remotes.txt && artifacts create demo && cat remotes.txt",
        { backend: "fakes", cwd: "/workspace/repo" },
      );
      expect(during.stdout).toBe("none\ncreated demo\norigin https://x/repo.git\n");
    });

    it("keeps a descriptor opened before the change writable", async () => {
      const stub = host();
      await stub.writeFile("/workspace/repo/remotes.txt", "none\n");
      const result = await stub.exec(
        "{ echo before; artifacts create demo; echo after; } > log.txt; cat log.txt",
        { backend: "fakes", cwd: "/workspace/repo" },
      );
      expect(result).toMatchObject({ exitCode: 0, stdout: "before\ncreated demo\nafter\n" });
      expect(await stub.readFile("/workspace/repo/log.txt")).toBe("before\ncreated demo\nafter\n");
    });
  });
});

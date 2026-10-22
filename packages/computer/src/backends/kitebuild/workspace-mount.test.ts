import {
  Database,
  initializeSchema,
  SQLiteWorkspaceProvider,
  WorkspaceFilesystem,
} from "@cloudflare/dofs";
import { SQLiteTestStorage } from "@cloudflare/dofs/testing";
import {
  type ConformanceBackend,
  type ConformanceCase,
  conformanceCases,
} from "@cloudflare/kitebuild-core/conformance";
import { Vfs } from "@cloudflare/kitebuild-core/vfs";
import { describe, expect, it } from "vitest";

import { mountWorkspace } from "./workspace-mount";

const text = (value: string) => new TextEncoder().encode(value);
const str = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

function store() {
  const db = new Database(new SQLiteTestStorage());
  initializeSchema(db, Date.now);
  const provider = new SQLiteWorkspaceProvider(db);
  provider.mkdirSync("/workspace");
  return { db, fs: new WorkspaceFilesystem(db), provider };
}

function mounted(
  provider: SQLiteWorkspaceProvider,
  options?: Parameters<typeof mountWorkspace>[3],
) {
  const vfs = new Vfs();
  const mount = mountWorkspace(vfs, "/workspace", provider, options);
  return { vfs, mount };
}

function node(vfs: Vfs, path: string) {
  const found = vfs.stat(path);
  if (found === null) throw new Error(`nothing at ${path}`);
  return found;
}

function body(vfs: Vfs, path: string) {
  const found = node(vfs, path).body;
  if (found === undefined) throw new Error(`no file at ${path}`);
  return found;
}

function read(vfs: Vfs, path: string): string {
  return str(body(vfs, path).snapshot());
}

describe("Kitebuild storage conformance on the Workspace mount", () => {
  // dofs addresses file bytes by path, so a descriptor held across a
  // rename-over or an unlink loses the file. Expected to fail until
  // dofs keeps unlinked inodes alive while they are open.
  const known = new Set([
    "replaces a file on rename while its old body stays readable",
    "keeps an unlinked file's body usable while it is held",
  ]);
  const backend = (): ConformanceBackend => {
    const { provider } = store();
    return {
      capabilities: { durable: true, hardLinks: true },
      mount() {
        const { vfs, mount } = mounted(provider, { writeBuffers: 4 });
        if (vfs.mkdirp("/workspace/case") !== 0) throw new Error("mkdirp failed");
        return { vfs, root: "/workspace/case", flush: () => mount.flush() };
      },
    };
  };
  const run = async (c: ConformanceCase) => c.run(backend());
  const cases = conformanceCases.filter((c) => !c.requires?.includes("snapshots"));
  it.each(cases.filter((c) => !known.has(c.name)).map((c) => [c.name, c] as const))(
    "%s",
    async (_name, c) => {
      await expect(run(c)).resolves.toBeUndefined();
    },
  );
  it.each(cases.filter((c) => known.has(c.name)).map((c) => [c.name, c] as const))(
    "%s (known to fail: dofs addresses bytes by path)",
    async (_name, c) => {
      await expect(run(c)).rejects.toThrow(/conformance|not mounted|ENOENT/);
    },
  );
});

describe("mountWorkspace", () => {
  it("shows Workspace writes to a mount made after them", async () => {
    const { fs, provider } = store();
    await fs.writeFile("/workspace/a.txt", "from the agent");
    const { vfs } = mounted(provider);
    expect(read(vfs, "/workspace/a.txt")).toBe("from the agent");
  });

  it("commits a new file with its mode at flush and is readable before", async () => {
    const { fs, provider } = store();
    const { vfs, mount } = mounted(provider);
    expect(vfs.writeFile("/workspace/run.sh", new Uint8Array(0), 0o644)).toBe(0);
    body(vfs, "/workspace/run.sh").writeFrom(text("echo hi\n"), 0);
    expect(vfs.updateNode(node(vfs, "/workspace/run.sh"), { mode: 0o755, mtime: 1_000_000 })).toBe(
      0,
    );
    expect(read(vfs, "/workspace/run.sh")).toBe("echo hi\n");
    mount.flush();
    expect(await fs.readFile("/workspace/run.sh", "utf8")).toBe("echo hi\n");
    const stat = await fs.stat("/workspace/run.sh");
    expect(stat.mode & 0o777).toBe(0o755);
    expect(stat.mtime).toBe(1_000_000_000);
  });

  it("holds at most writeBuffers files open", async () => {
    const { fs, provider } = store();
    const { vfs } = mounted(provider, { writeBuffers: 2 });
    for (const name of ["a", "b", "c"]) {
      vfs.writeFile(`/workspace/${name}`, new Uint8Array(0));
      body(vfs, `/workspace/${name}`).writeFrom(text(name), 0);
    }
    // The oldest was released when the third opened.
    expect(await fs.readFile("/workspace/a", "utf8")).toBe("a");
  });

  it("serves repeat reads from the cache until the file changes", async () => {
    const { fs, provider } = store();
    await fs.writeFile("/workspace/f", "cached");
    const { vfs } = mounted(provider);
    let reads = 0;
    const readRange = provider.readRangeSync.bind(provider);
    provider.readRangeSync = (...args) => {
      reads++;
      return readRange(...args);
    };
    for (let i = 0; i < 3; i++) expect(read(vfs, "/workspace/f")).toBe("cached");
    expect(reads).toBe(1);
    body(vfs, "/workspace/f").writeFrom(text("C"), 0);
    expect(read(vfs, "/workspace/f")).toBe("Cached");
  });

  it("sees Workspace changes after reset", async () => {
    const { fs, provider } = store();
    await fs.writeFile("/workspace/seen", "x");
    const { vfs, mount } = mounted(provider);
    expect(vfs.stat("/workspace/seen")).not.toBeNull();
    await fs.writeFile("/workspace/later", "y");
    await fs.writeFile("/workspace/seen", "longer");
    expect(vfs.stat("/workspace/later")).toBeNull();
    mount.reset();
    expect(read(vfs, "/workspace/later")).toBe("y");
    expect(read(vfs, "/workspace/seen")).toBe("longer");
  });

  it("returns Linux errno values", () => {
    const { provider } = store();
    const { vfs } = mounted(provider);
    expect(vfs.mkdirp("/workspace/d/e")).toBe(0);
    expect(vfs.rmdir("/workspace/d")).toBe(-39);
    expect(vfs.mkdir("/workspace/d", 0o755)).toBe(-17);
  });

  it("refuses the root as a mount path", () => {
    const { provider } = store();
    expect(() => mountWorkspace(new Vfs(), "/", provider)).toThrow(/cannot mount/);
  });
});

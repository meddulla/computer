# 20. Kitebuild backend

> [!NOTE]
> **Experimental.** `KitebuildBackend` may change in any release. See the [status table](../packages/computer/README.md#status).

`KitebuildBackend` runs shell commands on a Kitebuild machine: the BusyBox userland that busyworker runs inside a Worker by emulating the Linux syscall ABI. Commands are real processes, so pipes, background jobs and signals work, and output streams while a command runs. The machine lives in the Durable Object that owns the Workspace and reads and writes the Workspace store directly, so there is one copy of every file and nothing to sync.

It sits between the Worker shell, which starts fast but runs a fixed command set in a TypeScript interpreter, and the container backend, which is full Linux but starts a container and syncs a second copy of the files.

## Setup

`@cloudflare/kitebuild-core` is an optional peer dependency. Install it next to `@cloudflare/computer`:

```ts
import { DurableObject } from "cloudflare:workers";
import { Workspace } from "@cloudflare/computer";
import { KitebuildBackend } from "@cloudflare/computer/backends/kitebuild";

export class Agent extends DurableObject<Env> {
  workspace = new Workspace({
    storage: this.ctx.storage,
    backends: [new KitebuildBackend()],
  });
}
```

The Worker needs `nodejs_compat`. Wrangler uploads BusyBox and its initramfs as precompiled wasm modules, about 1.9 MB together.

```ts
using run = await workspace.runtime.exec("tar xzf src.tgz && ls src | wc -l", {
  cwd: "/workspace",
  encoding: "utf8",
});
for await (const event of run) {
  if (event.name === "stdout") console.log(event.value); // as it is written
}
```

## Options

| Option | Default | Meaning |
| --- | --- | --- |
| `id` | `"kitebuild"` | Selector for `runtime.exec({ backend })`. |
| `tools` | `[]` | Toolsets, `{ programs, extras? }`, adding programs beyond BusyBox. |
| `paths` | `["/workspace"]` | Workspace directories mounted at the same path in the machine. Created when missing. |
| `egress` | `{ mode: "none" }` | Outbound network, as for the other backends. |
| `cacheBytes` | 8 MiB | File bytes cached in memory for reads. |
| `env` | `{}` | Environment every command starts with. |
| `maxExecs` | 4 | Commands running at once; more fail with `EEXEC_BUSY`. |

Programs beyond BusyBox come from packages the caller installs and passes in. Each exports a toolset:

```ts
import { git } from "@cloudflare/kitebuild-git-applet";

new KitebuildBackend({ tools: [git()] });
```

## Files

Paths are the same on both sides: the agent's `/workspace/x` is the shell's `/workspace/x`. Outside `paths`, `/bin` and `/etc` come from the initramfs and `/tmp` is in memory.

Writes from the shell land in the Workspace when the command ends: a new file's row, bytes and mode are committed in one transaction, and up to 16 files are held in dofs write buffers while a command writes them. Writes from the agent made between commands are picked up at the start of the next one. Writes the agent makes while a command runs are not visible to that command.

Two behaviours differ from Linux because dofs addresses file bytes by path. A file renamed over or unlinked while a process holds it open can no longer be read through that descriptor, and a write to it fails.

## Network

`egress` maps onto the machine's egress policy:

- `none` refuses every connection with `EACCES` and answers every lookup with `NXDOMAIN`, so commands fail at once.
- `direct` lets TCP connect through `cloudflare:sockets` and DNS go to DNS over HTTPS.
- `http-gateway` sends every connection to the gateway as HTTP requests, by the host name the command asked for. A connection to port 443 is requested as `https://`. Lookups are answered locally, since the gateway routes by name.

JS programs that call `fetch` themselves are outside the machine's policy; a toolset that does so has to honour the egress setting on its own.

## Limits

The machine shares the Durable Object's memory with the agent. Each process commits its own wasm memory, so keep `maxExecs` and `cacheBytes` modest. There are no listening sockets, and UDP other than DNS fails.

`getExec` replays an execution while the Durable Object stays in memory. The last 64 finished executions are kept; after an eviction an id is no longer found.

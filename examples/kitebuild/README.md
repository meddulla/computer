# kitebuild example

> [!IMPORTANT]
> This example uses an experimental part of Cloudflare Computer: the Kitebuild backend.
> Its API may change in any release, and it is not yet suitable for
> production use. See the [status table](../../packages/computer/README.md#status).

A Cloudflare Worker + Durable Object whose Workspace runs shell commands
on a Kitebuild machine: a BusyBox Linux userland that runs inside the
Durable Object that owns the Workspace. The HTTP surface is the same as
[`examples/worker-shell`](../worker-shell), so the same `curl` recipes
work.

Unlike the Worker shell, commands are real processes, so pipes,
background jobs and `wait` behave as on Linux, and output streams while
a command runs. Unlike the container backends, there is no container and
no second copy of the files: the machine mounts the Workspace's files at
`/workspace` and reads and writes them directly. See
[`docs/21_kitebuild_backend.md`](../../docs/21_kitebuild_backend.md) for
the backend itself.

```
client ─► Worker /c/<name>/{file,exec}
             │  (DO RPC calls)
             ▼
       DO (KitebuildExample) ──► Workspace ──► KitebuildBackend
                                    │               │
                                    └── one store ──┘
```

## What the shell has

- BusyBox: `sh`, `sort`, `sed`, `awk`, `tar`, `gzip`, `find` and the rest.
- `git`, Kitebuild's own (`@cloudflare/kitebuild-git`). It commits as
  the Workspace's `defaultGitIdentity` when a command sets no identity.
- `rg` and `jq` from `@cloudflare/kitebuild-tools`, passed to the
  backend as `commands`. Each loads its wasm the first time it runs, which
  needs the `new_module_registry` compatibility flag.
- No network. The backend's default egress is `none`, so `git clone`
  and `wget` are refused. See the backend docs to allow hosts through a
  gateway.

## Bundled skill

`src/skills/exec/SKILL.md` explains how `exec` works on this backend, for
an agent working in the workspace. It ships inside the Worker upload
through the `find_additional_modules` rule in `wrangler.jsonc`, and
`WorkerBundle("skills")` copies it to `/workspace/.agents/skills` as a
read-only mount, as in the Worker shell example. Mounting it also
creates `/workspace` when the Workspace starts, so a file can be
uploaded before any command has run.

```sh
curl -X POST -H 'content-type: application/json' \
  -d '{"command":"cat .agents/skills/exec/SKILL.md"}' \
  http://127.0.0.1:8787/c/demo/exec
```

## Packages

`@cloudflare/kitebuild-core`, `@cloudflare/kitebuild-git` and
`@cloudflare/kitebuild-tools` are not on public npm yet. Until they are,
`npm install` fetches them from Cloudflare's internal npm registry; see
[`COLLABORATORS.md`](../../COLLABORATORS.md#setup) for the token it
needs.

## Run it locally

```sh
npm install
npm run dev --workspace @example/computer-kitebuild
```

Then:

```sh
curl http://127.0.0.1:8787/

printf 'b\na\nTODO: one\nb\n' | curl -X PUT --data-binary @- \
  http://127.0.0.1:8787/c/demo/file/workspace/notes.txt

curl -X POST http://127.0.0.1:8787/c/demo/exec \
  -H 'content-type: application/json' \
  -d '{"command":"sort notes.txt | uniq -c | sort -rn; uname -m"}'

curl -X POST http://127.0.0.1:8787/c/demo/exec \
  -H 'content-type: application/json' \
  -d '{"command":"rg --json TODO . | jq -s \"map(select(.type == \\\"match\\\")) | length\""}'

curl -X POST http://127.0.0.1:8787/c/demo/exec \
  -H 'content-type: application/json' \
  -d '{"command":"git init -q repo && cd repo && cp ../notes.txt . && git add notes.txt && git commit -q -m notes && git log --oneline"}'
```

Pass `"stream": true` to get output as it is written, followed by the
exit code:

```sh
curl -N -X POST http://127.0.0.1:8787/c/demo/exec \
  -H 'content-type: application/json' \
  -d '{"command":"(sleep 1; echo late) & echo early; wait; exit 3","stream":true}'
```

```
early
late

[exit 3]
```

## HTTP surface

```
PUT  /c/<name>/file/workspace/<path>   raw body → writeFile at /workspace/<path>
GET  /c/<name>/file/workspace/<path>   octet-stream of /workspace/<path>
                                       (any path outside /workspace returns 400)
POST /c/<name>/exec                    { command | argv, cwd?, stream? }
                                       cwd defaults to /workspace
                                       → JSON { exitCode, stdout, stderr },
                                         or with stream: true, the output as
                                         it is written, then [exit <code>]
```

## Size

Wrangler uploads BusyBox, its initramfs, `rg` and `jq` as precompiled
wasm modules. The whole Worker is about 6.8 MB, 2.7 MB compressed.
Leave out a tool you do not need to shrink it.

## Layout

```
examples/kitebuild/
  wrangler.jsonc    Worker + DO, compatibility flags and the wasm rule
  src/index.ts      Worker handler + DO (KitebuildExample)
  src/skills/       Files mounted read-only at /workspace/.agents/skills
```

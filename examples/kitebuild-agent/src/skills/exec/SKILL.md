---
name: exec
description: How exec works in this workspace. Commands run in a BusyBox Linux userland with a JavaScript toolchain, inside the durable object, not on a full Linux machine. Read this before your first command, and when a command fails in a way a usual Linux machine would not.
---

# Running commands

Every `exec` call runs your command in BusyBox `sh` on a Kitebuild
machine: a Linux userland that runs inside the durable object that holds
the workspace. Pipes, redirects, background jobs and `wait` work as on
Linux.

## Tools

Real programs, built for WebAssembly, which behave as they do on Linux:

- BusyBox: `sed`, `awk`, `grep`, `find`, `tar`, `diff`, `patch` and the rest.
- `rg` and `jq`.

Kitebuild's own implementations, in JavaScript, which cover what builds
and tests use but not every flag yet; their coverage grows over time:

- `git`: `clone`, `pull`, `status`, `diff`, `add`, `commit`, `log`,
  `branch`, `checkout`, `push` and more. Commits use a default identity
  unless you set one.
- `npm` (`install`, `ci`, `run`, `test`, `exec`), `npx`, `pnpm` and
  `node`, which runs a script, `-e` or `-p` in an isolated Worker, with
  no native addons or child processes.
  Scripts see only a few environment variables, such as `HOME`, `PATH`,
  `CI` and `NODE_ENV`, and those that start with `PUBLIC_` or `VITE_`.
  Load Node's built-in modules with `import`; `require("node:fs")` and
  other built-ins fail. Requiring an installed package works.
- `tsc`, the project's own TypeScript. It only typechecks; it never
  writes output files, so build with `vite build` or the project's build
  script instead.
- `vite` and `vitest`, Kitebuild's pinned releases, which run the
  project's config and tests. A warning says so when the project asks
  for another version.
- `curl`.

If one of these exits with code 3 and prints `kitebuild: unsupported:
<feature>: <reason>`, the command used something Kitebuild doesn't
support, and nothing ran. The line says what; change the approach
rather than retrying. `KITEBUILD_UNSUPPORTED=warn` in the command's
environment turns it into a warning.

## Limits

- Network access is limited to GitHub and the npm registry. Other hosts
  are refused by the egress policy.
- No `python`, compilers or other native programs. Running one fails with
  "can't execute '<name>': No such file or directory".
- `time` is not available; it needs `vfork`, which this machine does not
  implement.
- `tsc` may report errors inside `node_modules`, because some packages
  are installed types-only. Set `"skipLibCheck": true` to check only the
  project's code.
- Only `/workspace` is durable. Anything written elsewhere is gone when
  the durable object restarts.
- `/workspace/.agents/skills` (where this file lives) is read-only.

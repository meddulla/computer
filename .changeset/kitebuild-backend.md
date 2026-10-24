---
"@cloudflare/computer": minor
---

Add experimental `KitebuildBackend` at `@cloudflare/computer/backends/kitebuild`: shell commands on a BusyBox Linux userland in the Workspace's Durable Object, with the Workspace store mounted directly and output streamed as it is written. Its `git` is `@cloudflare/kitebuild-git` by default, or the Workspace's git client with `git: "workspace"`, and it has the Worker shell's `assets` and `artifacts` commands built in. Command backends now receive the Workspace's assets client as `host.assets`.

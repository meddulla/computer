---
"@cloudflare/computer": minor
---

Add `WorkspaceOptions.fallback`: a command that ends with a capability error on one command backend (exit 127 "not found", or a Kitebuild `kitebuild: unsupported:` exit 3) runs again on the named fallback backend, typically a ContainerBackend, as one execution. `isCapabilityError` is exported, and `fallback.when` replaces it. A moved run stays one execution for `getExec`, `killExec` and `disposeExec` by id, across restarts.

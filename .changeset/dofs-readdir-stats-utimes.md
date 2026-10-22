---
"@cloudflare/computer": minor
---

Add `readdirStatsSync` and `utimesSync` to `SQLiteWorkspaceProvider`, keep a `chmod` made while a write buffer is open, and resolve paths and unlink files with fewer SQL statements.

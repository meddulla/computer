import { createWorkspaceError } from "../errors";
import { canonicalizePath } from "../path";
import { incrementRev } from "../rev";
import type { Database } from "../storage";
import { assertNotReadOnly } from "./mount-guard";
import { findPendingWriteBuffer } from "./pendingWriteBuffer";
import { resolveInode } from "./resolve";
import { getWriteBuffer } from "./writeBuffer";

// Set the modification time of a path, in milliseconds as stored.
// Follows symlinks like utimes(2) and bumps rev so the sync protocol
// carries the change. A file with an open write buffer commits this
// time at release, unless it is written or truncated again first.
export function utimes(db: Database, path: string, mtime: number): void {
  const { path: canonical } = canonicalizePath(path);
  assertNotReadOnly(db, canonical);

  const pending = findPendingWriteBuffer(db, canonical);
  if (pending?.pending !== undefined) {
    pending.pending.mtime = mtime;
    pending.mtime = mtime;
    return;
  }

  db.transactionSync(() => {
    const node = resolveInode(db, canonical);
    if (node === null) {
      throw createWorkspaceError("ENOENT", `no such path: ${canonical}`, canonical);
    }
    const rev = incrementRev(db);
    db.run("UPDATE vfs_nodes SET mtime = ?, rev = ? WHERE inode = ?", mtime, rev, node.inode);
    const buffer = getWriteBuffer(db, node.inode);
    if (buffer !== undefined) buffer.mtime = mtime;
  });
}

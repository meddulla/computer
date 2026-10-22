// Keeps a KitebuildBackend's executions in the Workspace database, so
// getExec can replay one after the Durable Object restarts.
//
// Rows share WorkerJavaScriptBackend's tables, keyed by backend id; the
// payload encoding is this backend's own. A machine does not survive a
// restart, so an execution still marked running when the backend
// connects again is settled as failed.

import type { ExecEvent } from "@cloudflare/computer-rpc";
import type { Database } from "@cloudflare/dofs";

export interface ExecJournalOptions {
  /** Output bytes kept per execution; later output is not replayable. */
  maxBytes?: number;
  /** Finished executions kept, newest first. */
  maxExecutions?: number;
  /** How long a finished execution is kept, in milliseconds. */
  retentionMs?: number;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export class ExecJournal {
  readonly #db: Database;
  readonly #backend: string;
  readonly #maxBytes: number;
  readonly #maxExecutions: number;
  readonly #retentionMs: number;
  /** Output bytes stored so far for each running execution. */
  readonly #stored = new Map<string, number>();

  constructor(db: Database, backend: string, options: ExecJournalOptions = {}) {
    this.#db = db;
    this.#backend = backend;
    this.#maxBytes = options.maxBytes ?? 8 * 1024 * 1024;
    this.#maxExecutions = options.maxExecutions ?? 64;
    this.#retentionMs = options.retentionMs ?? 60 * 60_000;
    db.run(`
      CREATE TABLE IF NOT EXISTS workspace_runtime_executions (
        backend TEXT NOT NULL,
        id TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at INTEGER NOT NULL DEFAULT 0,
        finished_at INTEGER,
        PRIMARY KEY (backend, id)
      )
    `);
    db.run(`
      CREATE TABLE IF NOT EXISTS workspace_runtime_events (
        backend TEXT NOT NULL,
        execution_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        name TEXT NOT NULL,
        payload BLOB NOT NULL,
        PRIMARY KEY (backend, execution_id, seq)
      )
    `);
    this.#settleInterrupted();
    this.prune();
  }

  start(id: string): void {
    this.#db.transactionSync(() => {
      this.#db.run(
        "DELETE FROM workspace_runtime_events WHERE backend = ? AND execution_id = ?",
        this.#backend,
        id,
      );
      this.#db.run(
        `INSERT OR REPLACE INTO workspace_runtime_executions (backend, id, status, created_at, finished_at)
         VALUES (?, ?, 'running', ?, NULL)`,
        this.#backend,
        id,
        Date.now(),
      );
    });
    this.#stored.set(id, 0);
  }

  append(event: ExecEvent): void {
    if (event.name === "exit") {
      this.#insert(event.id, event.seq, "exit", encoder.encode(String(event.code)));
      return;
    }
    const stored = this.#stored.get(event.id);
    if (stored === undefined || stored > this.#maxBytes) return;
    const total = stored + event.value.byteLength;
    this.#stored.set(event.id, total);
    if (total > this.#maxBytes) {
      const note = `kitebuild: output past ${this.#maxBytes} bytes is not kept for replay\n`;
      this.#insert(event.id, event.seq, "stderr", encoder.encode(note));
      return;
    }
    this.#insert(event.id, event.seq, event.name, event.value);
  }

  finish(id: string, code: number): void {
    this.#stored.delete(id);
    this.#db.run(
      `UPDATE workspace_runtime_executions SET status = ?, finished_at = ? WHERE backend = ? AND id = ?`,
      code === 0 ? "completed" : "failed",
      Date.now(),
      this.#backend,
      id,
    );
  }

  /** A finished execution's events, or undefined when none is kept. */
  load(id: string): ExecEvent[] | undefined {
    const row = this.#db.one<{ status: string }>(
      "SELECT status FROM workspace_runtime_executions WHERE backend = ? AND id = ?",
      this.#backend,
      id,
    );
    if (row === undefined || row.status === "running") return undefined;
    return this.#db
      .all<{ seq: number; name: string; payload: Uint8Array }>(
        `SELECT seq, name, payload FROM workspace_runtime_events
          WHERE backend = ? AND execution_id = ? ORDER BY seq`,
        this.#backend,
        id,
      )
      .map(({ seq, name, payload }): ExecEvent =>
        name === "exit"
          ? { id, seq, name: "exit", code: Number(decoder.decode(payload)) }
          : { id, seq, name: name === "stderr" ? "stderr" : "stdout", value: payload },
      );
  }

  dispose(id: string): void {
    this.#db.transactionSync(() => {
      this.#db.run(
        "DELETE FROM workspace_runtime_events WHERE backend = ? AND execution_id = ?",
        this.#backend,
        id,
      );
      this.#db.run(
        "DELETE FROM workspace_runtime_executions WHERE backend = ? AND id = ? AND status != 'running'",
        this.#backend,
        id,
      );
    });
  }

  /** Drop finished executions past the count or age limit. */
  prune(): void {
    const expired = this.#db.all<{ id: string }>(
      `SELECT id FROM workspace_runtime_executions
        WHERE backend = ? AND status != 'running'
          AND (finished_at < ? OR id NOT IN (
            SELECT id FROM workspace_runtime_executions
             WHERE backend = ? AND status != 'running'
             ORDER BY finished_at DESC LIMIT ?))`,
      this.#backend,
      Date.now() - this.#retentionMs,
      this.#backend,
      this.#maxExecutions,
    );
    for (const { id } of expired) this.dispose(id);
  }

  #insert(id: string, seq: number, name: string, payload: Uint8Array): void {
    this.#db.run(
      `INSERT OR REPLACE INTO workspace_runtime_events (backend, execution_id, seq, name, payload)
       VALUES (?, ?, ?, ?, ?)`,
      this.#backend,
      id,
      seq,
      name,
      payload,
    );
  }

  #settleInterrupted(): void {
    const interrupted = this.#db.all<{ id: string; seq: number | null }>(
      `SELECT e.id AS id, (SELECT MAX(seq) FROM workspace_runtime_events v
                            WHERE v.backend = e.backend AND v.execution_id = e.id) AS seq
         FROM workspace_runtime_executions e
        WHERE e.backend = ? AND e.status = 'running'`,
      this.#backend,
    );
    for (const { id, seq } of interrupted) {
      const next = (seq ?? 0) + 1;
      const note = "kitebuild: the command stopped when its Durable Object restarted\n";
      this.#insert(id, next, "stderr", encoder.encode(note));
      this.#insert(id, next + 1, "exit", encoder.encode("1"));
      this.finish(id, 1);
    }
  }
}

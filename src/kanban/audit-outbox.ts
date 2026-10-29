import { randomUUID } from "node:crypto";
import { closeSync, existsSync, fsyncSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { KanbanStore, Lease, WorkerState } from "./store.js";

export interface Observation {
  id: string;
  at: string;
  taskId: string;
  lease: Lease;
  event: string;
  durationMs: number | null;
  state?: WorkerState;
}

/** Write-ahead delivery: acknowledgement loss replays the same ID, not another event. */
export class AuditOutbox {
  readonly file: string;
  private entries: Observation[];
  private failure?: Error;
  constructor(private store: KanbanStore, owner: string, private limit = 1000) {
    this.file = join(store.directory, `audit-${owner}.json`);
    this.entries = existsSync(this.file) ? JSON.parse(readFileSync(this.file, "utf8")) : [];
    if (existsSync(`${this.file}.failed`)) this.failure = new Error(`Audit incomplete: operator recovery required; see ${this.file}.failed`);
  }
  private persist(entries: Observation[]) {
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    try {
      const fd = openSync(temporary, "w", 0o600);
      try { writeFileSync(fd, JSON.stringify(entries)); fsyncSync(fd); } finally { closeSync(fd); }
      renameSync(temporary, this.file);
    } finally { rmSync(temporary, { force: true }); }
  }
  enqueue(taskId: string, lease: Lease, event: string, durationMs: number | null = null, state?: WorkerState) {
    if (this.failure) throw this.failure;
    try {
      if (this.entries.length >= this.limit) throw new Error("Audit outbox capacity reached; execution blocked until operator recovery");
      const next = [...this.entries, { id: randomUUID(), at: new Date().toISOString(), taskId, lease, event, durationMs, state }];
      this.persist(next);
      this.entries = next;
    } catch (e) {
      this.failure = new Error(`Audit write-ahead persistence failed: ${String(e)}`);
      // A bounded failure record prevents a later restart from certifying an incomplete audit.
      try {
        const fd = openSync(`${this.file}.failed`, "wx", 0o600);
        try { writeFileSync(fd, JSON.stringify({ error: this.failure.message, taskId, lease, event, durationMs, state, at: new Date().toISOString() })); fsyncSync(fd); } finally { closeSync(fd); }
      } catch { /* Total disk failure is surfaced to the controller, which stops the worker. */ }
      throw this.failure;
    }
  }
  flush() {
    if (this.failure) throw this.failure;
    while (this.entries.length) {
      const e = this.entries[0];
      this.store.observe(e.taskId, e.lease, e.event, e.durationMs, e.state, e.event, e);
      const next = this.entries.slice(1);
      this.persist(next);
      this.entries = next;
    }
  }
  get pending() { return this.entries.length; }
}

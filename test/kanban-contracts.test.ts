import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { KanbanStore, type NewTask } from "../src/kanban/store.js";

let root: string, cwd: string, store: KanbanStore;
const spec: NewTask = { title: "Contracts", scope: "Verify worker contracts", assignee: "operate", rubric: [{ title: "Correctness", weight: 100 }] };
function start() { const t = store.create(spec, "orchestrator"); store.move(t.id, "ready", "orchestrator"); return { id: t.id, lease: store.claim(t.id, "session") }; }
function task(id: string) { return store.task(store.read(), id); }
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "kanban-contracts-")); cwd = join(root, "project"); mkdirSync(cwd); store = new KanbanStore(cwd, join(root, "state")); });
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("worker identity, audit and live contracts", () => {
  it("reserves names across boards and preserves identity across pause/restart/resume", () => {
    const a = start(), identity = a.lease.identity!;
    expect(identity.name).toBe("Ada"); expect(identity.definition).toBe("operate");
    const otherCwd = join(root, "other"); mkdirSync(otherCwd);
    const other = new KanbanStore(otherCwd, store.stateRoot), b = other.create(spec, "orchestrator");
    other.move(b.id, "ready", "orchestrator");
    expect(other.claim(b.id, "other-session").identity?.name).not.toBe(identity.name);
    store.move(a.id, "backlog", "user");
    store = new KanbanStore(cwd, store.stateRoot); store.move(a.id, "ready", "user");
    expect(store.claim(a.id, "resumed").identity).toEqual(identity);
    store.comment(a.id, "Evidence", "operator");
    expect(task(a.id).comments[0]).toMatchObject({ author: identity.name, identity });
  });
  it("extends exhausted permanent catalogs without recycling historical names", () => {
    const file = join(store.stateRoot, "worker-names.json");
    const source = readFileSync(join(import.meta.dirname, "../src/kanban/store.ts"), "utf8");
    const names = source.match(/const names = "([^"]+)"/)![1].split(" ");
    writeFileSync(file, JSON.stringify(Object.fromEntries(names.map(n => [n, "historical-id"]))));
    const { lease } = start(); expect(lease.identity?.name).toBe("Ada-2");
    expect(JSON.parse(readFileSync(file, "utf8"))["Ada-2"]).toBe(lease.identity?.id);
  });
  it("keeps role-bound actor attribution when old tool completion arrives after handoff", () => {
    const { id, lease } = start(), operator = lease.identity!;
    store.handoff(id, lease, "Implemented", "hash");
    const tester = store.claim(id, "tester");
    store.observe(id, lease, "tool end: KanbanTask", 12, "working");
    const t = task(id), end = t.history.at(-1)!;
    expect(end).toMatchObject({ actor: operator.name, identity: operator, durationMs: 12 });
    expect(t.workerStatus?.identity).toEqual(tester.identity);
    expect(t.workerStatus?.state).toBe("working");
    store.recordTests(id, tester, { command: "true", exitCode: 0, output: "pass", fingerprint: "hash", at: new Date().toISOString() });
    store.evaluate(id, "tester", [90], "Verified", "hash", "tester:secret-lease", tester);
    expect(task(id).evaluations.tester?.actor).toBe(tester.identity?.name);
    expect(task(id).history.find(e => e.event === "rubric evaluation")?.identity).toEqual(tester.identity);
  });
  it("migrates legacy comments/history without deleting details or inventing durations", () => {
    const t = store.create(spec, "orchestrator"), b = store.read();
    b.tasks[0].history = [{ at: t.createdAt, actor: "operate", event: "old action" }];
    b.tasks[0].comments = [{ id: "old-comment", author: "user", at: t.createdAt, text: "Old summary\n" + "detail ".repeat(1000) }];
    b.tasks[0].archived = true;
    writeFileSync(store.file, JSON.stringify(b));
    const a = task(t.id), reread = task(t.id);
    expect(a.history[0]).toMatchObject({ id: `legacy:${t.id}:0`, durationMs: null, delayMs: null });
    expect(a.history).toEqual(reread.history); expect(a.archived).toBe(true);
    expect(a.comments[0].summary).toBe("Old summary"); expect(a.comments[0].details).toBe(b.tasks[0].comments[0].text);
    store.comment(t.id, { summary: "Concise", details: "complete evidence\n".repeat(2000) }, "user");
    expect(task(t.id).comments[1].details).toHaveLength(36000);
    expect(task(t.id).comments[1].text).toBe(task(t.id).comments[1].details);
    expect(task(t.id).history[0].durationMs).toBeNull();
  });
  it("assigns stable event IDs and timestamps, distinguishes mutation time from operation duration", () => {
    const { id, lease } = start(); store.observe(id, lease, "tool end: read", 34);
    const history = task(id).history;
    expect(new Set(history.map(e => e.id)).size).toBe(history.length);
    history.forEach((e, i) => {
      expect(e.mutationDurationMs).toBeGreaterThanOrEqual(0);
      expect(e.delayMs).toBe(i ? Date.parse(e.at) - Date.parse(history[i - 1].at) : null);
      expect(e.durationMs).toBe(e.event === "tool end: read" ? 34 : null);
    });
    expect(task(id).history).toEqual(history);
  });
  it("bounds and deterministically orders safe activity projections, retaining full durable evidence", () => {
    const t = store.create(spec, "orchestrator");
    store.change(b => { const task = store.task(b, t.id); for (let i = 0; i < 220; i++) store.audit(task, "user", "comment", { id: `comment-${i}`, summary: `Result ${i} token=private-value`, text: "private raw tool output", details: "full evidence" }); });
    const activity = store.activity();
    expect(activity).toHaveLength(200); expect(activity).toEqual(store.activity());
    expect(new Set(activity.map(e => e.id)).size).toBe(200);
    expect(activity[0].commentId).toBe("comment-219");
    expect(activity.every(e => e.data === undefined)).toBe(true);
    expect(JSON.stringify(activity)).not.toContain("private-value"); expect(JSON.stringify(activity)).not.toContain("private raw");
    expect(task(t.id).history).toHaveLength(221);
    const board = store.read(), h = board.tasks[0].history;
    h[0].at = h.at(-1)!.at; h[0].id = "zzzz";
    expect(store.activity(board)[0].id).toBe("zzzz");
  });
  it("does not reactivate paused/finished workers from stale signals and records timed aborts", () => {
    const { id, lease } = start();
    store.observe(id, lease, "assistant thinking signalled", null, "thinking"); expect(task(id).workerStatus?.state).toBe("thinking");
    store.move(id, "backlog", "user");
    store.observe(id, lease, "tool start: bash", null, "working");
    store.observe(id, lease, "tool abort: bash", 18, "working");
    expect(task(id).workerStatus?.state).toBe("idle");
    expect(task(id).history.at(-1)).toMatchObject({ event: "tool abort: bash", durationMs: 18, identity: lease.identity });
    // Late/replayed observations remain auditable without reactivating the worker.
    expect(task(id).history.filter(e => e.event === "tool start: bash")).toHaveLength(1);
    store.release(id, lease, "stale failure"); expect(task(id).blocked).toBeUndefined();
  });
  it("clears stale busy state after lease loss and records release errors truthfully", () => {
    const { id, lease } = start(); store.release(id, lease, "Transport failed");
    expect(task(id).workerStatus).toMatchObject({ state: "error", reason: "Transport failed", identity: lease.identity });
    store.change(b => { const t = store.task(b, id); store.status(t, lease.identity!, "thinking", "runtime signal"); });
    expect(task(id).workerStatus?.state).toBe("error");
  });
  it("checks Done-only archive under lock after a stale client snapshot, preserving legacy archives", () => {
    const t = store.create(spec, "orchestrator"); store.change(b => { store.task(b, t.id).column = "done"; });
    const done = task(t.id); store.move(t.id, "backlog", "user");
    expect(() => store.archive(t.id, "user", done.updatedAt)).toThrow(/changed/);
    expect(() => store.archive(t.id, "user")).toThrow(/Only Done/);
    store.change(b => { store.task(b, t.id).archived = true; });
    expect(store.archive(t.id, "user").archived).toBe(true);
  });
});

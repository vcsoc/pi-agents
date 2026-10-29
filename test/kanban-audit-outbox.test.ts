import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuditOutbox } from "../src/kanban/audit-outbox.js";
import { KanbanController } from "../src/kanban/controller.js";
import { KanbanStore } from "../src/kanban/store.js";

let root: string, store: KanbanStore;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "audit-outbox-")); const cwd = join(root, "project"); mkdirSync(cwd); store = new KanbanStore(cwd, join(root, "state")); });
afterEach(() => { vi.restoreAllMocks(); rmSync(root, { recursive: true, force: true }); });
function start() {
  const task = store.create({ title: "Audit", scope: "Audit delivery", assignee: "operate", rubric: [{ title: "Correct", weight: 100 }] }, "orchestrator");
  store.move(task.id, "ready", "user");
  return { id: task.id, lease: store.claim(task.id, "session") };
}
const history = (id: string) => store.task(store.read(), id).history;

describe("durable ordered observable audit delivery", () => {
  it("retains original event IDs/timestamps through real lock contention and restart", () => {
    const { id, lease } = start(), box = new AuditOutbox(store, "fixture");
    const lock = join(store.directory, "write.lock"); mkdirSync(lock); writeFileSync(join(lock, "pid"), String(process.pid));
    box.enqueue(id, lease, "tool start: read", null, "working");
    box.enqueue(id, lease, "tool end: read", 5);
    const original = JSON.parse(readFileSync(box.file, "utf8"));
    expect(() => box.flush()).toThrow(/busy/); expect(box.pending).toBe(2);
    rmSync(lock, { recursive: true });
    const resumed = new AuditOutbox(store, "fixture"); resumed.flush();
    const events = history(id).filter(e => e.event.startsWith("tool "));
    expect(events.map(e => ({ id: e.id, at: e.at }))).toEqual(original.map((e: any) => ({ id: e.id, at: e.at })));
    expect(events[1].durationMs).toBe(5); expect(events[1].delayMs).toBeGreaterThanOrEqual(0);
    expect(resumed.pending).toBe(0);
  });
  it("deduplicates acknowledgement loss and maintains enqueue order", () => {
    const { id, lease } = start(), box = new AuditOutbox(store, "fixture");
    box.enqueue(id, lease, "tool start: bash"); box.enqueue(id, lease, "tool abort: bash", 12);
    const real = store.observe.bind(store); let fail = true;
    vi.spyOn(store, "observe").mockImplementation((...args) => { real(...args); if (fail) { fail = false; throw new Error("lost acknowledgement"); } });
    expect(() => box.flush()).toThrow(/acknowledgement/);
    box.flush(); box.flush();
    expect(history(id).filter(e => e.event.startsWith("tool ")).map(e => e.event)).toEqual(["tool start: bash", "tool abort: bash"]);
  });
  it("blocks unrecoverable capacity failure instead of certifying a complete audit", () => {
    const { id, lease } = start(), box = new AuditOutbox(store, "fixture", 1);
    box.enqueue(id, lease, "tool start: read");
    expect(() => box.enqueue(id, lease, "tool end: read", 1)).toThrow(/capacity/);
    expect(() => box.flush()).toThrow(/capacity/);
    expect(box.pending).toBe(1);
    expect(() => new AuditOutbox(store, "fixture").flush()).toThrow(/Audit incomplete/);
  });
  it("recovers a dead process outbox without reactivating paused workers", async () => {
    const { id, lease } = start(), box = new AuditOutbox(store, "2147483647-dead-session");
    box.enqueue(id, lease, "tool start: bash", null, "working");
    box.enqueue(id, lease, "tool abort: bash", 7);
    store.move(id, "backlog", "user");
    const controller = new KanbanController(store, { spawn: vi.fn(), record: vi.fn(), stop: vi.fn(), steer: vi.fn(), validAgent: () => true, notify: vi.fn() });
    await controller.tick(); await controller.close();
    expect(history(id).filter(e => e.event.startsWith("tool ")).map(e => e.event)).toEqual(["tool start: bash", "tool abort: bash"]);
    expect(store.task(store.read(), id).workerStatus?.state).toBe("idle");
    expect(new AuditOutbox(store, "2147483647-dead-session").pending).toBe(0);
  });
  it("notifies and blocks tools/handoff during failures, retries on tick and flushes shutdown", async () => {
    const notify = vi.fn(); let binding: any;
    const task = store.create({ title: "Controller", scope: "Reliable audit", assignee: "operate", rubric: [{ title: "Correct", weight: 100 }] }, "orchestrator");
    store.move(task.id, "ready", "user");
    const controller = new KanbanController(store, { spawn: (_type, _prompt, b) => { binding = b; return "agent"; }, record: () => ({ status: "running" }) as any, stop: vi.fn(), steer: vi.fn(), validAgent: () => true, notify });
    await controller.tick();
    const real = store.observe.bind(store), observe = vi.spyOn(store, "observe").mockImplementation(() => { throw new Error("board busy"); });
    expect(() => binding.observe("tool start: read", null, "working")).not.toThrow();
    expect(notify).toHaveBeenCalledWith(expect.stringContaining("degraded"));
    expect(() => binding.assertAllowed("read")).toThrow(/busy/);
    await expect(binding.tool.execute("call", { action: "handoff", notes: "Done" })).rejects.toThrow(/busy/);
    await controller.tick();
    observe.mockImplementation(real); await controller.tick();
    expect(() => binding.assertAllowed("read")).not.toThrow();
    binding.observe("tool abort: read", 20);
    await controller.close();
    expect(history(task.id).filter(e => e.event.startsWith("tool ")).map(e => e.event)).toEqual(["tool start: read", "tool abort: read"]);
  });
  it.each(["board lock", "recovered failed journal"])("cancels revoked workers before audit delivery recovers from %s", async failure => {
    let signal: AbortSignal | undefined;
    const spawn = vi.fn((_type, _prompt, _binding, _cwd, workerSignal) => { signal = workerSignal; return "agent"; });
    const stop = vi.fn(), notify = vi.fn();
    const task = store.create({ title: "Pause", scope: "Cancellation during degraded auditing", assignee: "operate", rubric: [{ title: "Correct", weight: 100 }] }, "orchestrator");
    store.move(task.id, "ready", "user");
    const controller = new KanbanController(store, { spawn, record: () => ({ status: "running" }) as any, stop, steer: vi.fn(), validAgent: () => true, notify });
    await controller.tick();
    const lease = store.task(store.read(), task.id).lease!;
    const box = (controller as any).outbox as AuditOutbox;
    box.enqueue(task.id, lease, "tool start: bash", null, "working");
    store.move(task.id, "backlog", "user");
    const paused = store.task(store.read(), task.id).workerStatus;
    const lock = join(store.directory, "write.lock");
    if (failure === "board lock") {
      mkdirSync(lock); writeFileSync(join(lock, "pid"), String(process.pid));
    } else {
      // Rehydrate a dead process's sticky marker while retaining the tracked runtime job.
      const failed = new AuditOutbox(store, "2147483647-failed");
      writeFileSync(`${failed.file}.failed`, "Audit incomplete");
      (controller as any).recovered.push(new AuditOutbox(store, "2147483647-failed"));
    }
    try {
      await controller.tick();
      expect(signal?.aborted).toBe(true);
      expect(stop).toHaveBeenCalledExactlyOnceWith("agent");
      expect(notify).toHaveBeenCalledWith(expect.stringContaining("degraded"));
      expect(box.pending).toBe(1);
      expect(history(task.id).some(e => e.event === "tool start: bash")).toBe(false);
      await controller.tick();
      expect(spawn).toHaveBeenCalledTimes(1);
      expect(store.task(store.read(), task.id).workerStatus).toEqual(paused);
    } finally {
      if (failure === "board lock") rmSync(lock, { recursive: true });
    }
    if (failure === "board lock") {
      await controller.tick();
      expect(box.pending).toBe(0);
      expect(history(task.id).filter(e => e.event === "tool start: bash")).toHaveLength(1);
      expect(store.task(store.read(), task.id).workerStatus).toEqual(paused);
      expect(spawn).toHaveBeenCalledTimes(1);
      await controller.close();
    } else {
      await expect(controller.close()).rejects.toThrow(/cleanup needs attention/);
      expect(box.pending).toBe(1);
    }
  });
  it("surfaces shutdown failure and leaves a replayable durable outbox", async () => {
    const { id, lease } = start();
    const controller = new KanbanController(store, { spawn: vi.fn(), record: vi.fn(), stop: vi.fn(), steer: vi.fn(), validAgent: () => true, notify: vi.fn() });
    const box = (controller as any).outbox as AuditOutbox;
    box.enqueue(id, lease, "tool abort: bash", 7);
    vi.spyOn(store, "observe").mockImplementation(() => { throw new Error("disk unavailable"); });
    await expect(controller.close()).rejects.toThrow(/cleanup needs attention/);
    expect(JSON.parse(readFileSync(box.file, "utf8"))).toHaveLength(1);
  });
});

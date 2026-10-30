import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { KanbanBinding } from "../src/kanban/agent.js";
import { bindKanbanGate, kanbanGate } from "../src/kanban/agent.js";
import { KanbanController } from "../src/kanban/controller.js";
import { type Command, fingerprint, prBody } from "../src/kanban/execution.js";
import { KanbanBoardBusyError, KanbanStore, type NewTask } from "../src/kanban/store.js";
import type { AgentRecord } from "../src/types.js";

let root: string, cwd: string, store: KanbanStore, controller: KanbanController;
let jobs: { binding: KanbanBinding; cwd: string; signal: AbortSignal; record: AgentRecord; finish: () => void }[];
let run: ReturnType<typeof vi.fn<Command>>, stop: ReturnType<typeof vi.fn>, steer: ReturnType<typeof vi.fn>, notify: ReturnType<typeof vi.fn>;
const spec: NewTask = { title: "Fix validation", scope: "Validate bad requests and test valid requests", assignee: "operate", rubric: [{ title: "Correctness and tests", weight: 100 }] };
const call = async (binding: KanbanBinding, params: unknown) => binding.tool.execute("test-call", params as never, new AbortController().signal, undefined, {} as never);
function task(id: string) { return store.task(store.read(), id); }
async function finish(index: number) { jobs[index].finish(); await Promise.resolve(); await controller.tick(); await Promise.resolve(); await controller.tick(); }
async function start() { const t = store.create(spec, "orchestrator"); store.move(t.id, "ready", "orchestrator"); await controller.tick(); return t.id; }
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "pi-kanban-controller-")); cwd = join(root, "project"); mkdirSync(cwd); writeFileSync(join(cwd, "app.ts"), "export const result = true;\n");
  store = new KanbanStore(cwd, join(root, "state")); jobs = [];
  run = vi.fn(async (file: string) => ({ code: file === "git" ? 1 : 0, stdout: file === "bash" ? "Tests passed" : "", stderr: "" }));
  stop = vi.fn(id => { jobs.find(j => j.record.id === id)?.finish(); }); steer = vi.fn(); notify = vi.fn();
  controller = new KanbanController(store, {
    spawn: (_type, _prompt, binding, workingDir, signal) => {
      let resolve!: (s: string) => void; const promise = new Promise<string>(r => { resolve = r; });
      const record = { id: String(jobs.length), status: "running", promise } as AgentRecord;
      jobs.push({ binding, cwd: workingDir, signal, record, finish: () => { record.status = "completed"; resolve("Result"); } }); return record.id;
    },
    record: id => jobs.find(j => j.record.id === id)?.record, stop, steer, validAgent: () => true, notify, run,
  });
});
afterEach(async () => {
  try { await controller.close(); }
  finally { vi.restoreAllMocks(); vi.useRealTimers(); rmSync(root, { recursive: true, force: true }); }
});
describe('linked task capabilities', () => {
  it('worker proposals notify the orchestrator and stop a blocked parent without spawning child work', async () => {
    const id = await start(), first = jobs[0];
    const output = await call(first.binding, { action: 'propose', proposal: { parentId: id, title: 'Bounded child', scope: 'Independent prerequisite', reason: 'Different implementation owner required', expectedResult: 'Validated prerequisite', relationship: { targetId: id, type: 'completed-before', blocking: true } } });
    expect(output.terminate).toBe(true); expect(store.read().tasks).toHaveLength(2); expect(store.read().tasks[1].column).toBe('backlog');
    expect(notify).toHaveBeenCalledWith(expect.stringContaining('Worker proposed linked sub-task'));
    expect(() => first.binding.assertAllowed('edit')).toThrow(/stale/);
    await controller.tick(); expect(stop).toHaveBeenCalledWith(first.record.id); expect(first.signal.aborted).toBe(true); expect(jobs).toHaveLength(1);
    expect(task(id).snapshot).toBeDefined(); expect(task(id).revision).toBe(1);
  });
  it('assessment roles cannot implement via ordinary write/shell/deferred tools', async () => {
    const id = await start(); await call(jobs[0].binding,{action:'handoff',notes:'Implemented scope'}); await finish(0);
    const tester = jobs.at(-1)!.binding;
    expect(task(id).phase).toBe('tester');
    for(const tool of ['write','edit','bash','Agent','SubagentWorkflow','mcp_external_mutation']) expect(()=>tester.assertAllowed(tool)).toThrow(/cannot implement/);
    for(const tool of ['read','grep','find','KanbanTask']) expect(()=>tester.assertAllowed(tool)).not.toThrow();
    await call(tester,{action:'test',command:'npm test'}); expect(task(id).tests[0].exitCode).toBe(0);
  });
});
describe("Kanban dispatch polling", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  function holdBoardLock() {
    const lock = join(store.directory, "write.lock");
    mkdirSync(lock); writeFileSync(join(lock, "pid"), String(process.pid));
    return () => rmSync(lock, { recursive: true });
  }
  function readyTask() { const t = store.create(spec, "orchestrator"); store.move(t.id, "ready", "user"); return t.id; }
  it("retries repeated live-lock contention and dispatches exactly once after its owner releases it", async () => {
    const id = readyTask(), before = store.read(), release = holdBoardLock();
    const tick = vi.spyOn(controller, "tick");
    try {
      expect(() => store.change(() => {})).toThrow(KanbanBoardBusyError);
      expect(() => store.change(() => {})).toThrow("Kanban board is busy; retry the operation");
      controller.start(); controller.start();
      for (let attempt = 1; attempt <= 3; attempt++) {
        await vi.advanceTimersByTimeAsync(750);
        expect(tick).toHaveBeenCalledTimes(attempt);
        expect(jobs).toHaveLength(0);
        expect(store.read()).toEqual(before);
        expect(readFileSync(join(store.directory, "write.lock", "pid"), "utf8")).toBe(String(process.pid));
        expect(notify).not.toHaveBeenCalled();
      }
    } finally { release(); }
    await vi.advanceTimersByTimeAsync(750);
    expect(jobs).toHaveLength(1);
    expect(task(id)).toMatchObject({ column: "in progress", runs: 1, lease: { owner: controller.owner } });
    await vi.advanceTimersByTimeAsync(2250);
    expect(tick).toHaveBeenCalledTimes(7);
    expect(jobs).toHaveLength(1); expect(task(id).runs).toBe(1);
    expect(notify).not.toHaveBeenCalled();
  });
  it("does not persist typed claim contention as a task conflict", async () => {
    const id = readyTask(), before = store.read();
    const claim = vi.spyOn(store, "claim").mockImplementationOnce(() => { throw new KanbanBoardBusyError(); });
    const queueWrite = vi.spyOn(store, "change");
    controller.start();
    await vi.advanceTimersByTimeAsync(750);
    expect(claim).toHaveBeenCalledTimes(1);
    expect(queueWrite).not.toHaveBeenCalled();
    expect(store.read()).toEqual(before); expect(jobs).toHaveLength(0);
    expect(notify).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(750);
    expect(claim).toHaveBeenCalledTimes(2); expect(jobs).toHaveLength(1);
    expect(task(id)).toMatchObject({ runs: 1, column: "in progress" });
    expect(task(id).queue).toBeUndefined();
  });
  it("retries a stale lock disappearing during recovery without pausing polling", async () => {
    const id = readyTask(), before = store.read(), release = holdBoardLock();
    vi.spyOn(process, "kill").mockImplementationOnce(() => {
      release();
      throw Object.assign(new Error("Lock owner exited"), { code: "ESRCH" });
    });
    controller.start();
    await vi.advanceTimersByTimeAsync(750);
    expect(store.read()).toEqual(before); expect(jobs).toHaveLength(0);
    expect(notify).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(750);
    expect(jobs).toHaveLength(1); expect(task(id).runs).toBe(1);
  });
  it("does not overlap preparation across interval and manual ticks", async () => {
    const t = store.create({ ...spec, prMode: "review" }, "orchestrator");
    store.move(t.id, "ready", "user");
    let resume!: (value: Awaited<ReturnType<Command>>) => void;
    const preparation = new Promise<Awaited<ReturnType<Command>>>(resolve => { resume = resolve; });
    run.mockImplementation(async (_file, args) => ({ code: 0, stdout: args[0] === "branch" ? `pi-kban/${t.id}` : "", stderr: "" }));
    run.mockImplementationOnce(() => preparation);
    const claim = vi.spyOn(store, "claim");
    controller.start();
    await vi.advanceTimersByTimeAsync(750);
    try {
      await controller.tick();
      await vi.advanceTimersByTimeAsync(2250);
      expect(claim).toHaveBeenCalledTimes(1); expect(run).toHaveBeenCalledTimes(1);
      expect(jobs).toHaveLength(0); expect(task(t.id).runs).toBe(1);
    } finally { resume({ code: 0, stdout: cwd, stderr: "" }); }
    await vi.advanceTimersByTimeAsync(0);
    expect(jobs).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1500);
    expect(claim).toHaveBeenCalledTimes(1); expect(jobs).toHaveLength(1);
    expect(notify).not.toHaveBeenCalled();
  });
  it("cancels a paused worker before retrying contended lease cleanup", async () => {
    const id = await start();
    store.move(id, "backlog", "user");
    const release = holdBoardLock();
    controller.start();
    try {
      await vi.advanceTimersByTimeAsync(1500);
      expect(jobs[0].signal.aborted).toBe(true);
      expect(stop).toHaveBeenCalledExactlyOnceWith("0");
      expect(task(id).executionLease).toBeDefined();
      expect(notify).not.toHaveBeenCalled();
    } finally { release(); }
    await vi.advanceTimersByTimeAsync(750);
    expect(task(id).executionLease).toBeUndefined(); expect(task(id).column).toBe("backlog");
    expect(jobs).toHaveLength(1); expect(task(id).runs).toBe(1);
  });
  function contendAfterClaim(setupError?: Error) {
    const claim = store.claim.bind(store);
    let unlock!: () => void;
    const claimed = vi.spyOn(store, "claim").mockImplementationOnce((...args) => {
      const lease = claim(...args);
      unlock = holdBoardLock();
      if (setupError) vi.spyOn(store, "change").mockImplementationOnce(() => { throw setupError; });
      return lease;
    });
    return { claimed, unlock: () => unlock() };
  }
  it('retries transient preparation contention without permanently blocking the task', async () => {
    const id = readyTask(), contention = contendAfterClaim();
    controller.start();
    try { await vi.advanceTimersByTimeAsync(1500); expect(jobs).toHaveLength(0); } finally { contention.unlock(); }
    await vi.advanceTimersByTimeAsync(750);
    expect(jobs).toHaveLength(1); expect(task(id).blocked).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1500); expect(jobs).toHaveLength(1);
    expect(notify.mock.calls.flat().join(' ')).not.toContain('dispatch paused');
  });
  it.each([new Error("Snapshot metadata preparation failed")])("retains failed setup cleanup after a successful claim and recovers without redispatch: %s", async setupError => {
    const id = readyTask(), contention = contendAfterClaim(setupError);
    const original = String(setupError ?? new KanbanBoardBusyError());
    const release = vi.spyOn(store, "release");
    controller.start();
    try {
      await vi.advanceTimersByTimeAsync(750);
      const lease = task(id).lease!;
      expect(lease).toMatchObject({ owner: controller.owner, pid: process.pid });
      expect(task(id).executionLease?.token).toBe(lease.token);
      expect(jobs).toHaveLength(0);
      expect(release).toHaveBeenLastCalledWith(id, lease, original, true);
      expect(notify).toHaveBeenCalledWith(expect.stringContaining(original));
      expect(notify).toHaveBeenCalledWith(expect.stringContaining("lease cleanup pending"));
      await vi.advanceTimersByTimeAsync(2250);
      expect(release).toHaveBeenCalledTimes(4);
      expect(notify).toHaveBeenCalledTimes(1);
      expect(task(id).lease?.token).toBe(lease.token);
      expect(task(id).executionLease?.token).toBe(lease.token);
      expect(readFileSync(join(store.directory, "write.lock", "pid"), "utf8")).toBe(String(process.pid));
      expect(contention.claimed).toHaveBeenCalledTimes(1);
    } finally { contention.unlock(); }
    await vi.advanceTimersByTimeAsync(750);
    expect(task(id).lease).toBeUndefined(); expect(task(id).executionLease).toBeUndefined();
    expect(task(id).blocked).toBe(original);
    expect(task(id).workerStatus).toMatchObject({ state: "error", reason: original });
    expect(task(id).history).toContainEqual(expect.objectContaining({ event: "worker stopped", data: original }));
    await vi.advanceTimersByTimeAsync(2250);
    expect(task(id).runs).toBe(1); expect(contention.claimed).toHaveBeenCalledTimes(1);
    expect(jobs).toHaveLength(0); expect(stop).not.toHaveBeenCalled();
  });
  it.each([false, true])("close recovers pending setup cleanup and retains its diagnostic (first close contends: %s)", async closeWhileLocked => {
    const original = new Error("Snapshot metadata preparation failed during shutdown");
    const id = readyTask(), contention = contendAfterClaim(original);
    const tick = vi.spyOn(controller, "tick");
    controller.start();
    try {
      await vi.advanceTimersByTimeAsync(750);
      if (closeWhileLocked) {
        await expect(controller.close()).rejects.toThrow(/cleanup needs attention.*Snapshot metadata preparation failed during shutdown.*Kanban board is busy/);
        expect(task(id).lease).toBeDefined(); expect(task(id).executionLease).toBeDefined();
        expect(readFileSync(join(store.directory, "write.lock", "pid"), "utf8")).toBe(String(process.pid));
      }
    } finally { contention.unlock(); }
    await controller.close();
    expect(task(id).blocked).toBe(String(original));
    expect(task(id).workerStatus?.reason).toBe(String(original));
    expect(task(id).lease).toBeUndefined(); expect(task(id).executionLease).toBeUndefined();
    controller.start(); await vi.advanceTimersByTimeAsync(3000);
    expect(tick).toHaveBeenCalledTimes(1);
    expect(contention.claimed).toHaveBeenCalledTimes(1); expect(task(id).runs).toBe(1);
    expect(jobs).toHaveLength(0); expect(stop).not.toHaveBeenCalled();
  });
  it.each(["Unexpected storage failure", "Kanban board is busy; retry the operation"])("pauses future polls for a generic Error: %s", async message => {
    const id = readyTask();
    const read = vi.spyOn(store, "read").mockImplementationOnce(() => { throw new Error(message); });
    const tick = vi.spyOn(controller, "tick");
    controller.start();
    await vi.advanceTimersByTimeAsync(750);
    expect(read).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledExactlyOnceWith(`Kanban dispatch paused after an error: Error: ${message}`);
    await vi.advanceTimersByTimeAsync(3000);
    expect(tick).toHaveBeenCalledTimes(1); expect(read).toHaveBeenCalledTimes(1);
    expect(jobs).toHaveLength(0); expect(task(id).runs).toBe(0);
  });
  it("close prevents further contention retries or restart even after the fixture lock is released", async () => {
    const id = readyTask(), release = holdBoardLock();
    const tick = vi.spyOn(controller, "tick");
    try {
      controller.start();
      await vi.advanceTimersByTimeAsync(1500);
      expect(tick).toHaveBeenCalledTimes(2);
      await controller.close();
      expect(readFileSync(join(store.directory, "write.lock", "pid"), "utf8")).toBe(String(process.pid));
      await vi.advanceTimersByTimeAsync(2250);
      expect(tick).toHaveBeenCalledTimes(2);
    } finally { release(); }
    controller.start();
    await vi.advanceTimersByTimeAsync(2250);
    expect(tick).toHaveBeenCalledTimes(2);
    await controller.tick();
    expect(jobs).toHaveLength(0); expect(task(id).runs).toBe(0);
    expect(notify).not.toHaveBeenCalled();
  });
});
describe("Kanban role dispatch and evidence", () => {
  it("cancel tool immediately revokes workers, retains checkpoints and holds capacity until actual drain", async () => {
    const id = await start(), worker = jobs[0], before = task(id), tool = controller.orchestratorTool();
    writeFileSync(join(worker.cwd, "checkpoint.txt"), "retained unfinished work");
    stop.mockImplementationOnce(() => {});
    await tool.execute("root", { action: "cancel", id, notes: "Superseded by the current source" }, new AbortController().signal, undefined, {} as never);
    expect(worker.signal.aborted).toBe(true); expect(stop).toHaveBeenCalledExactlyOnceWith(worker.record.id);
    expect(task(id)).toMatchObject({ column: "done", disposition: { kind: "cancelled", actor: "orchestrator" }, revision: before.revision, snapshot: before.snapshot, workspace: before.workspace, executionLease: before.executionLease, tests: [], evaluations: {} });
    expect(task(id).lease).toBeUndefined(); expect(readFileSync(join(worker.cwd, "checkpoint.txt"), "utf8")).toBe("retained unfinished work");
    expect(() => worker.binding.assertAllowed("bash")).toThrow();
    await expect(call(worker.binding, { action: "handoff", notes: "Late result" })).rejects.toThrow();
    await expect(controller.complete(id)).rejects.toThrow();
    const waiting = store.create(spec, "orchestrator"); store.move(waiting.id, "ready", "orchestrator");
    expect(() => new KanbanStore(cwd, store.stateRoot).claim(waiting.id, "other-pi", false, true, 1)).toThrow(/capacity/);
    store.comment(id, "Explain the cancellation later", "user"); await controller.tick();
    expect(jobs.filter(j => j.binding.identity?.id === worker.binding.identity?.id)).toHaveLength(1);
    await finish(0);
    expect(task(id).executionLease).toBeUndefined(); expect(task(id).disposition?.kind).toBe("cancelled");
    expect(task(id).blocked).toBeUndefined(); expect(task(id).evaluations).toEqual({});
  });
  it("another controller can cancel safely and the owning controller aborts on reconciliation", async () => {
    const id = await start(), before = task(id);
    const remote = new KanbanController(new KanbanStore(cwd, store.stateRoot), { spawn: vi.fn(), record: vi.fn(), stop: vi.fn(), steer: vi.fn(), validAgent: () => true, notify: vi.fn() });
    try {
      remote.cancelTask(id, "Obsolete in another Pi session", "user", before.updatedAt);
      expect(task(id).executionLease).toEqual(before.executionLease);
      expect(() => jobs[0].binding.assertAllowed("read")).toThrow();
      await controller.tick(); expect(jobs[0].signal.aborted).toBe(true); expect(stop).toHaveBeenCalledWith("0");
    } finally { await remote.close(); }
  });
  it("workers cannot request cancellation through their bound tool or the orchestrator tool", async () => {
    const id = await start(), before = store.read();
    expect(() => jobs[0].binding.assertAllowed("Kanban")).toThrow(/delegate or change/);
    await expect(call(jobs[0].binding, { action: "cancel", notes: "Unauthorized" })).rejects.toThrow(/Unknown task action/);
    expect(store.read()).toEqual(before);
    await expect(controller.orchestratorTool().execute("root", { action: "cancel", id }, new AbortController().signal, undefined, {} as never)).rejects.toThrow(/Cancellation reason/);
    expect(task(id).column).toBe("in progress");
  });
  it("propagates the persisted identity into role prompts and tool responses", async () => {
    const id = await start(), binding = jobs[0].binding, identity = task(id).workers?.operator;
    expect(binding.identity).toEqual(identity); expect(binding.prompt).toContain(`Your name is ${identity?.name}`);
    expect(binding.prompt).toContain("concise comment summary");
    const response = await call(binding, { action: "get" });
    expect((response.details as any).workers.operator).toEqual(identity);
    await call(binding, { action: "comment", summary: "Verified inputs", details: "Full untruncated evidence\n".repeat(1000) });
    expect(task(id).comments[0]).toMatchObject({ summary: "Verified inputs", identity, author: identity?.name });
    expect(task(id).comments[0].details).toHaveLength(26000);
  });
  it("reports explicit dependencies/user waits/stuck with reason, identity and timestamps", async () => {
    const id = await start(), binding = jobs[0].binding;
    await expect(call(binding, { action: "status", state: "waiting_dependency", notes: "Waiting for independent tests" })).rejects.toThrow(/dependencyId/);
    for (const state of ["waiting_dependency", "waiting_user", "stuck", "working", "thinking", "idle"]) {
      await call(binding, { action: "status", state, notes: `Explicit ${state}`, dependencyId: state === "waiting_dependency" ? "test-task-id" : undefined });
      expect(task(id).workerStatus).toMatchObject({ state, reason: `Explicit ${state}`, identity: binding.identity });
      expect(Date.parse(task(id).workerStatus!.since)).not.toBeNaN();
      expect(Date.parse(task(id).workerStatus!.updatedAt)).not.toBeNaN();
    }
    await call(binding, { action: "handoff", notes: "Ready for independent testing" });
    expect(task(id).workerStatus?.state).toBe("finished");
    binding.observe?.("worker turn started", null, "working");
    expect(task(id).workerStatus?.state).toBe("finished");
    await expect(call(binding, { action: "status", state: "working", notes: "stale report" })).rejects.toThrow();
  });
  it("does not dispatch backlog tasks", async () => { store.create(spec, "orchestrator"); await controller.tick(); expect(jobs).toHaveLength(0); });
  it("dispatches only released work, with a role-bound tool", async () => { const id = await start(); expect(jobs).toHaveLength(1); expect(jobs[0].binding.prompt).toContain("operator"); expect(jobs[0].binding.tool.name).toBe("KanbanTask"); expect(task(id).column).toBe("in progress"); });
  it("prevents the assigned agent from spawning unrelated agents", async () => { await start(); expect(() => jobs[0].binding.assertAllowed("Agent")).toThrow(/delegate/); expect(() => jobs[0].binding.assertAllowed("SubagentWorkflow")).toThrow(); });
  it("rejects archive on an active worker; backlog is cancellation", async () => { const id = await start(); expect(() => store.archive(id, "user")).toThrow(/Only Done/); expect(jobs[0].signal.aborted).toBe(false); store.move(id, "backlog", "user"); await controller.tick(); expect(jobs[0].signal.aborted).toBe(true); expect(stop).toHaveBeenCalled(); expect(() => jobs[0].binding.assertAllowed("bash")).toThrow(/paused/); await expect(call(jobs[0].binding, { action: "comment", notes: "Too late" })).rejects.toThrow(); });
  it("moving to backlog cancels the worker and invalidates the old generation", async () => { const id = await start(); store.move(id, "backlog", "user"); await controller.tick(); expect(jobs[0].signal.aborted).toBe(true); await expect(call(jobs[0].binding, { action: "handoff", notes: "Stale work" })).rejects.toThrow(); });
  it("routes user comments into the active assigned worker", async () => { const id = await start(); store.comment(id, "Also cover an empty password", "user"); await controller.tick(); expect(steer).toHaveBeenCalledWith("0", expect.stringContaining("empty password")); await controller.tick(); expect(steer).toHaveBeenCalledTimes(1); });
  it("blocks agents ending without a handoff rather than retrying forever", async () => { const id = await start(); await finish(0); expect(task(id).blocked).toContain("without a valid handoff"); await controller.tick(); expect(jobs).toHaveLength(1); });
  it("executes the complete independent three-score pipeline", async () => {
    const id = await start();
    await call(jobs[0].binding, { action: "handoff", notes: "Implemented input validation" }); await finish(0);
    expect(jobs[1].binding.prompt).toContain("tester");
    await call(jobs[1].binding, { action: "test", command: "npm test" }); expect(run).toHaveBeenCalledWith("bash", ["-lc", "npm test"], jobs[1].cwd, expect.anything());
    expect(jobs[1].cwd).toBe(jobs[0].cwd); expect(jobs[1].cwd).not.toBe(cwd);
    await call(jobs[1].binding, { action: "evaluate", scores: [90], notes: "Tested invalid, empty, and valid inputs" });
    await call(jobs[1].binding, { action: "handoff", notes: "Testing passed" }); await finish(1);
    expect(jobs[2].binding.prompt).toContain("reviewer");
    await call(jobs[2].binding, { action: "evaluate", scores: [95], notes: "Reviewed implementation and edge-case tests" });
    await call(jobs[2].binding, { action: "handoff", notes: "Review passed" }); await finish(2);
    expect(task(id).phase).toBe("orchestrator");
    const tool = controller.orchestratorTool();
    await tool.execute("root", { action: "evaluate", id, scores: [92], notes: "Independently verified the user's acceptance scope" }, new AbortController().signal, undefined, {} as never);
    await controller.complete(id);
    expect(task(id).column).toBe("done"); expect(task(id).tests[0].exitCode).toBe(0); expect(Object.keys(task(id).evaluations)).toHaveLength(3);
    expect(task(id).evaluations.tester?.actor).not.toBe(task(id).evaluations.reviewer?.actor);
  });
  it("detects source changes after operator submission", async () => { const id = await start(); await call(jobs[0].binding, { action: "handoff", notes: "Implemented" }); await finish(0); writeFileSync(join(jobs[1].cwd, "app.ts"), "changed"); await expect(call(jobs[1].binding, { action: "test", command: "npm test" })).rejects.toThrow(/changed/); expect(task(id).tests).toHaveLength(0); });
  it("detects a test command that mutates submitted source", async () => { const id = await start(); await call(jobs[0].binding, { action: "handoff", notes: "Implemented" }); await finish(0); run.mockImplementation(async file => { if (file === "bash") writeFileSync(join(jobs[1].cwd, "app.ts"), "mutated by test"); return { code: file === "git" ? 1 : 0, stdout: "Pass", stderr: "" }; }); await expect(call(jobs[1].binding, { action: "test", command: "bad-test" })).rejects.toThrow(/changed project source/); expect(task(id).tests).toHaveLength(0); });
  it("does not create an orchestrator notification loop when the orchestrator replies", async () => {
    const id = await start(); await finish(0);
    const count = notify.mock.calls.length;
    store.comment(id, "Investigating the worker failure", "orchestrator"); await controller.tick();
    expect(notify).toHaveBeenCalledTimes(count);
    store.comment(id, "What remains to fix?", "user"); await controller.tick();
    expect(notify).toHaveBeenCalledTimes(count + 1); await controller.tick(); expect(notify).toHaveBeenCalledTimes(count + 1);
  });
  it("does not let an operator certify its own tests", async () => { await start(); await expect(call(jobs[0].binding, { action: "test", command: "true" })).rejects.toThrow(/Only the tester/); });
  it("attaches a direct tool-call gate while preserving the prior hook", async () => {
    const prior = vi.fn(); const session = { subscribe: vi.fn(), agent: { beforeToolCall: prior } } as never;
    const binding = { assertAllowed: (name: string) => { if (name === "bash") throw new Error("paused"); } } as KanbanBinding;
    bindKanbanGate(session, binding);
    const hook = (session as any).agent.beforeToolCall;
    expect(await hook({ toolCall: { name: "bash" } })).toEqual({ block: true, reason: "Error: paused" });
    await hook({ toolCall: { name: "read" } }); expect(prior).toHaveBeenCalledTimes(1);
  });
  it("gates nested ctx.executeTool calls through an inline extension", async () => {
    const handlers = new Map(); const binding = { assertAllowed: () => { throw new Error("archived"); } } as unknown as KanbanBinding;
    await kanbanGate(binding).factory({ on: (event: string, handler: unknown) => handlers.set(event, handler) } as never);
    expect(handlers.get("tool_call")({ toolName: "bash" })).toEqual({ block: true, reason: "Error: archived" });
  });
  it("snapshots source while excluding private state and generated dependencies", async () => { const before = await fingerprint(cwd, run); mkdirSync(join(cwd, "vault")); writeFileSync(join(cwd, "vault", "secret.md"), "private"); expect(await fingerprint(cwd, run)).toBe(before); writeFileSync(join(cwd, "app.ts"), "actual change"); expect(await fingerprint(cwd, run)).not.toBe(before); });
  it("PR body includes rubric, all available scores, and real test output", () => { const t = store.create(spec, "orchestrator"); t.tests.push({ command: "npm test", exitCode: 0, output: "All 12 tests passed", fingerprint: "hash", at: "now" }); const body = prBody(t); expect(body).toContain("Correctness and tests: 100%"); expect(body).toContain("tester: pending"); expect(body).toContain("All 12 tests passed"); });
});

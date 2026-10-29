import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { KanbanBinding } from "../src/kanban/agent.js";
import { bindKanbanGate, kanbanGate } from "../src/kanban/agent.js";
import { KanbanController } from "../src/kanban/controller.js";
import { type Command, fingerprint, prBody } from "../src/kanban/execution.js";
import { KanbanStore, type NewTask } from "../src/kanban/store.js";
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
afterEach(async () => { await controller.close(); rmSync(root, { recursive: true, force: true }); });
describe("Kanban role dispatch and evidence", () => {
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

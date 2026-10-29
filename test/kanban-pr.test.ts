import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { KanbanBinding } from "../src/kanban/agent.js";
import { KanbanController } from "../src/kanban/controller.js";
import { type Command, command } from "../src/kanban/execution.js";
import { KanbanStore } from "../src/kanban/store.js";
import type { AgentRecord } from "../src/types.js";

let root: string, cwd: string, store: KanbanStore, controller: KanbanController, state: string, checksPass: boolean;
let jobs: { binding: KanbanBinding; cwd: string; record: AgentRecord; finish: () => void }[], calls: { file: string; args: string[] }[];
let prExists: boolean;
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const call = (index: number, args: unknown) => jobs[index].binding.tool.execute("test", args as never, new AbortController().signal, undefined, {} as never);
async function finish(index: number) { jobs[index].finish(); await controller.tick(); await Promise.resolve(); await controller.tick(); }
async function setup(mode: "review" | "merge" = "review") {
  const t = store.create({ title: "PR feature", scope: "Implement, test and review a PR", assignee: "operate", rubric: [{ title: "Correctness and tests", weight: 100 }], prMode: mode }, "orchestrator");
  store.move(t.id, "ready", "orchestrator"); await controller.tick();
  const work = jobs[0].cwd; writeFileSync(join(work, "feature.txt"), "Implemented feature\n"); git(work, "add", "feature.txt"); git(work, "commit", "-m", "Implement feature");
  await call(0, { action: "handoff", notes: "Implemented feature and committed on task branch" }); await finish(0);
  await call(1, { action: "test", command: "test -f feature.txt" }); await call(1, { action: "evaluate", scores: [94], notes: "Independently verified feature exists and tests pass" });
  return t.id;
}
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "pi-kanban-pr-")); cwd = join(root, "project"); mkdirSync(cwd); git(cwd, "init", "-b", "main"); git(cwd, "config", "user.name", "Kanban Tests"); git(cwd, "config", "user.email", "kanban-test@example.invalid"); writeFileSync(join(cwd, "README.md"), "Test project\n"); git(cwd, "add", "."); git(cwd, "commit", "-m", "Initial fixture");
  store = new KanbanStore(cwd, join(root, "state")); jobs = []; calls = []; state = "OPEN"; prExists = false; checksPass = true;
  const run: Command = async (file, args, dir, signal) => {
    calls.push({ file, args: [...args] });
    if (file === "git" && args[0] === "push") return { code: 0, stdout: "Simulated push (no network)", stderr: "" };
    if (file !== "gh") return command(file, args, dir, signal);
    if (args[1] === "view") {
      if (!prExists) return { code: 1, stdout: "", stderr: "No PR" };
      return { code: 0, stdout: JSON.stringify({ number: 42, url: "https://github.com/example/project/pull/42", headRefName: git(dir, "branch", "--show-current"), headRefOid: git(dir, "rev-parse", "HEAD"), state }), stderr: "" };
    }
    if (args[1] === "create") prExists = true;
    if (args[1] === "merge") state = "MERGED";
    if (args[1] === "checks" && !checksPass) return { code: 1, stdout: "Required CI failed", stderr: "" };
    return { code: 0, stdout: "Simulated GitHub response (no network)", stderr: "" };
  };
  controller = new KanbanController(store, {
    spawn: (_type, _prompt, binding, workingDir) => { let resolve!: (s: string) => void; const promise = new Promise<string>(r => { resolve = r; }); const record = { id: String(jobs.length), status: "running", promise } as AgentRecord; jobs.push({ binding, cwd: workingDir, record, finish: () => { record.status = "completed"; resolve("Done"); } }); return record.id; },
    record: id => jobs.find(j => j.record.id === id)?.record, stop: id => { jobs.find(j => j.record.id === id)?.finish(); }, steer: vi.fn(), validAgent: () => true, notify: vi.fn(), run,
  });
});
afterEach(async () => { await controller.close(); rmSync(root, { recursive: true, force: true }); });
describe("conditional Kanban PR lifecycle (local Git + fake GitHub, no model calls)", () => {
  it("tester initiates a PR with rubric and test evidence from a persistent task worktree", async () => {
    const id = await setup(); await call(1, { action: "pr" });
    expect(store.read().tasks[0].pr?.number).toBe(42); expect(jobs[0].cwd).toBe(jobs[1].cwd); expect(jobs[0].cwd).not.toBe(cwd);
    const create = calls.find(c => c.file === "gh" && c.args[1] === "create")!;
    expect(create.args.at(-1)).toContain("tester: 94.00%"); expect(create.args.at(-1)).toContain("test -f feature.txt: exit 0"); expect(create.args).toContain(`pi-kban/${id}`);
  });
  it("reviewer records its review and orchestrator adds all three scores to the PR before done", async () => {
    const id = await setup(); await call(1, { action: "pr" }); await call(1, { action: "handoff", notes: "Testing and PR initiation complete" }); await finish(1);
    await call(2, { action: "evaluate", scores: [93], notes: "Independent review passed" }); await call(2, { action: "pr" }); await call(2, { action: "handoff", notes: "PR reviewed; merge not requested" }); await finish(2);
    await controller.orchestratorTool().execute("root", { action: "evaluate", id, scores: [95], notes: "Independently checked full user scope" }, new AbortController().signal, undefined, {} as never);
    await controller.complete(id);
    expect(store.read().tasks[0].column).toBe("done"); expect(calls.some(c => c.file === "gh" && c.args[1] === "merge")).toBe(false);
    const body = calls.filter(c => c.file === "gh" && c.args[1] === "edit").at(-1)!.args.at(-1)!;
    expect(body).toContain("orchestrator: 95.00%"); expect(body).toContain("reviewer: 93.00%"); expect(body).toContain("tester: 94.00%");
  });
  it("never merges without explicit user approval", async () => {
    await setup("merge"); await call(1, { action: "pr" }); await call(1, { action: "handoff", notes: "Tested" }); await finish(1);
    await call(2, { action: "evaluate", scores: [95], notes: "Reviewed" }); await call(2, { action: "pr" });
    expect(calls.some(c => c.file === "gh" && c.args[1] === "merge")).toBe(false); expect(store.read().tasks[0].blocked).toContain("user approval");
  });
  it("resumes the reviewer PR stage after an explicit approval wait", async () => {
    const id = await setup("merge"); await call(1, { action: "pr" }); await call(1, { action: "handoff", notes: "Tested" }); await finish(1);
    await call(2, { action: "evaluate", scores: [95], notes: "Reviewed" }); await call(2, { action: "pr" }); await finish(2);
    store.change(b => { const t = store.task(b, id); t.mergeApproved = true; t.blocked = undefined; store.audit(t, "user", "explicitly approved PR merge"); });
    await controller.tick(); expect(jobs).toHaveLength(4);
    await call(3, { action: "pr" }); await call(3, { action: "handoff", notes: "Approved PR stage completed" }); await finish(3);
    expect(store.read().tasks[0].phase).toBe("orchestrator"); expect(store.read().tasks[0].pr?.completed).toBe(true); expect(state).toBe("MERGED");
  });
  it("passing CI and head-commit match are required for an approved merge", async () => {
    const id = await setup("merge"); await call(1, { action: "pr" }); await call(1, { action: "handoff", notes: "Tested" }); await finish(1);
    store.change(b => { store.task(b, id).mergeApproved = true; }); await call(2, { action: "evaluate", scores: [95], notes: "Reviewed" }); await call(2, { action: "pr" });
    const merge = calls.find(c => c.file === "gh" && c.args[1] === "merge")!; expect(merge.args).toContain("--match-head-commit"); expect(merge.args).not.toContain("--admin"); expect(calls.some(c => c.args[1] === "checks" && c.args.includes("--required"))).toBe(true); expect(store.read().tasks[0].pr?.completed).toBe(true);
  });
  it("failed required CI prevents reviewer completion and merge", async () => {
    const id = await setup("merge"); await call(1, { action: "pr" }); await call(1, { action: "handoff", notes: "Tested" }); await finish(1);
    store.change(b => { store.task(b, id).mergeApproved = true; }); await call(2, { action: "evaluate", scores: [95], notes: "Reviewed" }); checksPass = false;
    await expect(call(2, { action: "pr" })).rejects.toThrow(/failed/); expect(calls.some(c => c.args[1] === "merge")).toBe(false); expect(store.read().tasks[0].pr?.completed).toBe(false);
  });
});

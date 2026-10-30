import { execFileSync, spawn } from "node:child_process";
import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { KanbanBinding } from "../src/kanban/agent.js";
import { KanbanController } from "../src/kanban/controller.js";
import { command, sourceFingerprint } from "../src/kanban/execution.js";
import { createSnapshot, integrateSnapshot } from "../src/kanban/snapshot.js";
import { KanbanStore, type NewTask } from "../src/kanban/store.js";
import type { AgentRecord } from "../src/types.js";

const spec: NewTask = { title: "Independent source change", scope: "Implement and test an independent source change", assignee: "operate", rubric: [{ title: "Correct tested source", weight: 100 }] };
let root: string, cwd: string, store: KanbanStore, controller: KanbanController, limit: number, realWorkers: boolean;
type Job = { binding: KanbanBinding; cwd: string; signal: AbortSignal; record: AgentRecord; finish: () => void; started: Promise<void> };
let jobs: Job[];
let others: KanbanController[];
const git = (...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
const task = (id: string) => store.task(store.read(), id);
const call = (job: Job, args: unknown) => job.binding.tool.execute("fixture", args as never, job.signal, undefined, {} as never);
const active = () => jobs.filter(job => job.record.status === "running");
function makeController() {
  return new KanbanController(store, {
    capacity: () => ({ limit, running: active().length, queued: 0 }),
    validAgent: () => true, notify: vi.fn(), steer: vi.fn(),
    stop: id => { jobs.find(job => job.record.id === id)?.finish(); },
    record: id => jobs.find(job => job.record.id === id)?.record,
    spawn: (_type, _prompt, binding, path, signal) => {
      let done!: (s: string) => void;
      const record = { id: String(jobs.length), status: "running", promise: new Promise<string>(resolve => { done = resolve; }) } as AgentRecord;
      let started = Promise.resolve();
      let finish = () => { record.status = "completed"; done("fixture finished"); };
      if (realWorkers) {
        // Real child processes block on stdin, proving overlap rather than four UI badges.
        const child = spawn(process.execPath, ["-e", "process.stdout.write(process.cwd()+'\\n');process.stdin.resume();process.stdin.on('end',()=>process.exit(0))"], { cwd: path, stdio: ["pipe", "pipe", "pipe"] });
        started = new Promise((resolve, reject) => { child.stdout.once("data", () => resolve()); child.once("error", reject); });
        const completed = finish;
        child.once("exit", completed);
        finish = () => { child.stdin.end(); };
      }
      jobs.push({ binding, cwd: path, signal, record, finish, started });
      return record.id;
    },
  });
}
function ready(count = 1) {
  return Array.from({ length: count }, () => { const t = store.create(spec, "orchestrator"); store.move(t.id, "ready", "user"); return t.id; });
}
async function finish(job: Job) { job.finish(); await job.record.promise; await controller.tick(); await Promise.resolve(); await controller.tick(); }
async function accepted(id: string, edit?: (path: string) => void) {
  const find = () => jobs.findLast(job => task(id).workers?.[task(id).phase]?.id === job.binding.identity?.id && job.record.status === "running")!;
  let job = find(); edit?.(job.cwd);
  await call(job, { action: "handoff", notes: "Implementation fixture" }); await finish(job);
  job = find(); await call(job, { action: "test", command: "node -e \"console.log('deterministic fixture passed')\"" });
  await call(job, { action: "evaluate", scores: [95], notes: "Executed fixture command on submitted source" });
  await call(job, { action: "handoff", notes: "Independent test fixture" }); await finish(job);
  job = find(); await call(job, { action: "evaluate", scores: [95], notes: "Independent reviewer snapshot fixture" });
  await call(job, { action: "handoff", notes: "Review fixture" }); await finish(job);
  await controller.orchestratorTool().execute("root", { action: "evaluate", id, scores: [95], notes: "Independent orchestrator fixture" }, new AbortController().signal, undefined, {} as never);
}
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "kanban-parallel-")); cwd = join(root, "project"); mkdirSync(cwd);
  writeFileSync(join(cwd, "app.ts"), "export const value = 1;\n");
  writeFileSync(join(cwd, "other.ts"), "export const other = 2;\n");
  writeFileSync(join(cwd, ".gitignore"), "private/\n.env\nnode_modules/\n");
  git("init", "--quiet"); git("add", ".");
  // Commits exist only in disposable test repositories, never the opened project.
  git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--quiet", "-m", "fixture baseline");
  store = new KanbanStore(cwd, join(root, "state")); jobs = []; others = []; limit = 4; realWorkers = false; controller = makeController();
});
afterEach(async () => { for (const other of others) await other.close(); await controller.close(); rmSync(root, { recursive: true, force: true }); });

describe("safe non-PR parallel dispatch", () => {
  it("dispatches four genuinely overlapping child workers among six eligible tasks", async () => {
    realWorkers = true; const ids = ready(6); await controller.tick();
    await Promise.all(jobs.map(job => job.started));
    expect(active()).toHaveLength(4); expect(new Set(jobs.map(job => job.cwd)).size).toBe(4);
    expect(jobs.every(job => job.cwd !== cwd && !job.signal.aborted)).toBe(true);
    for (const id of ids.slice(4)) expect(task(id)).toMatchObject({ runs: 0, queue: { state: "capacity", limit: 4, running: 4 } });
    for (const job of jobs) writeFileSync(join(job.cwd, "app.ts"), `isolated ${job.record.id}`);
    expect(readFileSync(join(cwd, "app.ts"), "utf8")).toContain("value = 1");
  });
  it.each([1, 2, 3, 4, 6])("honors explicit background capacity %i without a minimum-four override", async capacity => {
    limit = capacity; ready(6); await controller.tick(); expect(active()).toHaveLength(capacity);
    expect(store.read().tasks.filter(t => t.runs === 0)).toHaveLength(6 - capacity);
  });
  it("fills freed capacity FIFO before a returning tester, with no head-of-line starvation", async () => {
    const ids = ready(6); await controller.tick();
    await call(jobs[0], { action: "handoff", notes: "Submit first task" }); await finish(jobs[0]);
    expect(task(ids[4]).runs).toBe(1); expect(task(ids[0]).phase).toBe("tester"); expect(task(ids[0]).runs).toBe(1);
    expect(active()).toHaveLength(4);
  });
  it("never releases backlog, user-paused, archived or exhausted tasks", async () => {
    const [paused, exhausted, archived] = ready(3); store.move(paused, "backlog", "user");
    store.change(b => { const t = store.task(b, exhausted); t.runs = t.maxRuns; store.task(b, archived).archived = true; });
    const backlog = store.create(spec, "orchestrator"); await controller.tick(); expect(jobs).toHaveLength(0);
    expect(task(paused).userPaused).toBe(true); expect(task(backlog.id).column).toBe("backlog");
    expect(task(exhausted).blocked).toContain("budget"); expect(() => store.move(paused, "ready", "orchestrator")).toThrow(/Only the user/);
  });
  it("pause revokes the isolated worker immediately without caller writes or sibling cancellation", async () => {
    const ids = ready(6); await controller.tick(); const saved = jobs[0].cwd;
    writeFileSync(join(saved, "app.ts"), "cancelled work"); store.move(ids[0], "backlog", "user"); await controller.tick();
    expect(jobs[0].signal.aborted).toBe(true); expect(jobs[1].signal.aborted).toBe(false);
    await expect(call(jobs[0], { action: "handoff", notes: "stale" })).rejects.toThrow(/paused/);
    expect(existsSync(saved)).toBe(true); expect(readFileSync(join(cwd, "app.ts"), "utf8")).not.toContain("cancelled");
    await controller.tick(); expect(task(ids[4]).runs).toBe(1);
  });
  it("atomic claims enforce a multi-Pi lease cap and reject duplicate live ownership", async () => {
    const ids = ready(6); const second = new KanbanStore(cwd, join(root, "state"));
    for (const id of ids.slice(0, 4)) store.claim(id, "other-pi", false, true, 4);
    expect(() => second.claim(ids[0], "duplicate", false, true, 4)).toThrow();
    expect(() => second.claim(ids[4], "over-capacity", false, true, 4)).toThrow(/capacity 4/);
    await controller.tick(); expect(jobs).toHaveLength(0); expect(task(ids[0]).queue?.state).toBe("lease");
    expect(task(ids[4]).queue).toMatchObject({ state: "capacity", limit: 4 });
    expect(task(ids[4]).queue?.reason).toContain("across Pi processes");
  });
  it("reclaims dead isolated leases without consuming all capacity or reusing their token", async () => {
    limit = 1; const [id] = ready(); const stale = store.claim(id, "dead", false, true, 1);
    store.change(b => { store.task(b, id).lease!.pid = 2147483647; store.task(b, id).executionLease!.pid = 2147483647; });
    await controller.tick(); expect(active()).toHaveLength(1); expect(task(id).lease?.token).not.toBe(stale.token);
    expect(task(id).history.some(e => e.event === "recovered stale worker lease")).toBe(true);
  });
  it("holds a multi-Pi execution fence until the old snapshot worker actually settles", async () => {
    limit = 1; const [id, waiting] = ready(2); await controller.tick(); const worker = jobs[0];
    await call(worker, { action: "handoff", notes: "Submission revokes tools, not in-flight commands" });
    expect(task(id).lease).toBeUndefined(); expect(task(id).executionLease?.token).toBeDefined();
    const second = new KanbanStore(cwd, join(root, "state"));
    expect(() => second.claim(id, "second-pi", false, true, 1)).toThrow(/still draining/);
    expect(() => second.claim(waiting, "second-pi", false, true, 1)).toThrow(/capacity/);
    const other = makeController(); others.push(other); await other.tick();
    expect(task(id).queue).toMatchObject({ state: "lease", dependencyId: id });
    expect(task(id).queue?.reason).toContain("draining");
    await finish(worker); expect(task(id).executionLease).toBeUndefined(); expect(task(waiting).runs).toBe(1);
  });
  it("retains legacy shared-checkout protection and reports the concrete dependency", async () => {
    const [legacy, waiting] = ready(2); store.claim(legacy, "legacy-pi"); await controller.tick();
    expect(jobs).toHaveLength(0); expect(task(waiting).queue?.dependencyId).toBe(legacy); expect(task(waiting).queue?.reason).toContain(legacy);
    expect(task(waiting).queue?.reason).toContain("shared working tree");
  });
});

describe('accepted child checkpoint reconciliation', () => {
  async function suspendedParent(childFile: string) {
    const [id] = ready(); await controller.tick(); const parent = jobs[0];
    writeFileSync(join(parent.cwd, 'app.ts'), 'parent implementation');
    await call(parent, { action: 'handoff', notes: 'Parent checkpoint submission' }); await finish(parent);
    const tester = active()[0]; await call(tester, { action: 'test', command: 'true' });
    await call(tester, { action: 'evaluate', scores: [95], notes: 'Parent original evidence' });
    await call(tester, { action: 'handoff', notes: 'Parent original independent tests' }); await finish(tester);
    const reviewer = active()[0];
    await call(reviewer, { action: 'propose', proposal: { parentId: id, title: 'Child result', scope: 'Separate source prerequisite', reason: 'Independent owner', expectedResult: 'Accepted source change', relationship: { targetId: id, type: 'completed-before', blocking: true } } });
    const child = store.read().tasks.at(-1)!;
    store.edit(child.id, { ...spec, bestPractices: 'Keep changes scoped and independently validated' }, 'orchestrator');
    store.move(child.id, 'ready', 'orchestrator'); await controller.tick(); await finish(reviewer);
    await accepted(child.id, path => writeFileSync(join(path, childFile), 'accepted child result'));
    await controller.complete(child.id);
    return { id, child: child.id, workspace: parent.cwd, previous: task(id) };
  }
  it('explicitly reconciles accepted child source into a fresh retained parent checkpoint and reruns all fingerprint gates', async () => {
    const { id, child, workspace, previous } = await suspendedParent('other.ts');
    expect(task(id).suspension?.notified).toBe(true); expect(active()).toHaveLength(0);
    expect(readFileSync(join(workspace, 'other.ts'), 'utf8')).not.toBe('accepted child result');
    store.move(id, 'ready', 'orchestrator');
    const continued = task(id); expect(continued.workspace).not.toBe(workspace); expect(existsSync(workspace)).toBe(true);
    expect(continued.revision).toBe(previous.revision + 1); expect(continued.phase).toBe('operator');
    expect(continued.tests).toEqual([]); expect(continued.evaluations).toEqual({}); expect(continued.fingerprint).toBeUndefined();
    expect(readFileSync(join(continued.workspace!, 'app.ts'), 'utf8')).toBe('parent implementation');
    expect(readFileSync(join(continued.workspace!, 'other.ts'), 'utf8')).toBe('accepted child result');
    const retained = continued.history.find(e => e.event.startsWith('accepted dependency results reconciled'))!.data as any;
    expect(retained.previous.tests).toEqual(previous.tests); expect(retained.previous.evaluations).toEqual(previous.evaluations);
    expect(task(child).column).toBe('done');
    await controller.tick(); await accepted(id); await controller.complete(id);
    expect(readFileSync(join(cwd, 'app.ts'), 'utf8')).toBe('parent implementation');
    expect(readFileSync(join(cwd, 'other.ts'), 'utf8')).toBe('accepted child result');
    expect(task(id).tests[0].fingerprint).toBe(sourceFingerprint(cwd));
  });
  it('rejects overlapping accepted-child/parent edits without clobbering either checkpoint or evidence', async () => {
    const { id, workspace, previous } = await suspendedParent('app.ts');
    expect(() => store.move(id, 'ready', 'orchestrator')).toThrow(/reconciliation overlap.*app.ts/);
    expect(task(id)).toEqual(previous); expect(readFileSync(join(workspace, 'app.ts'), 'utf8')).toBe('parent implementation');
    expect(readFileSync(join(cwd, 'app.ts'), 'utf8')).toBe('accepted child result'); expect(active()).toHaveLength(0);
  });
});

describe("tested snapshot integration", () => {
  it("integrates exactly the tested source while preserving dirty work, index, branch and private files", async () => {
    writeFileSync(join(cwd, "other.ts"), "staged caller data"); git("add", "other.ts"); writeFileSync(join(cwd, "other.ts"), "unstaged caller data");
    writeFileSync(join(cwd, "draft.ts"), "untracked caller data"); mkdirSync(join(cwd, "vault")); writeFileSync(join(cwd, "vault", "secret.md"), "private vault");
    writeFileSync(join(cwd, ".env"), "PRIVATE=secret"); mkdirSync(join(cwd, "private")); writeFileSync(join(cwd, "private", "token"), "private ignored");
    const index = readFileSync(join(cwd, ".git", "index")), branch = git("symbolic-ref", "HEAD"), head = git("rev-parse", "HEAD");
    const [id] = ready(); await controller.tick(); const workspace = jobs[0].cwd;
    for (const path of ["vault", ".env", "private"]) expect(existsSync(join(workspace, path))).toBe(false);
    await accepted(id, path => { writeFileSync(join(path, "app.ts"), "export const value = 9;\n"); writeFileSync(join(path, "new.ts"), "tested new source"); });
    const hash = task(id).fingerprint; expect(task(id).tests[0].fingerprint).toBe(hash);
    for (const role of ["tester", "reviewer", "orchestrator"] as const) expect(task(id).evaluations[role]?.fingerprint).toBe(hash);
    await controller.complete(id); expect(task(id).column).toBe("done"); expect(sourceFingerprint(cwd)).toBe(hash);
    expect(readFileSync(join(cwd, ".git", "index"))).toEqual(index); expect(git("symbolic-ref", "HEAD")).toBe(branch); expect(git("rev-parse", "HEAD")).toBe(head);
    expect(readFileSync(join(cwd, "other.ts"), "utf8")).toBe("unstaged caller data"); expect(readFileSync(join(cwd, "draft.ts"), "utf8")).toBe("untracked caller data");
    expect(readFileSync(join(cwd, "vault", "secret.md"), "utf8")).toBe("private vault"); expect(readFileSync(join(cwd, ".env"), "utf8")).toBe("PRIVATE=secret");
    expect(existsSync(workspace)).toBe(true);
  });
  it("does not score another task's source and blocks conflicting integration without losing evidence", async () => {
    const [a, b] = ready(2); await controller.tick();
    await accepted(a, path => writeFileSync(join(path, "app.ts"), "task A"));
    await accepted(b, path => writeFileSync(join(path, "app.ts"), "task B"));
    expect(task(a).fingerprint).not.toBe(task(b).fingerprint); await controller.complete(a);
    await expect(controller.complete(b)).rejects.toThrow(/Integration conflict.*app.ts/);
    expect(readFileSync(join(cwd, "app.ts"), "utf8")).toBe("task A"); expect(task(b).column).toBe("review");
    expect(task(b).queue?.state).toBe("conflict"); expect(task(b).tests).toHaveLength(1); expect(Object.keys(task(b).evaluations)).toHaveLength(3);
  });
  it("refuses even disjoint integration onto a different untested full-source composition", async () => {
    const [id] = ready(); await controller.tick(); await accepted(id, path => writeFileSync(join(path, "app.ts"), "task change"));
    writeFileSync(join(cwd, "other.ts"), "caller changed concurrently");
    await expect(controller.complete(id)).rejects.toThrow(/Integration conflict.*other.ts/);
    expect(readFileSync(join(cwd, "app.ts"), "utf8")).toContain("value = 1");
  });
  it.each(["app.ts", "draft.ts"])("never overwrites baseline dirty/untracked caller file %s", async name => {
    writeFileSync(join(cwd, name), "caller dirty source"); const [id] = ready(); await controller.tick();
    await accepted(id, path => writeFileSync(join(path, name), "task tries overwrite"));
    await expect(controller.complete(id)).rejects.toThrow(/dirty\/untracked files are protected/);
    expect(readFileSync(join(cwd, name), "utf8")).toBe("caller dirty source");
  });
  it("protects staged caller edits even when unstaged contents equal HEAD", async () => {
    const original = readFileSync(join(cwd, "app.ts"));
    writeFileSync(join(cwd, "app.ts"), "staged caller edit"); git("add", "app.ts");
    writeFileSync(join(cwd, "app.ts"), original);
    const index = readFileSync(join(cwd, ".git", "index"));
    expect(git("diff", "HEAD", "--", "app.ts")).toBe("");
    expect(git("diff", "--cached", "HEAD", "--", "app.ts")).not.toBe("");
    const [id] = ready(); await controller.tick();
    await accepted(id, path => writeFileSync(join(path, "app.ts"), "task must not replace caller work"));
    await expect(controller.complete(id)).rejects.toThrow(/dirty\/untracked files are protected/);
    expect(readFileSync(join(cwd, "app.ts"))).toEqual(original);
    expect(readFileSync(join(cwd, ".git", "index"))).toEqual(index);
    expect(task(id).column).toBe("review"); expect(task(id).tests).toHaveLength(1);
  });
  it("checks reviewer/tester source tampering and never replaces a missing submitted snapshot", async () => {
    const [id] = ready(); await controller.tick(); await call(jobs[0], { action: "handoff", notes: "submit" }); await finish(jobs[0]);
    writeFileSync(join(jobs[1].cwd, "app.ts"), "tampered after submission");
    await expect(call(jobs[1], { action: "test", command: "true" })).rejects.toThrow(/changed/);
    await expect(call(jobs[1], { action: "evaluate", scores: [95], notes: "invalid" })).rejects.toThrow(/changed/);
    expect(task(id).tests).toHaveLength(0);
  });
  it("blocks a missing submitted snapshot instead of certifying a fresh caller copy", async () => {
    const [id] = ready(); await controller.tick(); const workspace = jobs[0].cwd;
    await call(jobs[0], { action: "handoff", notes: "submit" }); rmSync(workspace, { recursive: true }); await finish(jobs[0]);
    expect(jobs).toHaveLength(1); expect(task(id).blocked).toContain("snapshot is missing"); expect(task(id).tests).toHaveLength(0);
  });
  it("does not integrate after completion is revoked by a pause", async () => {
    const [id] = ready(); await controller.tick(); await accepted(id, path => writeFileSync(join(path, "app.ts"), "cancelled"));
    store.move(id, "backlog", "user"); await expect(controller.complete(id)).rejects.toThrow();
    expect(readFileSync(join(cwd, "app.ts"), "utf8")).toContain("value = 1");
  });
  it("preserves deletion and executable modes in the certified composition", async () => {
    const [id] = ready(); await controller.tick(); await accepted(id, path => { rmSync(join(path, "other.ts")); chmodSync(join(path, "app.ts"), 0o755); });
    await controller.complete(id); expect(existsSync(join(cwd, "other.ts"))).toBe(false);
    expect(statSync(join(cwd, "app.ts")).mode & 0o777).toBe(0o755); expect(sourceFingerprint(cwd)).toBe(task(id).fingerprint);
  });
  it("rejects hardlinked caller source and collisions with an ignored private path", async () => {
    linkSync(join(cwd, "app.ts"), join(root, "caller-link"));
    expect(() => createSnapshot(cwd, join(root, "hardlinked"), join(root, "hardlinked.json"))).toThrow(/hardlink/);
    rmSync(join(root, "caller-link")); mkdirSync(join(cwd, "private")); writeFileSync(join(cwd, "private", "token"), "secret");
    const [id] = ready(); await controller.tick(); await accepted(id, path => {
      writeFileSync(join(path, ".gitignore"), "node_modules/\n.env\n"); mkdirSync(join(path, "private")); writeFileSync(join(path, "private", "token"), "replacement");
    });
    await expect(controller.complete(id)).rejects.toThrow(/existing ignored path/);
    expect(readFileSync(join(cwd, "private", "token"), "utf8")).toBe("secret");
  });
  it("keeps failed-rubric implementation available for operator rework", async () => {
    const [id] = ready(); await controller.tick(); const path = jobs[0].cwd; writeFileSync(join(path, "app.ts"), "needs improvement");
    await call(jobs[0], { action: "handoff", notes: "submit" }); await finish(jobs[0]);
    await call(jobs[1], { action: "test", command: "true" }); await call(jobs[1], { action: "evaluate", scores: [70], notes: "Add missing validation" }); await finish(jobs[1]);
    expect(jobs[2].cwd).toBe(path); expect(readFileSync(join(path, "app.ts"), "utf8")).toBe("needs improvement"); expect(task(id).tests).toHaveLength(0);
  });
  it("rejects changed snapshot at the synchronous integration gate and symlink escapes", () => {
    const workspace = join(root, "snapshot"), manifest = join(root, "manifest.json"); createSnapshot(cwd, workspace, manifest);
    const hash = sourceFingerprint(workspace); writeFileSync(join(workspace, "app.ts"), "tamper");
    expect(() => integrateSnapshot(cwd, workspace, manifest, hash)).toThrow(/changed during completion/);
    symlinkSync(join(root, "absent-private"), join(cwd, "escape.ts"));
    expect(() => createSnapshot(cwd, join(root, "unsafe"), join(root, "unsafe.json"))).toThrow(/symlink/);
  });
  it("uses real deterministic test subprocess output without a real provider", async () => {
    expect((await command("node", ["-e", "console.log('no provider')"], cwd)).stdout).toContain("no provider");
  });
});

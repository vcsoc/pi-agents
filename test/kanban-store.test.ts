import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { KanbanBoardBusyError, KanbanStore, type Lease, type NewTask, projectIdentity, rubricScore } from "../src/kanban/store.js";

let root: string, cwd: string, store: KanbanStore;
const spec: NewTask = { title: "Implement login", scope: "Add validated login and regression tests", assignee: "operate", rubric: [{ title: "Correctness", weight: 60 }, { title: "Test coverage and security", weight: 40 }] };
const hash = "tested-source-hash";
function create() { return store.create(spec, "orchestrator"); }
function current(id: string) { return store.task(store.read(), id); }
function ready(id: string) { store.move(id, "ready", "orchestrator"); return store.claim(id, "test-session"); }
function operatorDone(id: string) { const lease = ready(id); store.handoff(id, lease, "Implemented and documented", hash); return store.claim(id, "tester-session"); }
function evidence(id: string, lease: Lease, code = 0) { store.recordTests(id, lease, { command: "npm test", exitCode: code, output: code ? "Expected true but got false" : "All tests pass", fingerprint: hash, at: new Date().toISOString() }); }
function testerDone(id: string) { const lease = operatorDone(id); evidence(id, lease); store.evaluate(id, "tester", [90, 90], "Independently tested all acceptance paths", hash, "tester-id", lease); store.handoff(id, lease, "Testing passed", hash); return store.claim(id, "reviewer-session"); }
function reviewerDone(id: string) { const lease = testerDone(id); store.evaluate(id, "reviewer", [90, 90], "Reviewed correctness, security, and tests", hash, "reviewer-id", lease); store.handoff(id, lease, "Review passed", hash); }

beforeEach(() => { root = mkdtempSync(join(tmpdir(), "pi-kanban-store-")); cwd = join(root, "project"); mkdirSync(cwd); store = new KanbanStore(cwd, join(root, "state")); });
afterEach(() => { vi.restoreAllMocks(); rmSync(root, { recursive: true, force: true }); });
describe("persistent project Kanban", () => {
  it("resumes a stopped tester without resetting its revision or evidence", () => {
    const t = create(), lease = operatorDone(t.id);
    evidence(t.id, lease);
    store.release(t.id, lease, "Turn limit checkpoint", true);
    const before = current(t.id);
    store.move(t.id, "ready", "orchestrator");
    const resumed = current(t.id);
    expect(resumed.phase).toBe("tester");
    expect(resumed.column).toBe("review");
    expect(resumed.revision).toBe(before.revision);
    expect(resumed.tests).toEqual(before.tests);
    expect(resumed.fingerprint).toBe(hash);
    expect(resumed.blocked).toBeUndefined();
    expect(store.claim(t.id, "resumed").role).toBe("tester");
  });
  it.each(["backlog", "ready", "in progress", "review"] as const)("explicit cancellation closes obsolete %s work without certifying it", column => {
    const t = create();
    store.change(b => { store.task(b, t.id).column = column; });
    const before = current(t.id);
    const cancelled = store.cancel(t.id, "Superseded by a newer implementation", "orchestrator", before.updatedAt);
    expect(cancelled).toMatchObject({ column: "done", archived: false, disposition: { kind: "cancelled", reason: "Superseded by a newer implementation", actor: "orchestrator" }, revision: before.revision, evaluations: {}, tests: [] });
    expect(cancelled.history.slice(0, -1)).toEqual(before.history);
    expect(cancelled.history.at(-1)).toMatchObject({ actor: "orchestrator", event: "cancelled without acceptance", data: { previous: { column, phase: before.phase, revision: before.revision } } });
    expect(cancelled.history.some(e => e.event === "completion gates passed")).toBe(false);
    expect(Number.isFinite(Date.parse(cancelled.disposition!.at))).toBe(true);
    const reopened = new KanbanStore(cwd, join(root, "state"));
    expect(reopened.task(reopened.read(), t.id)).toEqual(cancelled);
  });
  it("cancellation retains all current and historical evidence, PR metadata and private checkpoints", () => {
    const t = create(), tester = operatorDone(t.id);
    evidence(t.id, tester, 1); evidence(t.id, tester);
    store.evaluate(t.id, "tester", [90, 90], "Passing retry; the first failure remains recorded", hash, "tester-id", tester);
    store.handoff(t.id, tester, "Tests passed after retry", hash);
    const reviewer = store.claim(t.id, "reviewer-session", false, true);
    const workspace = join(root, "private-snapshot"), manifest = join(root, "snapshot.json");
    mkdirSync(workspace); writeFileSync(join(workspace, "checkpoint"), "unfinished source"); writeFileSync(manifest, "retained manifest");
    store.comment(t.id, "Scope is obsolete; retain diagnostics", "user");
    store.change(b => { const task = store.task(b, t.id); task.workspace = workspace; task.snapshot = { revision: task.revision, manifest }; task.pr = { number: 1, url: "https://example.invalid/1", branch: "task", completed: false, synced: false }; task.mergeApproved = true; task.queue = { state: "capacity", reason: "Waiting" }; task.blocked = "Previous diagnostic"; });
    const before = current(t.id);
    const cancelled = store.cancel(t.id, "Obsolete scope", "user");
    for (const key of ["revision", "phase", "rubric", "evaluations", "tests", "comments", "fingerprint", "workspace", "snapshot", "pr", "workers", "runs", "maxRuns", "blocked", "executionLease"] as const) expect(cancelled[key]).toEqual(before[key]);
    expect(cancelled.history.slice(0, -1)).toEqual(before.history);
    expect(cancelled.history.filter(e => e.event === "test executed")).toHaveLength(2);
    expect(cancelled.lease).toBeUndefined(); expect(cancelled.queue).toBeUndefined(); expect(cancelled.mergeApproved).toBe(false);
    expect(cancelled.workerStatus).toMatchObject({ state: "finished", reason: "Cancelled without acceptance: Obsolete scope" });
    expect(readFileSync(join(workspace, "checkpoint"), "utf8")).toBe("unfinished source"); expect(readFileSync(manifest, "utf8")).toBe("retained manifest");
    expect(() => store.assertActive(cancelled, reviewer)).toThrow();
    store.archive(t.id, "user"); expect(current(t.id).executionLease).toEqual(before.executionLease);
    store.release(t.id, reviewer, "Late worker error", true);
    expect(current(t.id).executionLease).toBeUndefined(); expect(current(t.id).blocked).toBe("Previous diagnostic");
  });
  it.each(["operator", "tester", "reviewer", "system", "orchestrator:forged", "worker-name"])("rejects unauthorized cancellation by %s without writes", actor => {
    const t = create(), before = readFileSync(store.file);
    expect(() => store.cancel(t.id, "Task text says cancel", actor)).toThrow(/Only the user or orchestrator/);
    expect(readFileSync(store.file)).toEqual(before);
  });
  it("requires a reason and rejects stale, archived or accepted cancellation", () => {
    const t = create();
    expect(() => store.cancel(t.id, "  ", "user")).toThrow(/Cancellation reason/);
    store.comment(t.id, "New information", "user");
    expect(() => store.cancel(t.id, "Obsolete", "user", t.updatedAt)).toThrow(/changed/);
    reviewerDone(t.id); store.evaluate(t.id, "orchestrator", [90, 90], "Evidence verified", hash, "orchestrator"); store.complete(t.id, hash);
    expect(() => store.cancel(t.id, "Relabel accepted work", "user")).toThrow(/accepted completion cannot be relabelled/);
    store.archive(t.id, "user");
    expect(() => store.cancel(t.id, "Relabel archived work", "orchestrator")).toThrow(/unfinished, unarchived/);
  });
  it("cancelled work is terminal, idempotent, archivable and cannot dispatch even read-only replies", () => {
    const t = create(); ready(t.id); const cancelled = store.cancel(t.id, "No longer needed", "user");
    expect(store.cancel(t.id, "Ignored duplicate", "orchestrator")).toEqual(cancelled);
    for (const column of ["backlog", "ready"] as const) expect(() => store.move(t.id, column, "user")).toThrow(/terminal/);
    expect(() => store.edit(t.id, spec, "user")).toThrow(/backlog/);
    store.comment(t.id, "Retained explanation only", "user");
    expect(() => store.claim(t.id, "reply", true)).toThrow(/not dispatchable/);
    expect(() => store.claim(t.id, "worker")).toThrow(/not dispatchable/);
    expect(() => store.evaluate(t.id, "orchestrator", [100, 100], "Forge acceptance", hash, "orchestrator")).toThrow();
    expect(() => store.complete(t.id, hash)).toThrow(/not ready/);
    store.archive(t.id, "user"); expect(current(t.id).disposition).toEqual(cancelled.disposition);
    expect(current(t.id).archived).toBe(true);
  });
  it("uses a canonical folder hash and project name", () => {
    const alias = join(root, "alias"); symlinkSync(cwd, alias, "dir");
    expect(projectIdentity(alias)).toEqual(projectIdentity(cwd));
    expect(store.read().name).toBe("project"); expect(store.read().id).toMatch(/^[a-f0-9]{64}$/);
  });
  it("keeps separate folders separate even if names match", () => {
    const other = join(root, "nested", "project"); mkdirSync(other, { recursive: true });
    expect(projectIdentity(other).id).not.toBe(store.identity.id);
  });
  it("persists tasks and audit history across sessions", () => {
    const t = create(); store.comment(t.id, "Use accessible validation errors", "user");
    expect(new KanbanStore(cwd, join(root, "state")).read()).toEqual(store.read());
    expect(current(t.id).history).toHaveLength(2);
  });
  it("creates tasks in backlog, with no work lease", () => { const t = create(); expect(t.column).toBe("backlog"); expect(() => store.claim(t.id, "worker")).toThrow(/not dispatchable/); });
  it.each([[], [{ title: "Incomplete weights", weight: 50 }], [{ title: "Bad", weight: -1 }], [{ title: "Bad", weight: Number.NaN }]])("rejects invalid rubrics %j", rubric => { expect(() => store.create({ ...spec, rubric }, "orchestrator")).toThrow(); });
  it.each(["", "   "])("rejects blank task scope %j", scope => { expect(() => store.create({ ...spec, scope }, "orchestrator")).toThrow(); });
  it("calculates weighted percentages without rounding a failure into a pass", () => { expect(rubricScore(spec.rubric, [100, 50])).toBe(80); expect(rubricScore(spec.rubric, [84.999, 84.999])).toBeLessThan(85); });
  it.each([[100], [101, 100], [Number.NaN, 100], [-1, 100]])("rejects invalid criterion scores %j", (...scores) => { expect(() => rubricScore(spec.rubric, scores)).toThrow(); });
  it("only releases a task after it has scope, assignee and rubric", () => { const t = create(); const lease = ready(t.id); expect(current(t.id).column).toBe("in progress"); expect(lease.role).toBe("operator"); });
  it("prevents duplicate worker claims across sessions", () => { const t = create(); ready(t.id); expect(() => store.claim(t.id, "another-session")).toThrow(/already/); });
  it("serializes shared-tree tasks through orchestrator review", () => {
    const a = create(), b = create(); reviewerDone(a.id); store.move(b.id, "ready", "orchestrator");
    expect(() => store.claim(b.id, "other")).toThrow(/shared working tree/);
  });
  it("backlog movement invalidates old capabilities and scores", () => {
    const t = create(), lease = operatorDone(t.id); store.move(t.id, "backlog", "user");
    expect(() => store.assertActive(current(t.id), lease)).toThrow(/paused/);
    expect(current(t.id).evaluations).toEqual({}); expect(current(t.id).revision).toBe(2);
  });
  it("only the user can release a user-paused task", () => { const t = create(); store.move(t.id, "backlog", "user"); expect(() => store.move(t.id, "ready", "orchestrator")).toThrow(/Only the user/); store.move(t.id, "ready", "user"); expect(current(t.id).userPaused).toBe(false); });
  it("edits only backlog tasks and changes revision", () => {
    const t = create(); store.edit(t.id, { ...spec, scope: "Changed acceptance criteria" }, "user"); expect(current(t.id).revision).toBe(2);
    ready(t.id); expect(() => store.edit(t.id, spec, "user")).toThrow(/backlog/);
  });
  it("rejects stale browser edits instead of overwriting comments", () => { const t = create(); store.comment(t.id, "New requirement", "user"); expect(() => store.edit(t.id, spec, "user", t.updatedAt)).toThrow(/changed/); expect(current(t.id).comments).toHaveLength(1); });
  it.each(["in progress", "review", "done"] as const)("cannot drag directly into %s", column => { const t = create(); expect(() => store.move(t.id, column, "user")).toThrow(/evidence/); });
  it("only the operator can hand work to the tester initially", () => { const t = create(), lease = ready(t.id); expect(() => store.evaluate(t.id, "operator", [100, 100], "Good", hash, "operator", lease)).toThrow(); store.handoff(t.id, lease, "Implementation ready", hash); expect(current(t.id).phase).toBe("tester"); });
  it("requires actual certified test execution before a passing tester score", () => { const t = create(), lease = operatorDone(t.id); expect(() => store.evaluate(t.id, "tester", [100, 100], "Looks good", hash, "tester", lease)).toThrow(/execute passing tests/); });
  it("failed tests cannot receive a passing tester score", () => { const t = create(), lease = operatorDone(t.id); evidence(t.id, lease, 1); expect(() => store.evaluate(t.id, "tester", [100, 100], "Test failed", hash, "tester", lease)).toThrow(/passing/); });
  it("failed testing with a low score sends clear fixes to the operator", () => {
    const t = create(), lease = operatorDone(t.id); evidence(t.id, lease, 1);
    store.evaluate(t.id, "tester", [60, 50], "Fix the missing invalid-password assertion and rerun npm test", hash, "tester", lease);
    expect(current(t.id).column).toBe("ready"); expect(current(t.id).phase).toBe("operator"); expect(current(t.id).comments.at(-1)?.text).toContain("Fix the missing");
    expect(current(t.id).history.some(e => e.event === "rubric evaluation")).toBe(true);
    expect(() => store.assertActive(current(t.id), lease)).toThrow();
  });
  it("clears outdated test failures when the same test is rerun successfully", () => { const t = create(), lease = operatorDone(t.id); evidence(t.id, lease, 1); evidence(t.id, lease); store.evaluate(t.id, "tester", [90, 90], "Retried and verified", hash, "tester", lease); expect(current(t.id).tests).toHaveLength(1); });
  it("tester cannot forge reviewer evaluation", () => { const t = create(), lease = operatorDone(t.id); evidence(t.id, lease); expect(() => store.evaluate(t.id, "reviewer", [100, 100], "Forged", hash, "tester", lease)).toThrow(/stage/); });
  it("rejects testing or scoring a changed source snapshot", () => { const t = create(), lease = operatorDone(t.id); evidence(t.id, lease); expect(() => store.evaluate(t.id, "tester", [100, 100], "Different files", "changed-hash", "tester", lease)).toThrow(/changed/); });
  it("requires independent reviewer handoff before orchestrator scoring", () => { const t = create(); testerDone(t.id); expect(() => store.evaluate(t.id, "orchestrator", [100, 100], "Premature", hash, "orchestrator")).toThrow(/stage/); });
  it("requires three passing evaluations before done", () => {
    const t = create(); reviewerDone(t.id); expect(() => store.complete(t.id, hash)).toThrow(/orchestrator/);
    store.evaluate(t.id, "orchestrator", [90, 100], "Verified full user scope and evidence", hash, "root-orchestrator");
    expect(store.complete(t.id, hash).column).toBe("done"); expect(current(t.id).evaluations.tester?.actor).not.toBe(current(t.id).evaluations.reviewer?.actor);
  });
  it("a reviewer below 85 sends work back to its assigned operator", () => { const t = create(), lease = testerDone(t.id); store.evaluate(t.id, "reviewer", [80, 80], "Cover session expiry and repair the unsafe fallback", hash, "reviewer", lease); expect(current(t.id).column).toBe("ready"); expect(current(t.id).phase).toBe("operator"); });
  it("the orchestrator's own below-threshold score also requires rework", () => { const t = create(); reviewerDone(t.id); store.evaluate(t.id, "orchestrator", [84, 84], "The user's accessibility acceptance criteria are missing", hash, "root"); expect(current(t.id).phase).toBe("operator"); expect(current(t.id).column).toBe("ready"); });
  it("requires tester-created PR before reviewer handoff", () => { const t = store.create({ ...spec, prMode: "review" }, "orchestrator"); const lease = operatorDone(t.id); evidence(t.id, lease); store.evaluate(t.id, "tester", [90, 90], "Tests passed", hash, "tester", lease); expect(() => store.handoff(t.id, lease, "Skip PR", hash)).toThrow(/PR/); });
  it("invalidates previous merge approval when task scope is reopened", () => { const t = store.create({ ...spec, prMode: "merge" }, "orchestrator"); store.change(b => { store.task(b, t.id).mergeApproved = true; }); store.move(t.id, "backlog", "user"); expect(current(t.id).mergeApproved).toBe(false); });
  it("does not permit changing PR policy after task creation", () => { const t = create(); expect(() => store.edit(t.id, { ...spec, prMode: "merge" }, "user")).toThrow(/PR policy/); });
  it.each(["backlog", "ready", "in progress", "review"] as const)("rejects archive in %s under the mutation lock", column => { const t = create(); store.change(b => { store.task(b, t.id).column = column; }); expect(() => store.archive(t.id, "user")).toThrow(/Only Done/); expect(current(t.id).archived).toBe(false); });
  it("archived task history and comments are retained", () => { const t = create(); store.change(b => { store.task(b, t.id).column = "done"; }); store.archive(t.id, "user"); store.comment(t.id, "Why this was completed", "user"); expect(current(t.id).comments).toHaveLength(1); expect(current(t.id).history.at(-1)?.event).toBe("comment"); });
  it("archive-all is unavailable before all active tasks are done", () => { create(); expect(() => store.archiveDone("user")).toThrow(/every active task/); });
  it("archives all done tasks while keeping their evidence", () => { const t = create(); reviewerDone(t.id); store.evaluate(t.id, "orchestrator", [100, 100], "Verified evidence", hash, "root"); store.complete(t.id, hash); store.archiveDone("user"); expect(current(t.id).archived).toBe(true); expect(current(t.id).tests).toHaveLength(1); });
  it("done-task comments allow only an explicit read-only response capability", () => { const t = create(); reviewerDone(t.id); store.evaluate(t.id, "orchestrator", [100, 100], "Verified", hash, "root"); store.complete(t.id, hash); store.comment(t.id, "What tests covered this?", "user"); const lease = store.claim(t.id, "reply", true); store.assertActive(current(t.id), lease); store.comment(t.id, "The recorded npm tests cover the login paths", "operator"); store.handoff(t.id, lease, "Answered", hash); expect(current(t.id).column).toBe("done"); expect(() => store.claim(t.id, "reply-again", true)).toThrow(/unanswered/); });
  it("retains an exhausted run budget across orchestrator requeues", () => { const t = create(); store.change(b => { store.task(b, t.id).runs = 12; }); store.move(t.id, "ready", "orchestrator"); expect(() => store.claim(t.id, "worker")).toThrow(/budget/); store.move(t.id, "backlog", "user"); store.move(t.id, "ready", "user"); expect(store.claim(t.id, "worker")).toBeDefined(); });
  it("does not reset corrupt durable state", () => { writeFileSync(store.file, "broken JSON"); expect(() => store.read()).toThrow(); expect(readFileSync(store.file, "utf8")).toBe("broken JSON"); });
  it("uses a typed exclusive cross-process mutation lock", () => {
    const lock = join(store.directory, "write.lock"), before = readFileSync(store.file);
    mkdirSync(lock); writeFileSync(join(lock, "pid"), String(process.pid));
    expect(() => create()).toThrow(KanbanBoardBusyError);
    expect(readFileSync(store.file)).toEqual(before);
    expect(readFileSync(join(lock, "pid"), "utf8")).toBe(String(process.pid));
  });
  it("treats a disappearing stale lock as contention without changing the board", () => {
    const lock = join(store.directory, "write.lock"), before = readFileSync(store.file), mutate = vi.fn();
    mkdirSync(lock); writeFileSync(join(lock, "pid"), "2147483647");
    vi.spyOn(process, "kill").mockImplementationOnce(() => {
      rmSync(lock, { recursive: true });
      throw Object.assign(new Error("Owner exited while another process removed its lock"), { code: "ESRCH" });
    });
    expect(() => store.change(mutate)).toThrow(KanbanBoardBusyError);
    expect(mutate).not.toHaveBeenCalled(); expect(readFileSync(store.file)).toEqual(before);
    expect(create().column).toBe("backlog");
  });
  it("does not disguise genuine lock storage errors as contention", () => {
    writeFileSync(join(store.directory, "write.lock"), "Not a lock directory");
    let failure: unknown;
    try { create(); } catch (e) { failure = e; }
    expect(failure).toBeInstanceOf(Error);
    expect(failure).not.toBeInstanceOf(KanbanBoardBusyError);
    expect(store.read().tasks).toHaveLength(0);
  });
  it("recovers a lock whose owner no longer exists", () => { const lock = join(store.directory, "write.lock"); mkdirSync(lock); writeFileSync(join(lock, "pid"), "2147483647"); expect(create().column).toBe("backlog"); });
});

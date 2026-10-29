import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

export const COLUMNS = ["backlog", "ready", "in progress", "review", "done"] as const;
export type Column = typeof COLUMNS[number];
export type Role = "operator" | "tester" | "reviewer" | "orchestrator";
export interface Criterion { title: string; weight: number }
export interface Evaluation { role: Role; actor: string; revision: number; scores: number[]; total: number; notes: string; fingerprint: string; at: string }
export interface TestEvidence { command: string; exitCode: number; output: string; fingerprint: string; at: string }
export interface Comment { id: string; author: string; text: string; at: string }
export interface Audit { at: string; actor: string; event: string; data?: unknown }
export interface Lease { token: string; owner: string; pid: number; role: Role; revision: number; commentOnly?: boolean }
export interface Task {
  id: string; title: string; scope: string; assignee: string; testerAgent: string; reviewerAgent: string;
  column: Column; phase: Role; revision: number; userPaused?: boolean; rubric: Criterion[]; evaluations: Partial<Record<Role, Evaluation>>;
  tests: TestEvidence[]; comments: Comment[]; history: Audit[]; archived: boolean; createdAt: string; updatedAt: string;
  prMode: "none" | "review" | "merge"; mergeApproved: boolean;
  pr?: { number: number; url: string; branch: string; completed: boolean; synced: boolean };
  workspace?: string; fingerprint?: string; lease?: Lease; repliedThrough?: string; runs: number; maxRuns: number; blocked?: string;
}
export interface Board { version: 1; id: string; name: string; projectPath: string; sequence: number; tasks: Task[] }
export interface NewTask {
  title: string; scope: string; assignee: string; rubric: Criterion[]; testerAgent?: string; reviewerAgent?: string;
  prMode?: Task["prMode"]; maxRuns?: number;
}
const now = () => new Date().toISOString();
export function text(value: unknown, label: string, max = 20000): string {
  if (typeof value !== "string" || !value.trim() || value.length > max) throw new Error(`${label} must be non-empty text (maximum ${max} characters)`);
  return value.trim();
}
export function validateRubric(value: Criterion[]): Criterion[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 20) throw new Error("Define 1-20 rubric criteria before releasing a task");
  const rubric = value.map(c => ({ title: text(c.title, "Criterion", 500), weight: c.weight }));
  if (rubric.some(c => typeof c.weight !== "number" || !Number.isFinite(c.weight) || c.weight <= 0) || Math.abs(rubric.reduce((s, c) => s + c.weight, 0) - 100) > 0.00001) throw new Error("Rubric weights must be positive and total 100");
  return rubric;
}
export function rubricScore(rubric: Criterion[], scores: number[]): number {
  if (!Array.isArray(scores) || scores.length !== rubric.length || scores.some(n => typeof n !== "number" || !Number.isFinite(n) || n < 0 || n > 100)) throw new Error("Supply a 0-100 score for every rubric criterion in order");
  return rubric.reduce((sum, c, i) => sum + c.weight * scores[i] / 100, 0);
}
export function projectIdentity(cwd: string) {
  const projectPath = realpathSync(cwd);
  return { projectPath, id: createHash("sha256").update(projectPath).digest("hex"), name: basename(projectPath) || projectPath };
}
export class KanbanStore {
  readonly directory: string;
  readonly file: string;
  readonly identity: ReturnType<typeof projectIdentity>;
  constructor(cwd: string, stateRoot: string) {
    this.identity = projectIdentity(cwd);
    this.directory = join(stateRoot, this.identity.id);
    this.file = join(this.directory, "board.json");
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    if (!existsSync(this.file)) this.change(() => {});
  }
  read(): Board {
    if (!existsSync(this.file)) return { version: 1, ...this.identity, sequence: 0, tasks: [] };
    const b = JSON.parse(readFileSync(this.file, "utf8")) as Board;
    if (b.version !== 1 || b.id !== this.identity.id || b.projectPath !== this.identity.projectPath || !Array.isArray(b.tasks) || !Number.isInteger(b.sequence)) throw new Error("Invalid Kanban state; restore its backup rather than silently resetting history");
    return b;
  }
  change<T>(mutate: (board: Board) => T): T {
    const lock = join(this.directory, "write.lock");
    try { mkdirSync(lock); } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      let stale = false;
      try {
        const pid = Number(readFileSync(join(lock, "pid"), "utf8"));
        if (!Number.isInteger(pid) || pid < 1) throw new Error("Invalid lock owner");
        try { process.kill(pid, 0); } catch (e) { stale = (e as NodeJS.ErrnoException).code === "ESRCH"; }
      } catch { stale = Date.now() - statSync(lock).mtimeMs > 30000; }
      if (!stale) throw new Error("Kanban board is busy; retry the operation");
      rmSync(lock, { recursive: true });
      mkdirSync(lock);
    }
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    try {
      writeFileSync(join(lock, "pid"), String(process.pid));
      const board = this.read();
      const result = mutate(board);
      board.sequence++;
      writeFileSync(temporary, JSON.stringify(board, null, 2), { mode: 0o600 });
      renameSync(temporary, this.file);
      return result;
    } finally {
      rmSync(temporary, { force: true });
      rmSync(lock, { recursive: true, force: true });
    }
  }
  task(board: Board, id: string): Task {
    const t = board.tasks.find(t => t.id === id);
    if (!t) throw new Error("Task not found");
    return t;
  }
  audit(t: Task, actor: string, event: string, data?: unknown) {
    t.updatedAt = new Date(Math.max(Date.now(), Date.parse(t.updatedAt) + 1)).toISOString();
    t.history.push({ at: t.updatedAt, actor, event, data });
  }
  assertActive(t: Task, lease: Lease) {
    if (t.archived || t.column === "backlog" || (t.column === "done" && !lease.commentOnly) || t.lease?.token !== lease.token || t.revision !== lease.revision || t.phase !== lease.role) throw new Error("Task is paused, archived, completed, reassigned, or this run is stale. Stop work.");
  }
  create(input: NewTask, actor: string): Task {
    return this.change(b => {
      if (b.tasks.length >= 10000) throw new Error("Board has 10000 tasks; export history before adding more");
      const prMode = input.prMode ?? "none";
      if (!["none", "review", "merge"].includes(prMode)) throw new Error("Invalid PR mode");
      const maxRuns = input.maxRuns ?? 12;
      if (!Number.isInteger(maxRuns) || maxRuns < 3 || maxRuns > 100) throw new Error("Run budget must be 3-100 agent runs");
      const task: Task = {
        id: randomUUID(), title: text(input.title, "Title", 200), scope: text(input.scope, "Scope"),
        assignee: text(input.assignee, "Assigned agent", 100), testerAgent: text(input.testerAgent ?? "operate", "Tester agent", 100), reviewerAgent: text(input.reviewerAgent ?? "operate", "Reviewer agent", 100),
        rubric: validateRubric(input.rubric), column: "backlog", phase: "operator", revision: 1,
        evaluations: {}, tests: [], comments: [], history: [], archived: false, createdAt: now(), updatedAt: now(),
        prMode, mergeApproved: false, runs: 0, maxRuns,
      };
      this.audit(task, actor, "created", input);
      b.tasks.push(task);
      return task;
    });
  }
  reset(t: Task) {
    t.revision++; t.phase = "operator"; t.evaluations = {}; t.tests = []; t.fingerprint = undefined;
    if (t.pr) { t.pr.completed = false; t.pr.synced = false; }
    t.lease = undefined; t.blocked = undefined; t.mergeApproved = false;
  }
  move(id: string, column: Column, actor: string, expectedUpdatedAt?: string) {
    return this.change(b => {
      const t = this.task(b, id);
      if (expectedUpdatedAt && t.updatedAt !== expectedUpdatedAt) throw new Error("Task changed; reopen before modifying it");
      if (t.archived) throw new Error("Archived tasks cannot be resumed");
      if (column === "ready" && t.userPaused && actor !== "user") throw new Error("Only the user may release a task they paused in backlog");
      if (column === "backlog") { this.reset(t); t.column = column; if (actor === "user") t.userPaused = true; }
      else if (column === "ready" && t.column === "backlog") { validateRubric(t.rubric); t.column = column; t.userPaused = false; if (actor === "user") t.runs = 0; }
      else throw new Error("Drag a task to backlog to pause/edit it, then to ready. Review and done require agent evidence.");
      this.audit(t, actor, `moved to ${column}`);
      return t;
    });
  }
  edit(id: string, input: NewTask, actor: string, expectedUpdatedAt?: string) {
    return this.change(b => {
      const t = this.task(b, id);
      if (expectedUpdatedAt && t.updatedAt !== expectedUpdatedAt) throw new Error("Task changed; reopen before editing it");
      if (t.archived || t.column !== "backlog" || t.lease) throw new Error("Move the task to backlog before editing");
      t.title = text(input.title, "Title", 200); t.scope = text(input.scope, "Scope");
      t.assignee = text(input.assignee, "Assigned agent", 100); t.rubric = validateRubric(input.rubric);
      t.testerAgent = text(input.testerAgent ?? t.testerAgent, "Tester agent", 100);
      t.reviewerAgent = text(input.reviewerAgent ?? t.reviewerAgent, "Reviewer agent", 100);
      if (input.prMode !== undefined && input.prMode !== t.prMode) throw new Error("PR policy cannot change on an existing task; create a new task instead");
      this.reset(t); this.audit(t, actor, "scope/assignment/rubric edited", input);
      return t;
    });
  }
  comment(id: string, message: string, actor: string, expectedUpdatedAt?: string) {
    return this.change(b => {
      const t = this.task(b, id);
      if (expectedUpdatedAt && t.updatedAt !== expectedUpdatedAt) throw new Error("Task changed; retry your comment");
      const c = { id: randomUUID(), author: actor, text: text(message, "Comment"), at: now() };
      t.comments.push(c); this.audit(t, actor, "comment", c);
      return t;
    });
  }
  archive(id: string, actor: string, expectedUpdatedAt?: string) {
    return this.change(b => {
      const t = this.task(b, id);
      if (expectedUpdatedAt && t.updatedAt !== expectedUpdatedAt) throw new Error("Task changed; reopen before archiving it");
      t.archived = true; t.lease = undefined; this.audit(t, actor, "archived; future work cancelled");
      return t;
    });
  }
  archiveDone(actor: string) {
    return this.change(b => {
      const tasks = b.tasks.filter(t => !t.archived);
      if (!tasks.length || tasks.some(t => t.column !== "done")) throw new Error("Archive all done is available only when every active task is done");
      for (const t of tasks) { t.archived = true; this.audit(t, actor, "archived completed scope"); }
    });
  }
  claim(id: string, owner: string, commentOnly = false): Lease {
    return this.change(b => {
      const t = this.task(b, id);
      if (t.archived || t.column === "backlog" || (!commentOnly && (!["ready", "in progress", "review"].includes(t.column) || t.phase === "orchestrator" || t.blocked))) throw new Error("Task is not dispatchable");
      if (commentOnly && (!t.comments.some(c => c.author === "user") || t.comments.filter(c => c.author === "user").at(-1)?.id === t.repliedThrough)) throw new Error("No unanswered user comment");
      if (t.prMode === "none" && b.tasks.some(other => other.id !== id && other.prMode === "none" && !other.archived && (other.lease || (other.runs > 0 && ["ready", "in progress", "review"].includes(other.column))))) throw new Error("Another task owns the shared working tree");
      if (t.lease) {
        let alive = true;
        try { process.kill(t.lease.pid, 0); } catch (e) { alive = (e as NodeJS.ErrnoException).code !== "ESRCH"; }
        if (alive) throw new Error("Task already has a worker");
        this.audit(t, "system", "recovered stale worker lease");
      }
      if (t.runs >= t.maxRuns) { throw new Error("Agent run budget exhausted; move to backlog then ready to authorize another budget"); }
      const lease: Lease = { token: randomUUID(), owner, pid: process.pid, role: t.phase, revision: t.revision, commentOnly };
      t.lease = lease; t.runs++; if (t.phase === "operator" && !commentOnly) t.column = "in progress";
      this.audit(t, t.phase, "worker claimed task", { role: lease.role, run: t.runs });
      return lease;
    });
  }
  release(id: string, lease: Lease, error?: string) {
    return this.change(b => {
      const t = this.task(b, id);
      if (t.lease?.token !== lease.token) return;
      t.lease = undefined;
      if (error) { t.blocked = error; this.audit(t, lease.role, "worker stopped", error); }
    });
  }
  recordTests(id: string, lease: Lease, evidence: TestEvidence) {
    return this.change(b => {
      const t = this.task(b, id); this.assertActive(t, lease);
      if (lease.role !== "tester") throw new Error("Only the tester can record test executions");
      t.tests = t.tests.filter(e => e.command !== evidence.command);
      t.tests.push(evidence); this.audit(t, "tester", "test executed", evidence);
    });
  }
  evaluate(id: string, role: Role, scores: number[], notes: string, fingerprint: string, actor: string, lease?: Lease) {
    return this.change(b => {
      const t = this.task(b, id);
      if (lease) this.assertActive(t, lease);
      if (t.archived || t.column !== "review" || t.phase !== role || role === "operator") throw new Error("This role cannot evaluate this task at this stage");
      const total = rubricScore(t.rubric, scores);
      const e: Evaluation = { role, actor, revision: t.revision, scores, total, notes: text(notes, "Detailed evaluation/fix instructions"), fingerprint, at: now() };
      if (t.fingerprint !== fingerprint) throw new Error("Work changed since submission. Return the task to backlog and retest the new revision.");
      if (role === "tester" && (!t.tests.length || t.tests.some(e => e.fingerprint !== fingerprint || (total >= 85 && e.exitCode !== 0)))) throw new Error("Tester must execute passing tests against the submitted revision before scoring");
      t.evaluations[role] = e; this.audit(t, actor, "rubric evaluation", e);
      t.comments.push({ id: randomUUID(), author: role, at: now(), text: `${total.toFixed(2)}%: ${e.notes}` });
      if (total < 85) { this.reset(t); t.column = "ready"; }
      return t;
    });
  }
  handoff(id: string, lease: Lease, summary: string, fingerprint: string) {
    return this.change(b => {
      const t = this.task(b, id); this.assertActive(t, lease);
      text(summary, "Handoff summary");
      t.repliedThrough = t.comments.filter(c => c.author === "user").at(-1)?.id;
      if (lease.commentOnly) { t.lease = undefined; this.audit(t, "assigned agent", "comment response completed", summary); return t; }
      if (lease.role === "operator") {
        t.column = "review"; t.phase = "tester"; t.fingerprint = fingerprint;
      } else {
        if (fingerprint !== t.fingerprint || !t.evaluations[lease.role] || (t.evaluations[lease.role]?.total ?? 0) < 85) throw new Error("A current rubric score of at least 85% is required before handoff");
        if (t.prMode !== "none" && (!t.pr || (lease.role === "reviewer" && !t.pr.completed))) throw new Error("Complete this role's PR stage before handing off");
        t.phase = lease.role === "tester" ? "reviewer" : "orchestrator";
      }
      t.lease = undefined; this.audit(t, lease.role, "handoff", summary);
      t.comments.push({ id: randomUUID(), author: lease.role, at: now(), text: summary });
      return t;
    });
  }
  complete(id: string, fingerprint: string) {
    return this.change(b => {
      const t = this.task(b, id);
      if (t.archived || t.phase !== "orchestrator" || t.column !== "review" || t.fingerprint !== fingerprint) throw new Error("Task is not ready for completion");
      for (const role of ["orchestrator", "tester", "reviewer"] as const) {
        const e = t.evaluations[role];
        if (!e || e.revision !== t.revision || e.fingerprint !== fingerprint || e.total < 85) throw new Error(`${role} must score this revision at least 85%`);
      }
      if (!t.tests.length || t.tests.some(e => e.exitCode !== 0 || e.fingerprint !== fingerprint)) throw new Error("Passing current-revision test evidence required");
      if (t.prMode !== "none" && (!t.pr?.completed || !t.pr.synced)) throw new Error("PR review/merge and all three rubric evaluations must be recorded on the PR");
      t.column = "done"; t.lease = undefined; this.audit(t, "orchestrator", "completion gates passed");
      return t;
    });
  }
}

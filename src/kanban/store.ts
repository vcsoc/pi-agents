import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { reconcileSnapshot } from "./snapshot.js";

export const COLUMNS = ["backlog", "ready", "in progress", "review", "done"] as const;
export type Column = typeof COLUMNS[number];
export type Role = "operator" | "tester" | "reviewer" | "orchestrator";
export interface Criterion { title: string; weight: number }
export interface Evaluation { role: Role; actor: string; revision: number; scores: number[]; total: number; notes: string; fingerprint: string; at: string }
export interface TestEvidence { command: string; exitCode: number; output: string; fingerprint: string; at: string }
export interface WorkerIdentity { id: string; name: string; role: Role; definition: string }
export type WorkerState = "working" | "thinking" | "waiting_dependency" | "waiting_user" | "stuck" | "idle" | "finished" | "error";
export interface WorkerStatus { state: WorkerState; reason: string; since: string; updatedAt: string; identity: WorkerIdentity; dependencyId?: string }
export interface Comment { id: string; author: string; text: string; at: string; summary?: string; details?: string; identity?: WorkerIdentity }
export interface Audit { id?: string; at: string; actor: string; event: string; data?: unknown; identity?: WorkerIdentity; durationMs?: number | null; mutationDurationMs?: number; delayMs?: number | null }
export interface Activity extends Audit { taskId: string; summary?: string; commentId?: string }
export interface Lease { isolated?: boolean; identity?: WorkerIdentity; token: string; owner: string; pid: number; role: Role; revision: number; commentOnly?: boolean }
export interface TaskLink { targetId: string; type: 'depends-on' | 'completed-before' | 'completed-after'; blocking: boolean }
export interface SubtaskProposal { parentId: string; title: string; scope: string; reason: string; expectedResult: string; relationship: TaskLink }
export interface Task {
  id: string; title: string; scope: string; assignee: string; testerAgent: string; reviewerAgent: string;
  column: Column; phase: Role; revision: number; userPaused?: boolean; rubric: Criterion[]; evaluations: Partial<Record<Role, Evaluation>>;
  tests: TestEvidence[]; comments: Comment[]; history: Audit[]; archived: boolean; createdAt: string; updatedAt: string;
  disposition?: { kind: "cancelled"; reason: string; actor: "user" | "orchestrator"; at: string };
  parentId?: string; links?: TaskLink[]; bestPractices?: string; proposal?: { reason: string; expectedResult: string; approved?: boolean };
  suspension?: { dependencyIds: string[]; column: Column; phase: Role; at: string; notified?: boolean };
  prMode: "none" | "review" | "merge"; mergeApproved: boolean;
  pr?: { number: number; url: string; branch: string; completed: boolean; synced: boolean };
  workers?: Partial<Record<Role, WorkerIdentity>>; workerStatus?: WorkerStatus;
  snapshot?: { revision: number; manifest: string }; lastDispatchedAt?: string;
  queue?: { state: "capacity" | "lease" | "conflict"; reason: string; dependencyId?: string; limit?: number; running?: number };
  workspace?: string; fingerprint?: string; lease?: Lease; executionLease?: Lease; repliedThrough?: string; runs: number; maxRuns: number; blocked?: string;
}
export interface Board { version: 1; id: string; name: string; projectPath: string; sequence: number; tasks: Task[]; activity?: Activity[] }
export interface NewTask {
  title: string; scope: string; assignee: string; rubric: Criterion[]; testerAgent?: string; reviewerAgent?: string;
  prMode?: Task["prMode"]; maxRuns?: number; bestPractices?: string;
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
export class KanbanBoardBusyError extends Error {
  constructor() {
    super("Kanban board is busy; retry the operation");
    this.name = "KanbanBoardBusyError";
  }
}
export class KanbanStore {
  readonly directory: string;
  readonly file: string;
  readonly identity: ReturnType<typeof projectIdentity>;
  constructor(cwd: string, readonly stateRoot: string) {
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
    for (const t of b.tasks) {
      t.history.forEach((e, i) => { e.id ??= `legacy:${t.id}:${i}`; e.durationMs ??= null; e.delayMs ??= i ? Math.max(0, Date.parse(e.at) - Date.parse(t.history[i - 1].at)) : null; });
      for (const c of t.comments) { c.details ??= c.text; c.summary ??= c.text.split(/\r?\n/)[0].slice(0, 240); }
      if (t.workerStatus && !t.lease && !t.suspension && ["working", "thinking", "waiting_dependency"].includes(t.workerStatus.state)) {
        t.workerStatus = { ...t.workerStatus, state: t.blocked ? "error" : "idle", reason: t.blocked ?? "No active worker lease", since: t.updatedAt, updatedAt: t.updatedAt };
      }
    }
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
      } catch (e) {
        const info = statSync(lock, { throwIfNoEntry: false });
        if ((info && !info.isDirectory()) || (!info && !existsSync(this.directory))) throw e;
        stale = info !== undefined && Date.now() - info.mtimeMs > 30000;
      }
      if (!stale) throw new KanbanBoardBusyError();
      try {
        rmSync(lock, { recursive: true });
        mkdirSync(lock);
      } catch (e) {
        // Another process may release or reclaim the lock during stale recovery.
        const code = (e as NodeJS.ErrnoException).code;
        if (code === "EEXIST" || (code === "ENOENT" && existsSync(this.directory))) throw new KanbanBoardBusyError();
        throw e;
      }
    }
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    try {
      writeFileSync(join(lock, "pid"), String(process.pid));
      const board = this.read();
      const before = new Map(board.tasks.map(t => [t.id, { json: JSON.stringify(t), history: t.history.length }]));
      const started = performance.now();
      const result = mutate(board);
      this.reconcileDependencies(board);
      const duration = Math.max(0, performance.now() - started);
      for (const t of board.tasks) {
        const prior = before.get(t.id);
        if (prior && prior.json !== JSON.stringify(t) && prior.history === t.history.length) this.audit(t, "system", "task updated");
        for (const e of t.history.slice(prior?.history ?? 0)) e.mutationDurationMs = duration;
      }
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
  audit(t: Task, actor: string, event: string, data?: unknown, durationMs: number | null = null, worker?: WorkerIdentity) {
    const previous = t.history.at(-1);
    const identity = worker ?? t.workers?.[actor as Role] ?? Object.values(t.workers ?? {}).find(w => w?.name === actor);
    t.updatedAt = new Date(Math.max(Date.now(), Date.parse(t.updatedAt) + 1)).toISOString();
    t.history.push({ id: randomUUID(), at: t.updatedAt, actor: identity?.name ?? actor, identity, event, data, durationMs, delayMs: previous ? Math.max(0, Date.parse(t.updatedAt) - Date.parse(previous.at)) : null });
  }
  workerIdentity(b: Board, t: Task, role: Role): WorkerIdentity {
    t.workers ??= {};
    const definition = role === "tester" ? t.testerAgent : role === "reviewer" ? t.reviewerAgent : t.assignee;
    if (t.workers[role]?.definition === definition) return t.workers[role]!;
    const names = "Ada Ben Cleo Dean Eva Finn Gia Hugo Iris Jude Kai Lena Milo Nora Omar Pia Quinn Rosa Seth Tara Uma Vera Wade Xena Yara Zane Abel Alma Anya Arlo Axel Beau Bram Bree Bryn Cara Cora Dana Dario Dora Eden Elsa Enid Eric Esme Etta Faye Fern Flora Fred Gail Gino Glen Greta Gus Hana Hank Hazel Hope Hugh Ian Ida Inez Ivan Jack Jade Jane Jaya Jean Joel Joan Jodi Joey June Kian Kira Kit Knox Lana Lara Leah Leon Levi Liam Lila Lina Lisa Lois Lola Luca Luis Luna Lyra Mae Mara Marc Maya Mia Mina Mira Mona Nate Neal Nell Nia Nico Nina Noel Nova Owen Otto Orla Oona Paco Paul Pearl Petra Phil Piers Rami Raul Reed Remy Rene Rhea Rick Rita Rob Rory Rose Ross Ruby Ruth Ryan Sage Sam Sara Sean Shay Sid Skye Stan Stella Tess Theo Tia Tina Toby Tom Tony Troy Una Uri Val Veda Vito Walt Willa Will Wren Wynn Yale Zara Zeke Zoe Aidan Alice Amber Amy Andre Andy Anita Anne Anton April Ariel Ash Barry Basil Bella Blair Blake Bonnie Boris Brian Brock Bruce Caleb Calvin Cam Casey Cecil Chad Chase Clara Clark Cody Cole Colin Craig Cyrus Dale Damon David Dawn Demi Denis Derek Devon Diane Diego Donna Drew Dylan Edith Elena Eli Ellen Elmer Elora Emily Emre Erin Ethan Felix Fiona Flynn Frank Freya Gavin Grace Grant Gwen Harry Heath Heidi Helen Holly Ilan Indy Isaac Isla Jacob James Jared Jason Jenna Jesse Jonah Jonas Josie Joyce Julia Julie Kade Kara Kate Keith Kelly Kerry Kevin Koby Kyle Lance Larry Laura Layla Lee Lewis Linda Logan Lorne Louis Lucie Lydia Mabel Margo Marie Mario Mark Marta Mason Matt Max Megan Micah Miles Molly Naomi Neil Niles Olive Oscar Paige Perry Peter Ralph Ravi Rhys Robin Ronan Rowan Sadie Sally Sasha Scott Shane Shawn Sia Simon Sonia Sophie Steve Susan Sylvie Talia Tessa Tim Tyler Vince Viola Wendy Wes Wilma Yuki Zora".split(" ");
    const lock = join(this.stateRoot, "names.lock"), file = join(this.stateRoot, "worker-names.json");
    try { mkdirSync(lock); } catch {
      let stale = false;
      try { const pid = Number(readFileSync(join(lock, "pid"), "utf8")); if (!Number.isInteger(pid) || pid < 1) throw new Error("Invalid lock owner"); try { process.kill(pid, 0); } catch (e) { stale = (e as NodeJS.ErrnoException).code === "ESRCH"; } } catch { stale = Date.now() - statSync(lock).mtimeMs > 30000; }
      if (!stale) throw new Error("Worker name allocator busy; retry claim");
      rmSync(lock, { recursive: true }); mkdirSync(lock);
    }
    try {
      writeFileSync(join(lock, "pid"), String(process.pid));
      const reserved: Record<string, string> = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
      const used = new Set([...Object.keys(reserved), ...b.tasks.flatMap(task => Object.values(task.workers ?? {}).map(w => w?.name))]);
      // Import names from boards created before the global reservation registry existed.
      for (const entry of readdirSync(this.stateRoot, { withFileTypes: true })) {
        const boardFile = join(this.stateRoot, entry.name, "board.json");
        if (!entry.isDirectory() || !existsSync(boardFile)) continue;
        const other = JSON.parse(readFileSync(boardFile, "utf8")) as Board;
        for (const task of other.tasks) for (const worker of Object.values(task.workers ?? {})) if (worker) used.add(worker.name);
      }
      // Preserve short first names; extend with a permanent numeric discriminator after catalog exhaustion.
      let name = names.find(candidate => !used.has(candidate));
      for (let suffix = 2; !name; suffix++) name = names.map(base => `${base}-${suffix}`).find(candidate => !used.has(candidate));
      const identity = { id: randomUUID(), name, role, definition };
      reserved[name] = identity.id;
      const temporary = `${file}.${randomUUID()}.tmp`;
      try { writeFileSync(temporary, JSON.stringify(reserved), { mode: 0o600 }); renameSync(temporary, file); } finally { rmSync(temporary, { force: true }); }
      t.workers[role] = identity;
      return identity;
    } finally { rmSync(lock, { recursive: true, force: true }); }
  }
  status(t: Task, identity: WorkerIdentity, state: WorkerState, reason: string, dependencyId?: string) {
    const at = now();
    t.workerStatus = { identity, state, reason, dependencyId, since: t.workerStatus?.state === state && t.workerStatus.reason === reason ? t.workerStatus.since : at, updatedAt: at };
  }
  activity(board = this.read()): Activity[] {
    return board.tasks.flatMap(t => t.history.map(e => {
      const comment = e.event === "comment" ? e.data as Comment | undefined : undefined;
      const summary = comment?.summary?.slice(0, 500).replace(/(Bearer\s+|(?:api[_-]?key|token|password|secret)\s*[:=]\s*)\S+/gi, "$1[redacted]");
      return { ...e, data: undefined, taskId: t.id, summary, commentId: comment?.id };
    }))
      .sort((a, b) => b.at.localeCompare(a.at) || (b.id ?? "").localeCompare(a.id ?? "")).slice(0, 200);
  }
  observe(id: string, lease: Lease, event: string, durationMs: number | null = null, state?: WorkerState, reason = event, observation?: { id: string; at: string }) {
    this.change(b => {
      const t = this.task(b, id);
      if (observation && t.history.some(e => e.id === observation.id)) return;
      const active = t.lease?.token === lease.token && !t.archived && t.column !== "backlog" && (t.column !== "done" || !!lease.commentOnly);
      if (!active && !lease.identity) return;
      if (state && active) this.status(t, lease.identity ?? this.workerIdentity(b, t, lease.role), state, reason);
      this.audit(t, lease.role, event, undefined, durationMs, lease.identity);
      if (observation) {
        const entry = t.history.at(-1)!;
        entry.id = observation.id;
        entry.at = observation.at;
        const previous = t.history.at(-2);
        entry.delayMs = previous ? Math.max(0, Date.parse(entry.at) - Date.parse(previous.at)) : null;
      }
    });
  }
  assertImplementation(t: Task, lease: Lease) {
    this.assertActive(t, lease);
    if (lease.commentOnly || lease.role !== 'operator' || lease.identity?.definition !== t.assignee || t.workers?.operator?.id !== lease.identity?.id || t.lease?.owner !== lease.owner) throw new Error('Only the assigned execution owner with an active operator lease may implement artifact scope; propose a linked sub-task for another owner');
  }
  assertActive(t: Task, lease: Lease) {
    if (t.suspension || t.disposition?.kind === "cancelled" || t.archived || t.column === "backlog" || (t.column === "done" && !lease.commentOnly) || t.lease?.token !== lease.token || t.revision !== lease.revision || t.phase !== lease.role) throw new Error("Task is paused, archived, completed, reassigned, or this run is stale. Stop work.");
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
        rubric: validateRubric(input.rubric), bestPractices: input.bestPractices, column: "backlog", phase: "operator", revision: 1,
        evaluations: {}, tests: [], comments: [], history: [], archived: false, createdAt: now(), updatedAt: now(),
        prMode, mergeApproved: false, runs: 0, maxRuns,
      };
      this.audit(task, actor, "created", input);
      b.tasks.push(task);
      return task;
    });
  }
  accepted(t: Task): boolean {
    return t.column === 'done' && !t.disposition && !!t.fingerprint && ['tester','reviewer','orchestrator'].every(role => { const e = t.evaluations[role as Role]; return e && e.total >= 85 && e.revision === t.revision && e.fingerprint === t.fingerprint; }) && t.tests.length > 0 && t.tests.every(e => e.exitCode === 0 && e.fingerprint === t.fingerprint);
  }
  prerequisites(b: Board, t: Task): string[] {
    const ids = (t.links ?? []).filter(l => l.blocking && l.type !== 'completed-before').map(l => l.targetId);
    for (const other of b.tasks) if (other.links?.some(l => l.blocking && l.type === 'completed-before' && l.targetId === t.id)) ids.push(other.id);
    return [...new Set(ids)];
  }
  private validateLinks(b: Board) {
    for (const t of b.tasks) {
      if (t.parentId && (t.parentId === t.id || !b.tasks.some(p => p.id === t.parentId))) throw new Error('Invalid parent reference');
      for (const l of t.links ?? []) if (!['depends-on','completed-before','completed-after'].includes(l.type) || typeof l.blocking !== 'boolean' || l.targetId === t.id || !b.tasks.some(p => p.id === l.targetId)) throw new Error('Invalid directional relationship reference');
    }
    const visiting = new Set<string>(), visited = new Set<string>();
    const visit = (t: Task) => { if (visiting.has(t.id)) throw new Error('Dependency cycle'); if (visited.has(t.id)) return; visiting.add(t.id); for (const id of this.prerequisites(b,t)) visit(this.task(b,id)); visiting.delete(t.id); visited.add(t.id); };
    for (const t of b.tasks) visit(t);
  }
  link(id: string, links: TaskLink[], actor: string) {
    if (actor !== 'orchestrator') throw new Error('Only orchestrator may configure relationships');
    return this.change(b => { const t = this.task(b,id); if (t.archived || t.disposition || t.column === 'done') throw new Error('Terminal tasks cannot change dependencies'); t.links = links; this.validateLinks(b); this.audit(t, actor, 'directional relationships configured', links); this.reconcileDependencies(b); return t; });
  }
  propose(id: string, lease: Lease, input: SubtaskProposal): Task {
    return this.change(b => {
      const parent = this.task(b,id); this.assertActive(parent,lease);
      if (lease.commentOnly) throw new Error('Comment-only runs cannot propose implementation work');
      if (b.tasks.length >= 10000) throw new Error('Board has 10000 tasks; export history before adding more');
      if (input.parentId !== id || input.relationship.targetId !== id) throw new Error('Proposal must explicitly link back to its assigned parent');
      text(input.reason, 'Proposal reason'); text(input.expectedResult, 'Expected result');
      const child: Task = { id: randomUUID(), title: text(input.title,'Title',200), scope: text(input.scope,'Bounded scope'), assignee: '', testerAgent: 'operate', reviewerAgent: 'operate', rubric: [], column: 'backlog', phase: 'operator', revision: 1, evaluations: {}, tests: [], comments: [], history: [], archived: false, createdAt: now(), updatedAt: now(), prMode: 'none', mergeApproved: false, runs: 0, maxRuns: 12, parentId: id, links: [input.relationship], proposal: { reason: input.reason, expectedResult: input.expectedResult } };
      b.tasks.push(child); this.validateLinks(b); this.audit(child,lease.role,'linked sub-task proposed; orchestrator assignment required',input); this.appendComment(parent,{summary: 'Linked sub-task proposed: '+child.id, details: JSON.stringify(input)},lease.role); this.reconcileDependencies(b); return child;
    });
  }
  reconcileDependencies(b: Board) {
    for (const t of b.tasks) {
      if (t.archived || t.disposition || t.column === 'done' || t.column === 'backlog') continue;
      const pending = this.prerequisites(b,t).filter(id => !this.accepted(this.task(b,id)));
      if (pending.length && !t.suspension) {
        t.suspension = { dependencyIds: pending, column: t.column, phase: t.phase, at: now() };
        t.lease = undefined; t.queue = undefined;
        if (t.workerStatus) this.status(t,t.workerStatus.identity,'waiting_dependency','Suspended for accepted prerequisites',pending[0]);
        this.audit(t,'system','dependency checkpoint suspended',t.suspension);
      } else if (pending.length && t.suspension && (t.suspension.notified || JSON.stringify(t.suspension.dependencyIds) !== JSON.stringify(pending))) {
        t.suspension.dependencyIds = pending; t.suspension.notified = false;
        this.audit(t,'system','dependency checkpoint prerequisites updated',pending);
      } else if (!pending.length && t.suspension && !t.suspension.notified) {
        t.suspension.notified = true; this.appendComment(t,'Required sub-tasks are accepted Done. Orchestrator must explicitly continue this eligible checkpoint; no automatic restart.','orchestrator');
        this.audit(t,'system','dependency checkpoint eligible for orchestrator continuation');
      }
    }
  }
  reset(t: Task) {
    t.revision++; t.phase = "operator"; t.evaluations = {}; t.tests = []; t.fingerprint = undefined;
    if (t.pr) { t.pr.completed = false; t.pr.synced = false; }
    if (t.workerStatus) this.status(t, t.workerStatus.identity, "idle", "Task reset; active work cancelled");
    t.lease = undefined; t.blocked = undefined; t.queue = undefined; t.mergeApproved = false; t.suspension = undefined;
  }
  pauseAll(actor: string) {
    return this.change(b => {
      for (const t of b.tasks) {
        if (t.archived || t.column === "done") continue;
        if (t.column !== "backlog") { this.reset(t); t.column = "backlog"; }
        if (actor === "user") t.userPaused = true;
        this.audit(t, actor, "paused with all harness work");
      }
    });
  }
  move(id: string, column: Column, actor: string, expectedUpdatedAt?: string) {
    return this.change(b => {
      const t = this.task(b, id);
      if (expectedUpdatedAt && t.updatedAt !== expectedUpdatedAt) throw new Error("Task changed; reopen before modifying it");
      if (t.disposition?.kind === "cancelled") throw new Error("Cancelled tasks are terminal; create a new task to authorize new work");
      if (t.archived) throw new Error("Archived tasks cannot be resumed");
      if (column === 'ready' && t.suspension) {
        if (actor !== 'orchestrator') throw new Error('Only the orchestrator may explicitly continue a dependency checkpoint');
        const pending = this.prerequisites(b, t).filter(id => !this.accepted(this.task(b, id)));
        if (pending.length || t.userPaused || t.executionLease) throw new Error('Dependencies must be accepted Done and worker drained; manually paused checkpoints cannot resume');
        const continuation = t.suspension;
        if (t.snapshot && !t.workspace) throw new Error('Retained parent checkpoint is missing; cannot continue against another source');
        if (t.snapshot && t.workspace) {
          const ids = new Set<string>();
          const visit = (task: Task) => { for (const dep of this.prerequisites(b, task)) if (!ids.has(dep)) { ids.add(dep); visit(this.task(b, dep)); } };
          visit(t);
          const dependencies = [...ids].map(id => this.task(b, id)).filter(dep => dep.snapshot).map(dep => {
            if (!dep.workspace || !dep.fingerprint) throw new Error('Accepted dependency checkpoint is missing; cannot reconcile');
            return { workspace: dep.workspace, manifest: dep.snapshot!.manifest, fingerprint: dep.fingerprint };
          });
          const reconciled = reconcileSnapshot(this.identity.projectPath, t.workspace, t.snapshot.manifest, dependencies);
          if (reconciled) {
            this.audit(t, actor, 'accepted dependency results reconciled; previous checkpoint and evidence retained', { previous: { workspace: t.workspace, snapshot: t.snapshot, revision: t.revision, fingerprint: t.fingerprint, tests: t.tests, evaluations: t.evaluations }, ...reconciled });
            t.workspace = reconciled.workspace; t.revision++; t.snapshot = { revision: t.revision, manifest: reconciled.manifest };
            t.tests = []; t.evaluations = {}; t.fingerprint = undefined; continuation.column = 'in progress'; continuation.phase = 'operator';
          }
        }
        t.column = continuation.column; t.phase = continuation.phase; t.suspension = undefined; t.blocked = undefined; t.queue = undefined;
        this.audit(t, actor, 'dependency checkpoint explicitly continued'); return t;
      }
      if (column === 'ready' && t.proposal && (actor !== 'orchestrator' || !t.proposal.approved)) throw new Error('Only the orchestrator may assign rubric, best practices and owner and release a proposed sub-task');
      if (column === 'ready' && this.prerequisites(b, t).some(id => !this.accepted(this.task(b, id)))) throw new Error('Blocking prerequisites require accepted Done');
      if (column === "ready" && t.userPaused && actor !== "user") throw new Error("Only the user may release a task they paused in backlog");
      if (column === "backlog") { this.reset(t); t.column = column; if (actor === "user") t.userPaused = true; }
      else if (column === "ready" && t.blocked && !t.lease && !t.executionLease && t.column !== "done") { validateRubric(t.rubric); t.blocked = undefined; t.queue = undefined; t.userPaused = false; }
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
      if (t.proposal && actor !== 'orchestrator') throw new Error('Only the orchestrator may assign and refine a proposed sub-task');
      t.assignee = text(input.assignee, "Assigned agent", 100); t.rubric = validateRubric(input.rubric);
      t.bestPractices = input.bestPractices === undefined ? t.bestPractices : text(input.bestPractices, 'Best practices');
      if (t.proposal) { if (!t.bestPractices) throw new Error('Assign applicable best practices before releasing a proposed sub-task'); t.proposal.approved = true; }
      t.testerAgent = text(input.testerAgent ?? t.testerAgent, "Tester agent", 100);
      t.reviewerAgent = text(input.reviewerAgent ?? t.reviewerAgent, "Reviewer agent", 100);
      if (input.prMode !== undefined && input.prMode !== t.prMode) throw new Error("PR policy cannot change on an existing task; create a new task instead");
      this.reset(t); this.audit(t, actor, "scope/assignment/rubric edited", input);
      return t;
    });
  }
  private appendComment(t: Task, message: string | { summary: string; details: string }, actor: string) {
    const details = typeof message === "string" ? message : message.details;
    text(details, "Comment details", 200000);
    const summary = typeof message === "string" ? details.split(/\r?\n/)[0].slice(0, 240) : text(message.summary, "Comment summary", 500);
    const identity = t.workers?.[actor as Role];
    const c = { id: randomUUID(), author: identity?.name ?? actor, identity, text: details, summary, details, at: now() };
    t.comments.push(c); this.audit(t, actor, "comment", c);
  }
  comment(id: string, message: string | { summary: string; details: string }, actor: string, expectedUpdatedAt?: string) {
    return this.change(b => {
      const t = this.task(b, id);
      if (expectedUpdatedAt && t.updatedAt !== expectedUpdatedAt) throw new Error("Task changed; retry your comment");
      this.appendComment(t, message, actor);
      return t;
    });
  }
  cancel(id: string, reason: string, actor: string, expectedUpdatedAt?: string) {
    if (actor !== "user" && actor !== "orchestrator") throw new Error("Only the user or orchestrator may explicitly cancel a task; workers cannot cancel tasks");
    const explanation = text(reason, "Cancellation reason");
    return this.change(b => {
      const t = this.task(b, id);
      if (expectedUpdatedAt && t.updatedAt !== expectedUpdatedAt) throw new Error("Task changed; reopen before cancelling it");
      if (t.disposition?.kind === "cancelled") return t;
      if (t.archived || t.column === "done") throw new Error("Only unfinished, unarchived tasks can be cancelled; accepted completion cannot be relabelled");
      const previous = { column: t.column, phase: t.phase, revision: t.revision, lease: t.lease };
      t.disposition = { kind: "cancelled", reason: explanation, actor, at: now() };
      // Revoke capabilities, not evidence or the execution fence: in-flight work must still drain.
      t.column = "done"; t.lease = undefined; t.queue = undefined; t.mergeApproved = false;
      if (t.workerStatus) this.status(t, t.workerStatus.identity, "finished", `Cancelled without acceptance: ${explanation}`);
      this.audit(t, actor, "cancelled without acceptance", { ...t.disposition, previous });
      return t;
    });
  }
  archive(id: string, actor: string, expectedUpdatedAt?: string) {
    return this.change(b => {
      const t = this.task(b, id);
      if (expectedUpdatedAt && t.updatedAt !== expectedUpdatedAt) throw new Error("Task changed; reopen before archiving it");
      if (t.column !== "done" && !t.archived) throw new Error("Only Done tasks can be archived; use Pause in Backlog to cancel active work");
      if (t.archived) return t;
      t.archived = true; t.lease = undefined;
      if (t.workerStatus) this.status(t, t.workerStatus.identity, "finished", "Task archived");
      this.audit(t, actor, "archived; future work cancelled");
      return t;
    });
  }
  archiveDone(actor: string) {
    return this.change(b => {
      const tasks = b.tasks.filter(t => !t.archived);
      if (!tasks.length || tasks.some(t => t.column !== "done")) throw new Error("Archive all done is available only when every active task is done");
      for (const t of tasks) { t.archived = true; t.lease = undefined; if (t.workerStatus) this.status(t, t.workerStatus.identity, "finished", "Task archived"); this.audit(t, actor, "archived completed scope"); }
    });
  }
  claim(id: string, owner: string, commentOnly = false, isolated = false, capacity?: number): Lease {
    return this.change(b => {
      const t = this.task(b, id);
      if (t.suspension || this.prerequisites(b, t).some(id => !this.accepted(this.task(b, id)))) throw new Error('Task suspended pending accepted dependencies; orchestrator continuation required');
      if (t.proposal && !t.proposal.approved) throw new Error('Proposed sub-task requires orchestrator assignment and release');
      if (t.disposition?.kind === "cancelled" || t.archived || t.column === "backlog" || (!commentOnly && (!["ready", "in progress", "review"].includes(t.column) || t.phase === "orchestrator" || t.blocked))) throw new Error("Task is not dispatchable");
      if (commentOnly && (!t.comments.some(c => c.author === "user") || t.comments.filter(c => c.author === "user").at(-1)?.id === t.repliedThrough)) throw new Error("No unanswered user comment");
      // A handoff revokes tools immediately, but in-flight commands must drain before another role reuses the snapshot.
      if (t.executionLease) {
        let alive = true;
        try { process.kill(t.executionLease.pid, 0); } catch (e) { alive = (e as NodeJS.ErrnoException).code !== "ESRCH"; }
        if (alive) throw new Error(`Snapshot worker is still draining; dependency: ${t.id} in Pi process ${t.executionLease.pid}`);
        t.executionLease = undefined;
      }
      const sharedOwner = b.tasks.find(other => other.id !== id && other.prMode === "none" && !other.archived && !other.snapshot && !other.lease?.isolated && (other.lease || (other.runs > 0 && ["ready", "in progress", "review"].includes(other.column))));
      if (t.prMode === "none" && !commentOnly && sharedOwner) throw new Error(`Another task owns the shared working tree; dependency: ${sharedOwner.id}`);
      if (t.prMode === "none" && !commentOnly && !isolated && b.tasks.some(other => other.id !== id && other.lease && !other.lease.commentOnly)) throw new Error("Another task owns the shared working tree");
      if (capacity !== undefined && b.tasks.filter(other => {
        const execution = other.executionLease ?? other.lease;
        if (other.id === id || !execution) return false;
        try { process.kill(execution.pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code !== "ESRCH"; }
      }).length >= capacity) throw new Error(`Kanban lease capacity ${capacity} is occupied across Pi processes`);
      if (t.lease) {
        let alive = true;
        try { process.kill(t.lease.pid, 0); } catch (e) { alive = (e as NodeJS.ErrnoException).code !== "ESRCH"; }
        if (alive) throw new Error("Task already has a worker");
        this.audit(t, "system", "recovered stale worker lease");
      }
      if (t.runs >= t.maxRuns) { throw new Error("Agent run budget exhausted; move to backlog then ready to authorize another budget"); }
      const lease: Lease = { token: randomUUID(), owner, pid: process.pid, role: t.phase, revision: t.revision, commentOnly, isolated };
      lease.identity = this.workerIdentity(b, t, lease.role);
      this.status(t, lease.identity, "working", "Worker claimed task");
      if (isolated) t.executionLease = lease;
      t.lease = lease; t.runs++; t.lastDispatchedAt = now(); t.queue = undefined; if (t.phase === "operator" && !commentOnly) t.column = "in progress";
      this.audit(t, t.phase, "worker claimed task", { role: lease.role, run: t.runs });
      return lease;
    });
  }
  release(id: string, lease: Lease, error?: string, drained = false, unusedRun = false) {
    return this.change(b => {
      const t = this.task(b, id);
      if (drained && t.executionLease?.token === lease.token) { t.executionLease = undefined; this.audit(t, lease.role, "snapshot worker drained"); }
      if (t.lease?.token !== lease.token) return;
      if (unusedRun) {
        t.runs = Math.max(0, t.runs - 1);
        this.audit(t, "system", "unused worker run returned", { token: lease.token });
      }
      this.status(t, this.workerIdentity(b, t, lease.role), error ? "error" : "finished", error ?? "Worker finished");
      t.lease = undefined;
      this.audit(t, lease.role, "worker released");
      if (error) { t.blocked = error; this.audit(t, lease.role, "worker stopped", error); }
    });
  }
  recordTests(id: string, lease: Lease, evidence: TestEvidence) {
    return this.change(b => {
      const t = this.task(b, id); this.assertActive(t, lease);
      if (lease.role !== "tester") throw new Error("Only the tester can record test executions");
      // Keep every attempt in history; current evidence is the latest run of each exact command.
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
      const e: Evaluation = { role, actor: lease?.identity?.name ?? actor, revision: t.revision, scores, total, notes: text(notes, "Detailed evaluation/fix instructions"), fingerprint, at: now() };
      if (t.fingerprint !== fingerprint) throw new Error("Work changed since submission. Return the task to backlog and retest the new revision.");
      if (role === "tester" && (!t.tests.length || t.tests.some(e => e.fingerprint !== fingerprint || (total >= 85 && e.exitCode !== 0)))) throw new Error("Tester must execute passing tests against the submitted revision before scoring. Rerun each failed command exactly after correcting its cause; a different or filtered command does not supersede it. Historical attempts remain in the audit history.");
      t.evaluations[role] = e; this.audit(t, lease?.identity?.name ?? actor, "rubric evaluation", e, null, lease?.identity);
      this.appendComment(t, `${total.toFixed(2)}%: ${e.notes}`, role);
      if (total < 85) { this.reset(t); if (t.snapshot) t.snapshot.revision = t.revision; t.column = "ready"; }
      return t;
    });
  }
  handoff(id: string, lease: Lease, summary: string, fingerprint: string) {
    return this.change(b => {
      const t = this.task(b, id); this.assertActive(t, lease);
      text(summary, "Handoff summary");
      t.repliedThrough = t.comments.filter(c => c.author === "user").at(-1)?.id;
      if (lease.commentOnly) { this.status(t, this.workerIdentity(b, t, lease.role), "finished", "Comment response completed"); t.lease = undefined; this.audit(t, lease.role, "comment response completed", summary); return t; }
      if (lease.role === "operator") {
        t.column = "review"; t.phase = "tester"; t.fingerprint = fingerprint;
      } else {
        if (fingerprint !== t.fingerprint || !t.evaluations[lease.role] || (t.evaluations[lease.role]?.total ?? 0) < 85) throw new Error("A current rubric score of at least 85% is required before handoff");
        if (t.prMode !== "none" && (!t.pr || (lease.role === "reviewer" && !t.pr.completed))) throw new Error("Complete this role's PR stage before handing off");
        t.phase = lease.role === "tester" ? "reviewer" : "orchestrator";
      }
      this.status(t, this.workerIdentity(b, t, lease.role), "finished", "Handoff completed");
      t.lease = undefined; this.audit(t, lease.role, "handoff", summary);
      this.appendComment(t, summary, lease.role);
      return t;
    });
  }
  complete(id: string, fingerprint: string, integrate?: (task: Task) => void) {
    return this.change(b => {
      const t = this.task(b, id);
      if (t.suspension || this.prerequisites(b,t).some(id => !this.accepted(this.task(b,id))) || t.archived || t.phase !== "orchestrator" || t.column !== "review" || t.fingerprint !== fingerprint) throw new Error("Task is not ready for completion");
      for (const role of ["orchestrator", "tester", "reviewer"] as const) {
        const e = t.evaluations[role];
        if (!e || e.revision !== t.revision || e.fingerprint !== fingerprint || e.total < 85) throw new Error(`${role} must score this revision at least 85%`);
      }
      if (!t.tests.length || t.tests.some(e => e.exitCode !== 0 || e.fingerprint !== fingerprint)) throw new Error("Passing current-revision test evidence required");
      if (t.prMode !== "none" && (!t.pr?.completed || !t.pr.synced)) throw new Error("PR review/merge and all three rubric evaluations must be recorded on the PR");
      if (t.snapshot) {
        if (t.executionLease) throw new Error(`Snapshot worker is still draining; dependency: ${t.id}`);
        if (!integrate) throw new Error("Isolated source must be conflict-checked and integrated before completion");
        integrate(t);
      }
      t.column = "done"; t.lease = undefined; t.queue = undefined; this.audit(t, "orchestrator", "completion gates passed");
      return t;
    });
  }
}

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sourceFingerprint } from '../src/kanban/execution.js';
import { createSnapshot, integrateSnapshot } from '../src/kanban/snapshot.js';
import { KanbanStore, type Task } from '../src/kanban/store.js';

let root: string, project: string, store: KanbanStore, accepted: Task, parent: Task;
const git = (...args: string[]) => execFileSync('git', args, { cwd: project, stdio: 'pipe' });
const current = (t: Task) => store.task(store.read(), t.id);
function task(title: string) { return store.create({ title, scope: title, assignee: 'operate', rubric: [{ title: 'Correctness', weight: 100 }] }, 'orchestrator'); }
function checkpoint(t: Task) {
  const workspace = join(store.directory, t.id), manifest = `${workspace}.json`;
  createSnapshot(project, workspace, manifest);
  store.change(b => { Object.assign(store.task(b, t.id), { workspace, snapshot: { revision: 1, manifest } }); });
  return current(t);
}
// Test-only evidence fixture, not production acceptance or board mutation.
function assessed(t: Task) {
  const fingerprint = sourceFingerprint(t.workspace!);
  store.change(b => {
    const x = store.task(b, t.id); Object.assign(x, { column: 'review', phase: 'orchestrator', fingerprint });
    x.tests = [{ command: 'fixture', exitCode: 0, output: 'fixture pass', fingerprint, at: new Date().toISOString() }];
    for (const role of ['tester', 'reviewer', 'orchestrator'] as const) x.evaluations[role] = { role, actor: role, revision: 1, scores: [95], total: 95, notes: 'fixture', fingerprint, at: new Date().toISOString() };
  });
  return current(t);
}
function complete(t: Task, hook?: () => void) {
  return store.complete(t.id, t.fingerprint!, x => {
    const paths = integrateSnapshot(project, x.workspace!, x.snapshot!.manifest, x.fingerprint!, hook);
    store.audit(x, 'system', 'tested source integrated without changing caller Git index or branch', { paths, fingerprint: x.fingerprint });
  });
}
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'kanban-provenance-')); project = join(root, 'project'); mkdirSync(project);
  writeFileSync(join(project, 'app.ts'), 'original'); writeFileSync(join(project, 'other.ts'), 'unrelated');
  git('init', '--quiet'); git('add', '.'); git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '-m', 'fixture');
  store = new KanbanStore(project, join(root, 'state'));
  accepted = checkpoint(task('renderer')); writeFileSync(join(accepted.workspace!, 'app.ts'), 'accepted renderer'); accepted = assessed(accepted); complete(accepted); accepted = current(accepted);
  parent = checkpoint(task('correction')); writeFileSync(join(parent.workspace!, 'app.ts'), 'renderer plus correction'); parent = assessed(parent);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));
describe('accepted integration provenance', () => {
  it('integrates exact accepted dirty baseline and retains manifest, audit and original inode journal', () => {
    const manifest = readFileSync(parent.snapshot!.manifest), index = readFileSync(join(project, '.git/index'));
    let recovery = '';
    store.complete(parent.id, parent.fingerprint!, t => integrateSnapshot(project, t.workspace!, t.snapshot!.manifest, t.fingerprint!, path => { recovery = path; store.audit(t, 'system', 'integration recovery journal retained', { recovery: path }); }));
    expect(readFileSync(join(project, 'app.ts'), 'utf8')).toBe('renderer plus correction');
    expect(readFileSync(join(project, 'other.ts'), 'utf8')).toBe('unrelated');
    expect(readFileSync(parent.snapshot!.manifest)).toEqual(manifest); expect(readFileSync(join(project, '.git/index'))).toEqual(index);
    const journal = JSON.parse(readFileSync(join(recovery, 'recovery.json'), 'utf8'));
    expect(journal.provenance[0]).toMatchObject({ path: 'app.ts', provenance: { taskId: accepted.id, fingerprint: accepted.fingerprint, revision: 1 } });
    expect(readFileSync(journal.plan[0].original, 'utf8')).toBe('accepted renderer');
    expect(current(parent).history.find(e => e.event === 'integration recovery journal retained')?.data).toEqual({ recovery });
    expect(current(parent).history.some(e => e.event === 'completion gates passed')).toBe(true);
    expect(current(accepted).history).toEqual(accepted.history);
  });
  it('requires exact board-bound checkpoint and retains protection after a failed attempt', () => {
    const detached = join(root, 'detached.json'); writeFileSync(detached, readFileSync(parent.snapshot!.manifest));
    expect(() => integrateSnapshot(project, parent.workspace!, detached, parent.fingerprint!)).toThrow(/protected/);
    expect(() => complete(parent, () => { throw new Error('injected'); })).toThrow(/injected/);
    expect(current(parent).column).toBe('review');
  });
  it.each(['unaccepted', 'cancelled', 'stale evidence', 'missing publication', 'wrong publication fingerprint', 'wrong path', 'stale source'])('rejects %s provenance', variant => {
    if (variant === 'stale source') writeFileSync(join(accepted.workspace!, 'app.ts'), 'tampered');
    else store.change(b => {
      const t = store.task(b, accepted.id);
      if (variant === 'unaccepted') t.column = 'review';
      if (variant === 'cancelled') t.disposition = { kind: 'cancelled', actor: 'user', at: '', reason: 'fixture' };
      if (variant === 'stale evidence') t.evaluations.reviewer!.fingerprint = 'stale';
      const audit = t.history.find(e => e.event === 'tested source integrated without changing caller Git index or branch')!;
      if (variant === 'missing publication') t.history = t.history.filter(e => e !== audit);
      if (variant === 'wrong publication fingerprint') (audit.data as { fingerprint: string }).fingerprint = 'stale';
      if (variant === 'wrong path') (audit.data as { paths: string[] }).paths = ['other.ts'];
    });
    expect(() => complete(parent)).toThrow(/provenance/); expect(readFileSync(join(project, 'app.ts'), 'utf8')).toBe('accepted renderer');
    expect(current(parent).column).toBe('review');
  });
  it('rejects unrelated dirty baseline even when an accepted task exists', () => {
    writeFileSync(join(project, 'app.ts'), 'unrelated caller work');
    const next = checkpoint(task('next')); writeFileSync(join(next.workspace!, 'app.ts'), 'overwrite');
    expect(() => complete(assessed(next))).toThrow(/provenance/);
    expect(readFileSync(join(project, 'app.ts'), 'utf8')).toBe('unrelated caller work');
  });
  it('rejects staged edits masked by accepted working bytes', () => {
    writeFileSync(join(project, 'app.ts'), 'staged caller work'); git('add', 'app.ts'); writeFileSync(join(project, 'app.ts'), 'accepted renderer');
    expect(() => complete(parent)).toThrow(/provenance/);
    expect(git('show', ':app.ts').toString()).toBe('staged caller work');
  });
  it('preserves concurrent caller edits and refuses stale parent fingerprint', () => {
    expect(() => store.complete(parent.id, 'stale', () => { throw new Error('must not execute'); })).toThrow(/not ready/);
    expect(() => complete(parent, () => writeFileSync(join(project, 'app.ts'), 'concurrent caller save'))).toThrow(/conflict/);
    expect(readFileSync(join(project, 'app.ts'), 'utf8')).toBe('concurrent caller save');
    expect(current(parent).column).toBe('review');
  });
  it.each(['failed test', 'stale snapshot revision', 'draining worker', 'PR incomplete'])('preserves %s completion protection', variant => {
    store.change(b => {
      const t = store.task(b, parent.id);
      if (variant === 'failed test') t.tests[0].exitCode = 1;
      if (variant === 'stale snapshot revision') t.snapshot!.revision = 2;
      if (variant === 'draining worker') t.executionLease = { token: 'fixture', owner: 'fixture', pid: process.pid, role: 'operator', revision: 1 };
      if (variant === 'PR incomplete') t.prMode = 'review';
    });
    expect(() => complete(parent)).toThrow();
    expect(readFileSync(join(project, 'app.ts'), 'utf8')).toBe('accepted renderer');
  });
  it.each(['tester', 'reviewer', 'orchestrator'] as const)('retains independent %s score gate', role => {
    store.change(b => { store.task(b, parent.id).evaluations[role]!.total = 84; });
    expect(() => complete(parent)).toThrow(/at least 85/);
    expect(readFileSync(join(project, 'app.ts'), 'utf8')).toBe('accepted renderer');
  });
});

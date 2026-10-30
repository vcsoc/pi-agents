import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createSnapshot } from '../src/kanban/snapshot.js';
import { KanbanStore, type SubtaskProposal, type TaskLink } from '../src/kanban/store.js';

let root: string, store: KanbanStore;
const input = { title: 'Bounded scope', scope: 'Implement exactly this scope', assignee: 'operate', rubric: [{ title: 'Verified result', weight: 100 }] };
const get = (id: string) => store.task(store.read(), id);
const proposal = (parentId: string, blocking = true): SubtaskProposal => ({ parentId, title: 'Scoped prerequisite', scope: 'Supply an independently owned bounded result', reason: 'Another owner is needed', expectedResult: 'Validated prerequisite result', relationship: { targetId: parentId, type: 'completed-before', blocking } });
// Fixture acceptance deliberately models all native gates; setting runtime/column alone is tested separately.
function accepted(id: string) {
  store.change(b => { const t = store.task(b,id); t.column = 'done'; t.fingerprint = 'fixture'; t.tests = [{ command: 'fixture validation', exitCode: 0, output: 'fixture only', fingerprint: 'fixture', at: t.updatedAt }];
    for (const role of ['tester','reviewer','orchestrator'] as const) t.evaluations[role] = { role, actor: role, revision: t.revision, scores: [100], total: 100, notes: 'fixture only', fingerprint: 'fixture', at: t.updatedAt };
  });
}
beforeEach(() => { root = mkdtempSync(join(tmpdir(),'kanban-links-')); mkdirSync(join(root, 'project')); store = new KanbanStore(join(root, 'project'), join(root,'state')); });
afterEach(() => rmSync(root,{ recursive: true, force: true }));

describe('single implementation owner', () => {
  it('requires the exact assigned operator identity and current lease', () => {
    const t = store.create(input,'orchestrator'); store.move(t.id,'ready','orchestrator'); const lease = store.claim(t.id,'owner');
    expect(() => store.assertImplementation(get(t.id),lease)).not.toThrow();
    expect(() => store.assertImplementation(get(t.id),{ ...lease, owner: 'other' })).toThrow(/execution owner/);
    expect(() => store.assertImplementation(get(t.id),{ ...lease, identity: { ...lease.identity!, definition: 'other' } })).toThrow(/execution owner/);
    store.handoff(t.id,lease,'Ready for independent testing','fixture');
    const tester = store.claim(t.id,'tester');
    expect(() => store.assertImplementation(get(t.id),tester)).toThrow(/execution owner/);
    expect(() => store.assertImplementation(get(t.id),lease)).toThrow(/stale/);
  });
});

describe('linked proposal lifecycle', () => {
  it('creates unassigned Backlog-only work, suspends without losing checkpoint, and requires explicit continuation', () => {
    const p = store.create(input,'orchestrator'); store.move(p.id,'ready','orchestrator'); const lease = store.claim(p.id,'owner',false,true);
    const workspace = join(root, 'checkpoint'), manifest = join(root, 'checkpoint.json');
    createSnapshot(store.identity.projectPath, workspace, manifest);
    store.change(b=>{ const t=store.task(b,p.id); t.workspace=workspace; t.snapshot={revision:t.revision,manifest}; t.fingerprint='checkpoint'; });
    const before = get(p.id), child = store.propose(p.id,lease,proposal(p.id));
    expect(child.column).toBe('backlog'); expect(child.assignee).toBe(''); expect(child.rubric).toEqual([]); expect(child.runs).toBe(0);
    const suspended = get(p.id); expect(suspended.suspension?.dependencyIds).toEqual([child.id]); expect(suspended.lease).toBeUndefined(); expect(suspended.executionLease?.token).toBe(lease.token);
    expect(suspended.revision).toBe(before.revision); expect(suspended.snapshot).toEqual(before.snapshot); expect(suspended.workspace).toBe(before.workspace); expect(suspended.fingerprint).toBe(before.fingerprint); expect(suspended.history.length).toBeGreaterThan(before.history.length);
    expect(() => store.assertActive(suspended,lease)).toThrow();
    expect(() => store.move(child.id,'ready','user')).toThrow(/Only the orchestrator/);
    expect(() => store.edit(child.id,input,'user')).toThrow(/orchestrator/);
    expect(() => store.edit(child.id,input,'orchestrator')).toThrow(/best practices/);
    store.edit(child.id,{...input,bestPractices:'Use focused native tests; preserve isolation'},'orchestrator'); store.move(child.id,'ready','orchestrator');
    expect(() => store.move(p.id,'ready','orchestrator')).toThrow(/accepted Done/);
    accepted(child.id); expect(get(p.id).suspension?.notified).toBe(true); expect(get(p.id).lease).toBeUndefined();
    expect(() => store.move(p.id,'ready','orchestrator')).toThrow(/drained/);
    store.release(p.id,lease,undefined,true);
    expect(() => store.move(p.id,'ready','user')).toThrow(/orchestrator/);
    store.move(p.id,'ready','orchestrator'); expect(get(p.id).suspension).toBeUndefined(); expect(get(p.id).revision).toBe(before.revision); expect(get(p.id).fingerprint).toBe('checkpoint');
  });
  it('informational links leave the active parent running', () => {
    const p=store.create(input,'orchestrator'); store.move(p.id,'ready','orchestrator'); const lease=store.claim(p.id,'owner');
    const child=store.propose(p.id,lease,proposal(p.id,false)); expect(child.links?.[0].blocking).toBe(false); expect(get(p.id).suspension).toBeUndefined(); expect(get(p.id).lease?.token).toBe(lease.token);
    accepted(child.id); expect(get(p.id).suspension).toBeUndefined(); expect(get(p.id).lease?.token).toBe(lease.token);
  });
  it('rejects stale proposals, missing fields and wrong parent/direction references atomically', () => {
    const p=store.create(input,'orchestrator'); store.move(p.id,'ready','orchestrator'); const lease=store.claim(p.id,'owner');
    for (const bad of [{...proposal(p.id),parentId:'missing'},{...proposal(p.id),reason:''},{...proposal(p.id),expectedResult:''},{...proposal(p.id),relationship:{targetId:'missing',type:'completed-before',blocking:true} as TaskLink}]) expect(()=>store.propose(p.id,lease,bad)).toThrow();
    expect(store.read().tasks).toHaveLength(1); store.move(p.id,'backlog','user'); expect(()=>store.propose(p.id,lease,proposal(p.id))).toThrow(/stale/);
  });
  it.each(['runtime done','cancelled','paused parent','archived parent'] as const)('%s never automatically resumes a parent', kind => {
    const p=store.create(input,'orchestrator'); store.move(p.id,'ready','orchestrator'); const lease=store.claim(p.id,'owner'); const child=store.propose(p.id,lease,proposal(p.id));
    if(kind==='runtime done') store.change(b=>{store.task(b,child.id).column='done';});
    else if(kind==='cancelled') store.cancel(child.id,'No longer authorized','orchestrator');
    else if(kind==='paused parent') {store.move(p.id,'backlog','user');accepted(child.id);}
    else {store.cancel(p.id,'Stop parent','user');store.archive(p.id,'user');accepted(child.id);}
    expect(get(p.id).lease).toBeUndefined();
    if(kind==='runtime done'||kind==='cancelled') {expect(get(p.id).suspension?.notified).not.toBe(true);expect(()=>store.move(p.id,'ready','orchestrator')).toThrow(/accepted Done/);}
    else expect(()=>store.move(p.id,'ready','orchestrator')).toThrow();
  });
});

describe('direction, references and cycles', () => {
  it.each(['depends-on','completed-after','completed-before'] as const)('%s has explicit direction', type => {
    const a=store.create(input,'orchestrator'),b=store.create(input,'orchestrator');store.link(a.id,[{targetId:b.id,type,blocking:true}],'orchestrator');
    expect(store.prerequisites(store.read(),get(type==='completed-before'?b.id:a.id))).toEqual([type==='completed-before'?a.id:b.id]);
  });
  it('rejects invalid references and cycles, preserving the prior graph', () => {
    const a=store.create(input,'orchestrator'),b=store.create(input,'orchestrator');
    expect(()=>store.link(a.id,[{targetId:'missing',type:'depends-on',blocking:true}],'orchestrator')).toThrow(/reference/);
    expect(()=>store.link(a.id,[{targetId:a.id,type:'depends-on',blocking:true}],'orchestrator')).toThrow(/reference/);
    store.link(a.id,[{targetId:b.id,type:'depends-on',blocking:true}],'orchestrator');
    expect(()=>store.link(b.id,[{targetId:a.id,type:'depends-on',blocking:true}],'orchestrator')).toThrow(/cycle/); expect(get(b.id).links).toBeUndefined();
    expect(()=>store.link(a.id,[],'operator')).toThrow(/orchestrator/);
  });
  it('allows informational cycles because they carry no executable prerequisite, but rejects making them blocking', () => {
    const a=store.create(input,'orchestrator'), b=store.create(input,'orchestrator');
    store.link(a.id,[{targetId:b.id,type:'completed-after',blocking:false}],'orchestrator');
    store.link(b.id,[{targetId:a.id,type:'completed-after',blocking:false}],'orchestrator');
    expect(store.prerequisites(store.read(),get(a.id))).toEqual([]);
    store.link(a.id,[{targetId:b.id,type:'completed-after',blocking:true}],'orchestrator');
    expect(()=>store.link(b.id,[{targetId:a.id,type:'completed-after',blocking:true}],'orchestrator')).toThrow(/cycle/);
    expect(get(b.id).links?.[0].blocking).toBe(false);
  });
  it('legacy unlinked tasks dispatch unchanged',()=>{ const t=store.create(input,'orchestrator'); expect(get(t.id).links).toBeUndefined();store.move(t.id,'ready','orchestrator');expect(store.claim(t.id,'owner').role).toBe('operator'); });
});

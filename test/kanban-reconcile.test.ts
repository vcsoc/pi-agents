import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sourceFingerprint } from '../src/kanban/execution.js';
import { createSnapshot, reconcileSnapshot } from '../src/kanban/snapshot.js';

let root: string, project: string, parent: string, child: string, parentManifest: string, childManifest: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'reconcile-')); project = join(root, 'project'); mkdirSync(project);
  for (const name of ['parent.ts', 'child.ts', 'delete.ts']) writeFileSync(join(project, name), `original ${name}`);
  parent = join(root, 'parent'); child = join(root, 'child'); parentManifest = join(root, 'parent.json'); childManifest = join(root, 'child.json');
  createSnapshot(project, parent, parentManifest); createSnapshot(project, child, childManifest);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));
function acceptedResult() {
  writeFileSync(join(child, 'child.ts'), 'accepted result'); writeFileSync(join(project, 'child.ts'), 'accepted result');
  return [{ workspace: child, manifest: childManifest, fingerprint: sourceFingerprint(child) }];
}
describe('retained checkpoint reconciliation safety', () => {
  it('preserves parent creations, deletions and executable modes without mutating either original workspace or index', () => {
    writeFileSync(join(parent, 'new.ts'), 'parent creation'); rmSync(join(parent, 'delete.ts')); chmodSync(join(parent, 'parent.ts'), 0o755);
    const before = sourceFingerprint(parent), index = readFileSync(join(parent, '.git/index')), manifest = readFileSync(parentManifest);
    const next = reconcileSnapshot(project, parent, parentManifest, acceptedResult())!;
    expect(readFileSync(join(next.workspace, 'child.ts'), 'utf8')).toBe('accepted result');
    expect(readFileSync(join(next.workspace, 'new.ts'), 'utf8')).toBe('parent creation'); expect(existsSync(join(next.workspace, 'delete.ts'))).toBe(false);
    expect(statSync(join(next.workspace, 'parent.ts')).mode & 0o777).toBe(0o755);
    expect(sourceFingerprint(parent)).toBe(before); expect(readFileSync(join(parent, '.git/index'))).toEqual(index); expect(readFileSync(parentManifest)).toEqual(manifest);
    expect(next.edits.sort()).toEqual(['delete.ts', 'new.ts', 'parent.ts']);
  });
  it.each(['parent.ts', 'unrelated.ts'])('refuses unaccepted caller changes at %s without rewriting parent source', name => {
    const dependencies = acceptedResult(), before = sourceFingerprint(parent); writeFileSync(join(project, name), 'unaccepted save');
    expect(() => reconcileSnapshot(project, parent, parentManifest, dependencies)).toThrow(/unaccepted caller changes/);
    expect(sourceFingerprint(parent)).toBe(before);
  });
  it('refuses a stale accepted child fingerprint even when caller source did not change', () => {
    const fingerprint = sourceFingerprint(child); writeFileSync(join(child, 'child.ts'), 'modified after acceptance');
    expect(() => reconcileSnapshot(project, parent, parentManifest, [{ workspace: child, manifest: childManifest, fingerprint }])).toThrow(/Accepted dependency source changed/);
    expect(readFileSync(join(parent, 'child.ts'), 'utf8')).toBe('original child.ts');
  });
});

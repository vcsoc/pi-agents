import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { createSnapshot } from '../src/kanban/snapshot.js';

const repository = resolve(fileURLToPath(new URL('..', import.meta.url)));
const roots: string[] = [];
const temporary = () => { const path = mkdtempSync(join(tmpdir(), 'snapshot-fixtures-')); roots.push(path); return path; };
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe('genuine fixture snapshot transport and dependency preflight', () => {
  it('transports every real fixture byte while excluding private state and omitted dependencies', () => {
    const root = temporary(), workspace = join(root, 'snapshot'), manifest = join(root, 'manifest.json');
    createSnapshot(repository, workspace, manifest);
    const fixtures = join(repository, 'test/fixtures');
    const names = readdirSync(fixtures, { recursive: true, withFileTypes: true }).filter(entry => entry.isFile()).map(entry => join(entry.parentPath, entry.name).slice(fixtures.length + 1)).filter(name => !name.startsWith('.runtime-'));
    expect(names.filter(name => name.startsWith('runtime-config/agents/'))).toHaveLength(25);
    expect(names).toContain('runtime-config/skills/probe-skill.md');
    for (const name of names) expect(readFileSync(join(workspace, 'test/fixtures', name))).toEqual(readFileSync(join(fixtures, name)));
    const captured = Object.keys(JSON.parse(readFileSync(manifest, 'utf8')).files);
    expect(captured.some(name => name.split('/').some(part => ['.pi', 'vault', 'node_modules'].includes(part)))).toBe(false);
    expect(existsSync(join(workspace, 'node_modules'))).toBe(false);
    const check = spawnSync(process.execPath, ['scripts/snapshot-preflight.mjs'], { cwd: workspace, encoding: 'utf8' });
    expect(check.status).toBe(1); expect(check.stderr).toContain('npm ci --ignore-scripts --no-audit --no-fund');
    expect(existsSync(join(workspace, 'node_modules'))).toBe(false); expect(existsSync(join(workspace, '.pi'))).toBe(false);
  }, 30_000);
  it('excludes even tracked private history while including legitimate fixture trees', () => {
    const root = temporary(), project = join(root, 'project'); mkdirSync(project);
    for (const name of ['.pi/history/data.json', 'test/nested/.pi/secret', 'vault/memory.md', 'test/fixtures/runtime-config/agents/real.md']) {
      const path = join(project, name); mkdirSync(resolve(path, '..'), { recursive: true }); writeFileSync(path, name);
    }
    execFileSync('git', ['init', '--quiet'], { cwd: project }); execFileSync('git', ['add', '.'], { cwd: project });
    const snapshot = join(root, 'snapshot'); createSnapshot(project, snapshot, join(root, 'manifest.json'));
    expect(readFileSync(join(snapshot, 'test/fixtures/runtime-config/agents/real.md'), 'utf8')).toContain('real.md');
    for (const name of ['.pi', 'vault', 'test/nested/.pi']) expect(existsSync(join(snapshot, name))).toBe(false);
  });
});

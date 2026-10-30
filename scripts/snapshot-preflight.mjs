import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

// Check only: dependency preparation is an explicit, user-authorized operation.
const cwd = process.cwd();
const read = path => JSON.parse(readFileSync(resolve(cwd, path), 'utf8'));
try {
  const manifest = read('package.json'), lock = read('package-lock.json');
  const required = { ...manifest.dependencies, ...manifest.devDependencies };
  for (const name of Object.keys(required)) {
    const path = `node_modules/${name}/package.json`, pinned = lock.packages?.[`node_modules/${name}`]?.version;
    if (!pinned || !existsSync(resolve(cwd, path)) || read(path).version !== pinned) throw new Error(`Missing or lock-mismatched dependency: ${name}`);
  }
  const tree = spawnSync('npm', ['ls', '--all', '--offline'], { cwd, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  if (tree.error || tree.status !== 0) throw new Error(`Dependency tree is not ready: ${tree.error ?? tree.stderr}`);
  const lockHash = createHash('sha256').update(readFileSync(resolve(cwd, 'package-lock.json'))).digest('hex');
  console.log(`Snapshot dependencies ready. Node ${process.version}; npm ${spawnSync('npm', ['--version'], { encoding: 'utf8' }).stdout.trim()}; lock SHA256 ${lockHash}`);
} catch (error) {
  console.error(`Snapshot preflight failed: ${error.message}\nDependencies are deliberately not copied into snapshots. With explicit installation authorization, prepare THIS snapshot using: npm ci --ignore-scripts --no-audit --no-fund\nThen rerun npm run snapshot:preflight. No user/Pi configuration is changed by this check.`);
  process.exitCode = 1;
}

import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { sourceFingerprint, sourceNames } from "./execution.js";

interface Entry { hash: string; mode: number }
interface Manifest { files: Record<string, Entry>; protected: string[] }
const git = (cwd: string, args: string[], input?: string) => execFileSync("git", args, { cwd, encoding: "utf8", input, maxBuffer: 16 * 1024 * 1024, stdio: ["pipe", "pipe", "pipe"] });
const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
function safePath(cwd: string, name: string) {
  if (!name || name.startsWith("/") || name.split(/[\\/]/).some(p => p === ".." || p === ".git" || p === ".pi" || p === "vault")) throw new Error(`Unsafe snapshot path: ${name}`);
  let path = cwd;
  for (const part of name.split("/")) {
    path = join(path, part);
    try {
      const stat = lstatSync(path);
      if (stat.isSymbolicLink() || (stat.isFile() && stat.nlink > 1)) throw new Error(`Snapshot symlink/hardlink is not supported: ${name}`);
    } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
  }
  return path;
}
function capture(cwd: string): Manifest {
  const files: Record<string, Entry> = Object.create(null);
  for (const name of sourceNames(cwd)) {
    const path = safePath(cwd, name);
    if (!existsSync(path)) continue;
    const stat = lstatSync(path);
    if (!stat.isFile()) throw new Error(`Snapshot requires regular source files: ${name}`);
    files[name] = { hash: digest(readFileSync(path)), mode: stat.mode };
  }
  return { files, protected: [] };
}
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
function differences(a: Manifest, b: Manifest) {
  return [...new Set([...Object.keys(a.files), ...Object.keys(b.files)])].filter(name => !same(a.files[name], b.files[name])).sort();
}
export function createSnapshot(project: string, workspace: string, manifestFile: string) {
  const before = capture(project);
  try {
    before.protected = git(project, ["diff", "--relative", "--name-only", "-z", "HEAD", "--", "."]).split("\0").filter(Boolean);
    // Staged edits can be masked by unstaged contents equal to HEAD; both belong to the caller.
    before.protected.push(...git(project, ["diff", "--cached", "--relative", "--name-only", "-z", "HEAD", "--", "."]).split("\0").filter(Boolean));
    before.protected.push(...git(project, ["ls-files", "--others", "--exclude-standard", "-z"]).split("\0").filter(Boolean));
  } catch {
    // Without a committed Git baseline, every existing file belongs to the caller.
    before.protected = Object.keys(before.files);
  }
  mkdirSync(workspace, { recursive: true, mode: 0o700 });
  try {
    for (const [name, entry] of Object.entries(before.files)) {
      const target = safePath(workspace, name);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, readFileSync(safePath(project, name)), { mode: entry.mode });
      chmodSync(target, entry.mode);
    }
    // A private, uncommitted index preserves tracked ignored files and Git ignore semantics.
    git(workspace, ["init", "--quiet"]);
    const names = Object.keys(before.files);
    if (names.length) git(workspace, ["--literal-pathspecs", "add", "-f", "--pathspec-from-file=-", "--pathspec-file-nul"], names.join("\0") + "\0");
    if (differences(before, capture(project)).length || differences(before, capture(workspace)).length) throw new Error("Source changed during snapshot creation; retry from backlog");
    writeFileSync(manifestFile, JSON.stringify(before), { mode: 0o600 });
  } catch (e) { rmSync(workspace, { recursive: true, force: true }); throw e; }
}

/** Rebase only accepted dependency changes, into a new checkpoint; never edit the retained parent. */
export function reconcileSnapshot(project: string, workspace: string, manifestFile: string, dependencies: { workspace: string; manifest: string; fingerprint: string }[]) {
  const baseline = JSON.parse(readFileSync(manifestFile, "utf8")) as Manifest;
  const caller = capture(project), parent = capture(workspace);
  const incoming = differences(baseline, caller);
  const edits = differences(baseline, parent);
  const overlap = incoming.filter(name => edits.includes(name));
  if (overlap.length) throw new Error(`Checkpoint reconciliation overlap: ${overlap.join(", ")}. Retained parent and evidence unchanged; resolve through separately authorized work.`);
  const authorized = new Map<string, (Entry | undefined)[]>();
  for (const dep of dependencies) {
    if (sourceFingerprint(dep.workspace) !== dep.fingerprint) throw new Error("Accepted dependency source changed; refusing checkpoint reconciliation");
    const original = JSON.parse(readFileSync(dep.manifest, "utf8")) as Manifest, accepted = capture(dep.workspace);
    for (const name of differences(original, accepted)) authorized.set(name, [...(authorized.get(name) ?? []), accepted.files[name]]);
  }
  if (!incoming.length) return undefined;
  const unrelated = incoming.filter(name => !authorized.get(name)?.some(entry => same(entry, caller.files[name])));
  if (unrelated.length) throw new Error(`Checkpoint reconciliation conflict: unaccepted caller changes at ${unrelated.join(", ")}`);
  const next = `${workspace}-continued-${randomUUID()}`, manifest = `${next}.json`;
  try {
    createSnapshot(project, next, manifest);
    for (const name of edits) {
      const target = safePath(next, name), entry = parent.files[name];
      if (!entry) { rmSync(target); continue; }
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, readFileSync(safePath(workspace, name)), { mode: entry.mode });
      chmodSync(target, entry.mode);
    }
    const expected: Manifest = { files: { ...caller.files }, protected: [] };
    for (const name of edits) { if (parent.files[name]) expected.files[name] = parent.files[name]; else delete expected.files[name]; }
    if (differences(parent, capture(workspace)).length || differences(caller, capture(project)).length || differences(expected, capture(next)).length) throw new Error("Source changed during checkpoint reconciliation; original checkpoint retained");
    return { workspace: next, manifest, incoming, edits };
  } catch (e) { rmSync(next, { recursive: true, force: true }); rmSync(manifest, { force: true }); throw e; }
}

function matchesEntry(path: string, entry: Entry) {
  const stat = lstatSync(path);
  return stat.isFile() && stat.mode === entry.mode && digest(readFileSync(path)) === entry.hash;
}
const inode = (path: string) => { const s = lstatSync(path); return `${s.dev}:${s.ino}`; };
// Atomic no-clobber publication; never use rename over a caller destination.
function publish(from: string, to: string) { linkSync(from, to); unlinkSync(from); }

/** Must run synchronously inside the board lock, after all acceptance gates pass.
 * Retained inodes are intentionally not garbage-collected: an editor may still hold them open.
 */
export function integrateSnapshot(project: string, workspace: string, manifestFile: string, expectedFingerprint: string, onRecovery?: (path: string) => void) {
  if (sourceFingerprint(workspace) !== expectedFingerprint) throw new Error("Submitted snapshot changed during completion; resubmit and retest");
  const baseline = JSON.parse(readFileSync(manifestFile, "utf8")) as Manifest;
  const caller = capture(project), submitted = capture(workspace);
  const conflicts = differences(baseline, caller);
  if (conflicts.length) throw new Error(`Integration conflict: opened project changed at ${conflicts.slice(0, 20).join(", ")}. Snapshot evidence retained; move backlog -> ready to resubmit and retest against the new source.`);
  const changed = differences(baseline, submitted);
  const dirty = changed.filter(name => baseline.protected.includes(name));
  if (dirty.length) throw new Error(`Integration conflict: caller dirty/untracked files are protected: ${dirty.join(", ")}`);
  // Also reject ignored/private collisions which are deliberately absent from source manifests.
  for (const name of changed) {
    const path = safePath(project, name);
    if (!baseline.files[name] && existsSync(path)) throw new Error(`Integration conflict: existing ignored path ${name}`);
    if (existsSync(path) && !lstatSync(path).isFile()) throw new Error(`Integration conflict: non-file path ${name}`);
  }
  if (!changed.length) return changed;
  // Keep all writes outside source. Originals are moved, never truncated or rewritten,
  // so even ENOSPC during staging or recovery cannot destroy their bytes/modes.
  const recovery = mkdtempSync(join(dirname(project), ".kanban-integration-"));
  const plan = changed.map((name, i) => ({ name, original: baseline.files[name] ? join(recovery, `original-${i}`) : undefined, replacement: submitted.files[name] ? join(recovery, `replacement-${i}`) : undefined, displaced: join(recovery, `displaced-${i}`), identity: "", published: false }));
  const attempted: typeof plan = [];
  const createdDirs: string[] = [];
  const cleanup = () => rmSync(recovery, { recursive: true, force: true });
  try {
    writeFileSync(join(recovery, "recovery.json"), JSON.stringify({ project, workspace, manifestFile, expectedFingerprint, baseline, submitted, plan: plan.map(({ name, original, replacement, displaced }) => ({ name, original, replacement, displaced })), recovery: "Inspect retained files and current caller paths; never overwrite a caller destination. Retained inodes may still be open in editors. Manual cleanup only after editors release files." }), { mode: 0o600, flag: "wx" });
    for (const item of plan) {
      if (!item.replacement) continue;
      const entry = submitted.files[item.name];
      writeFileSync(item.replacement, readFileSync(safePath(workspace, item.name)), { mode: entry.mode, flag: "wx" });
      chmodSync(item.replacement, entry.mode);
      if (digest(readFileSync(item.replacement)) !== entry.hash) throw new Error(`Incomplete staged replacement: ${item.name}`);
    }
    const stagedConflicts = differences(baseline, capture(project));
    if (stagedConflicts.length) throw new Error(`Integration conflict after staging: ${stagedConflicts.join(", ")}`);
    const identities = new Map(plan.filter(item => item.original).map(item => [item.name, inode(safePath(project, item.name))]));
    onRecovery?.(recovery);
    for (const item of plan) {
      const path = safePath(project, item.name);
      let parent = dirname(path);
      const missing: string[] = [];
      while (!existsSync(parent)) { missing.push(parent); parent = dirname(parent); }
      for (const dir of missing.reverse()) { mkdirSync(dir); createdDirs.push(dir); }
      attempted.push(item);
      if (item.original) {
        renameSync(path, item.original);
        if (inode(item.original) !== identities.get(item.name) || !matchesEntry(item.original, baseline.files[item.name])) throw new Error(`Integration conflict retaining original: ${item.name}`);
      }
      if (item.replacement) {
        item.identity = inode(item.replacement);
        linkSync(item.replacement, path);
        item.published = true;
        unlinkSync(item.replacement);
      }
    }
    for (const item of plan) {
      if (item.original && !matchesEntry(item.original, baseline.files[item.name])) throw new Error(`Integration conflict: retained original edited at ${item.name}`);
    }
    if (sourceFingerprint(project) !== expectedFingerprint || differences(submitted, capture(project)).length) throw new Error("Integration snapshot mismatch; refusing to certify a different source");
  } catch (e) {
    const failures: string[] = [];
    for (const item of attempted.reverse()) {
      try {
        const path = safePath(project, item.name);
        if (item.published && !existsSync(path)) throw new Error("concurrent caller deletion preserved; original retained for manual recovery");
        if (item.published) {
          // Capture first, inspect second. A save between inspection and rename is
          // preserved in quarantine, never unlinked or overwritten by rollback.
          renameSync(path, item.displaced);
          if (inode(item.displaced) !== item.identity || !matchesEntry(item.displaced, submitted.files[item.name])) {
            publish(item.displaced, path);
            throw new Error("concurrent caller save preserved; original retained for manual recovery");
          }
        }
        if (item.original && existsSync(item.original)) publish(item.original, path);
      } catch (failure) { failures.push(`${item.name}: ${String(failure)}`); }
    }
    for (const dir of createdDirs.reverse()) {
      try { rmdirSync(dir); } catch (failure) { failures.push(`${dir}: ${String(failure)}`); }
    }
    if (failures.length) throw new Error(`Integration failed: ${String(e)}. Rollback incomplete: ${failures.join("; ")}. Recovery required; original files and journal retained at ${recovery}`, { cause: e });
    if (attempted.length) throw new Error(`Integration failed: ${String(e)}. Rollback completed without overwriting caller paths; recovery journal and displaced inodes retained at ${recovery}`, { cause: e });
    try { cleanup(); } catch (failure) { throw new Error(`Integration failed: ${String(e)}. Caller unchanged; recovery artifacts retained at ${recovery}: ${String(failure)}`, { cause: e }); }
    throw e;
  }
  return changed;
}

import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync, readlinkSync } from "node:fs";
import { join, relative } from "node:path";
import type { Task } from "./store.js";

const sourceListingLimit = 16 * 1024 * 1024;
export interface CommandResult { code: number; stdout: string; stderr: string; stdoutComplete?: boolean }
export interface CommandOptions { completeStdout?: boolean }
export type Command = (file: string, args: string[], cwd: string, signal?: AbortSignal, options?: CommandOptions) => Promise<CommandResult>;
export const command: Command = (file, args, cwd, signal, options) => new Promise((resolve, reject) => {
  if (signal?.aborted) { reject(new Error("Task cancelled")); return; }
  const child = spawn(file, args, { cwd, stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32" });
  let stdout = "", stderr = "", killed = false;
  const chunks: Buffer[] = [];
  let bytes = 0, captureError: Error | undefined;
  let hardStop: ReturnType<typeof setTimeout> | undefined;
  const stop = () => {
    if (killed) return;
    killed = true;
    const kill = (s: NodeJS.Signals) => {
      try { if (process.platform !== "win32" && child.pid) process.kill(-child.pid, s); else child.kill(s); } catch { /* already exited */ }
    };
    kill("SIGTERM");
    hardStop = setTimeout(() => kill("SIGKILL"), 1500); hardStop.unref();
  };
  const timer = setTimeout(stop, 10 * 60 * 1000); timer.unref();
  signal?.addEventListener("abort", stop, { once: true });
  const cleanup = () => { clearTimeout(timer); if (hardStop) clearTimeout(hardStop); signal?.removeEventListener("abort", stop); };
  child.stdout.on("data", (d: Buffer) => {
    if (!options?.completeStdout) { stdout = (stdout + d).slice(-64000); return; }
    if (killed) return;
    bytes += d.length;
    if (bytes > sourceListingLimit) {
      captureError = new Error("Project file list exceeds 16 MiB snapshot limit");
      chunks.length = 0;
      stop();
    } else chunks.push(d);
  });
  child.stderr.on("data", d => { stderr = (stderr + d).slice(-64000); });
  child.on("error", e => { cleanup(); reject(e); });
  child.on("close", code => {
    cleanup();
    if (captureError) reject(captureError);
    else if (killed) reject(new Error("Task command cancelled or exceeded ten minutes"));
    else resolve({ code: code ?? -1, stdout: options?.completeStdout ? Buffer.concat(chunks, bytes).toString("utf8") : stdout, stderr, ...(options?.completeStdout ? { stdoutComplete: true } : {}) });
  });
});
export async function checked(run: Command, file: string, args: string[], cwd: string, signal?: AbortSignal) {
  const result = await run(file, args, cwd, signal);
  if (result.code !== 0) throw new Error(`${file} ${args.slice(0, 3).join(" ")} failed (${result.code}): ${result.stderr || result.stdout}`);
  return result.stdout.trim();
}
const ignored = new Set([".git", ".pi", "vault", "node_modules", "dist", "coverage", ".DS_Store"]);
export function sourceNames(cwd: string): string[] {
  try {
    return execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], { cwd, encoding: "utf8", maxBuffer: 16 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] }).split("\0").filter(name => name && !name.split(/[\\/]/).some(p => ignored.has(p))).sort();
  } catch (e) {
    if ((e as { code?: string }).code !== "ENOENT" && !(e as { status?: number }).status) throw e;
    const names: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (ignored.has(entry.name)) continue;
        const path = join(dir, entry.name);
        if (entry.isDirectory()) walk(path); else names.push(relative(cwd, path));
        if (names.length > 20000) throw new Error("Project exceeds 20000 snapshot files");
      }
    };
    walk(cwd); return names.sort();
  }
}
export function sourceFingerprint(cwd: string): string {
  return hashSource(cwd, sourceNames(cwd));
}
function hashSource(cwd: string, names: string[]) {
  const hash = createHash("sha256");
  for (const name of [...new Set(names)].sort()) {
    if (name.split(/[\\/]/).some(p => ignored.has(p))) continue;
    const path = join(cwd, name);
    try {
      const stat = lstatSync(path);
      hash.update(name).update("\0").update(String(stat.mode)).update("\0");
      if (stat.isSymbolicLink()) hash.update(readlinkSync(path));
      else if (stat.isFile()) hash.update(readFileSync(path));
    } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") continue; else throw e; }
    hash.update("\0");
  }
  return hash.digest("hex");
}
export async function fingerprint(cwd: string, run: Command = command, signal?: AbortSignal): Promise<string> {
  const listing = await run("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], cwd, signal, { completeStdout: true });
  if (signal?.aborted) throw new Error("Task cancelled");
  let names: string[];
  if (listing.code === 0) {
    // Legacy/custom runners may still return diagnostic tails. Never treat one as complete.
    if (listing.stdoutComplete === false || (listing.stdoutComplete !== true && listing.stdout.length >= 64000)) throw new Error("Project file list truncated; complete snapshot enumeration required");
    if (Buffer.byteLength(listing.stdout, "utf8") > sourceListingLimit) throw new Error("Project file list exceeds 16 MiB snapshot limit");
    if (listing.stdout && !listing.stdout.endsWith("\0")) throw new Error("Project file list truncated: missing NUL terminator");
    names = listing.stdout.split("\0").filter(Boolean);
  } else {
    names = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (ignored.has(entry.name)) continue;
        const path = join(dir, entry.name);
        if (entry.isDirectory()) walk(path); else names.push(relative(cwd, path));
        if (names.length > 20000) throw new Error("Project exceeds 20000 snapshot files");
      }
    };
    walk(cwd);
  }
  return hashSource(cwd, names);
}
export function prBody(t: Task): string {
  const clip = (s: string, limit: number) => s.length <= limit ? s : s.slice(0, limit) + "\n[Truncated; full evidence is retained in the Kanban task.]";
  const evaluations = ["tester", "reviewer", "orchestrator"].map(role => {
    const e = t.evaluations[role as keyof Task["evaluations"]];
    return e ? `### ${role}: ${e.total.toFixed(2)}%\n${t.rubric.map((c, i) => `- ${c.title} (${c.weight}%): ${e.scores[i]}/100`).join("\n")}\n\n${clip(e.notes, 2000)}` : `### ${role}: pending`;
  });
  const base = `## Kanban task ${t.id}\n${t.title}\n\n${clip(t.scope, 6000)}\n\nRevision: ${t.revision}\nSnapshot: ${t.fingerprint}\n\n## Rubric (85% required independently)\n${t.rubric.map(c => `- ${c.title}: ${c.weight}%`).join("\n")}\n\n${evaluations.join("\n\n")}\n\n## Executed tests\n`;
  const tests = t.tests.map(e => `- ${e.command}: exit ${e.exitCode}\n\n\`\`\`text\n${clip(e.output.replaceAll("```", "~~~"), 1000)}\n\`\`\``).join("\n");
  return base + clip(tests, Math.max(0, Math.min(8000, 63000 - base.length))) + "\n";
}

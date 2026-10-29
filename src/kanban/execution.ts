import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync, readlinkSync } from "node:fs";
import { join, relative } from "node:path";
import type { Task } from "./store.js";

export interface CommandResult { code: number; stdout: string; stderr: string }
export type Command = (file: string, args: string[], cwd: string, signal?: AbortSignal) => Promise<CommandResult>;
export const command: Command = (file, args, cwd, signal) => new Promise((resolve, reject) => {
  if (signal?.aborted) { reject(new Error("Task cancelled")); return; }
  const child = spawn(file, args, { cwd, stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32" });
  let stdout = "", stderr = "", killed = false;
  let hardStop: ReturnType<typeof setTimeout> | undefined;
  const stop = () => {
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
  child.stdout.on("data", d => { stdout = (stdout + d).slice(-64000); });
  child.stderr.on("data", d => { stderr = (stderr + d).slice(-64000); });
  child.on("error", e => { cleanup(); reject(e); });
  child.on("close", code => { cleanup(); if (killed) reject(new Error("Task command cancelled or exceeded ten minutes")); else resolve({ code: code ?? -1, stdout, stderr }); });
});
export async function checked(run: Command, file: string, args: string[], cwd: string, signal?: AbortSignal) {
  const result = await run(file, args, cwd, signal);
  if (result.code !== 0) throw new Error(`${file} ${args.slice(0, 3).join(" ")} failed (${result.code}): ${result.stderr || result.stdout}`);
  return result.stdout.trim();
}
const ignored = new Set([".git", ".pi", "vault", "node_modules", "dist", "coverage", ".DS_Store"]);
export async function fingerprint(cwd: string, run: Command = command, signal?: AbortSignal): Promise<string> {
  const listing = await run("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], cwd, signal);
  let names: string[];
  if (listing.code === 0) {
    // A truncated filename list must never certify a partial snapshot.
    if (listing.stdout.length >= 64000) throw new Error("Project file list exceeds snapshot limit; split the project before certifying work");
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
  const hash = createHash("sha256");
  for (const name of [...new Set(names)].sort()) {
    if (name.split(/[\\/]/).some(p => ignored.has(p))) continue;
    const path = join(cwd, name);
    hash.update(name).update("\0");
    try {
      const stat = lstatSync(path);
      hash.update(String(stat.mode)).update("\0");
      if (stat.isSymbolicLink()) hash.update(readlinkSync(path));
      else if (stat.isFile()) hash.update(readFileSync(path));
    } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") hash.update("<deleted>"); else throw e; }
    hash.update("\0");
  }
  return hash.digest("hex");
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

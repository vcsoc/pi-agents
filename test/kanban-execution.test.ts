import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type Command, command, fingerprint, sourceFingerprint } from "../src/kanban/execution.js";

let cwd: string;
const args = ["ls-files", "-z", "--cached", "--others", "--exclude-standard"];
const limit = 16 * 1024 * 1024;
const node = (script: string, signal?: AbortSignal, complete = true) => command(process.execPath, ["-e", script], cwd, signal, { completeStdout: complete });
beforeEach(() => { cwd = mkdtempSync(join(tmpdir(), "pi-enumeration-")); });
afterEach(() => { vi.restoreAllMocks(); rmSync(cwd, { recursive: true, force: true }); });

describe("complete source enumeration transport", () => {
  it("reproduces diagnostic clipping for 1636 names / 79639 characters and hashes the discarded prefix", async () => {
    execFileSync("git", ["init", "-q"], { cwd });
    const names = Array.from({ length: 1636 }, (_, i) => `${String(i).padStart(4, "0")}-${"x".repeat(i < 1111 ? 43 : 42)}`);
    for (const name of names) writeFileSync(join(cwd, name), "original");
    const listing = execFileSync("git", args, { cwd, encoding: "utf8" });
    expect(listing).toHaveLength(79639);
    const diagnostic = await command("git", args, cwd);
    expect(diagnostic.stdout).toBe(listing.slice(-64000));
    await expect(fingerprint(cwd, async () => diagnostic)).rejects.toThrow(/truncated/);
    // Preserve the controller's injected-runner and rest-argument forwarding path.
    const forwarded: Command = (...a) => command(...a);
    const before = await fingerprint(cwd, forwarded);
    expect(before).toBe(sourceFingerprint(cwd));
    expect(diagnostic.stdout).not.toContain(names[0]);
    writeFileSync(join(cwd, names[0]), "prefix mutation");
    expect(await fingerprint(cwd, forwarded)).not.toBe(before);
    expect(await fingerprint(cwd)).toBe(sourceFingerprint(cwd));
  });

  it.each([63999, 64000, 64001])("captures complete stdout at the old %i-character boundary", async size => {
    const result = await node(`process.stdout.write('x\\0'.repeat(${Math.floor(size / 2)}) + ${JSON.stringify(size % 2 ? "\0" : "")})`);
    expect(result.stdout).toHaveLength(size);
    expect(result.stdoutComplete).toBe(true);
    expect(result.code).toBe(0);
    const legacy: Command = async () => ({ code: 0, stdout: result.stdout, stderr: "" });
    if (size >= 64000) await expect(fingerprint(cwd, legacy)).rejects.toThrow(/truncated/);
    else expect(await fingerprint(cwd, legacy)).toBe(sourceFingerprint(cwd));
  });

  it("decodes UTF-8 once after split multibyte chunks, retaining NULs and whitespace", async () => {
    const text = " début\n文件-😀.ts \0second\0";
    const result = await node(`const b = Buffer.from(${JSON.stringify(text)}); let i = 0; const t = setInterval(() => { process.stdout.write(b.subarray(i, ++i)); if (i === b.length) clearInterval(t); }, 2);`);
    expect(result.stdout).toBe(text);
    writeFileSync(join(cwd, " début\n文件-😀.ts "), "unicode");
    const run: Command = async () => result;
    expect(await fingerprint(cwd, run)).toBe(sourceFingerprint(cwd));
  });

  it("allows exactly 16 MiB, rejects overflow without returning a partial list, and clips stderr", async () => {
    const exact = await node(`process.stdout.write('x'.repeat(${limit})); process.stderr.write('e'.repeat(70000))`);
    expect(exact.stdout).toHaveLength(limit);
    expect(exact.stderr).toHaveLength(64000);
    await expect(node(`process.stdout.write('x'.repeat(${limit + 1}))`)).rejects.toThrow(/16 MiB/);
    const oversize: Command = async () => ({ code: 0, stdout: "界".repeat(Math.floor(limit / 3) + 1), stderr: "", stdoutComplete: true });
    await expect(fingerprint(cwd, oversize)).rejects.toThrow(/16 MiB/);
  });

  it("fails closed on explicit truncation, missing terminator and rejected transport", async () => {
    for (const result of [
      { code: 0, stdout: "", stderr: "", stdoutComplete: false },
      { code: 0, stdout: "partial", stderr: "", stdoutComplete: true },
    ]) await expect(fingerprint(cwd, async () => result)).rejects.toThrow(/truncated/);
    await expect(fingerprint(cwd, async () => { throw new Error("transport failure"); })).rejects.toThrow("transport failure");
    await expect(command("/nonexistent/pi-enumeration-command", [], cwd, undefined, { completeStdout: true })).rejects.toThrow();
  });

  it("preserves exit errors and the complete non-Git fallback", async () => {
    expect(await node("process.stdout.write('partial'); process.stderr.write('failure'); process.exitCode = 7")).toMatchObject({ code: 7, stdout: "partial", stderr: "failure" });
    writeFileSync(join(cwd, "app.ts"), "fallback");
    expect(await fingerprint(cwd)).toBe(sourceFingerprint(cwd));
  });

  it("rejects pre-abort, in-flight abort and late abort even if an injected runner ignores the signal", async () => {
    const pre = new AbortController(); pre.abort();
    await expect(node("process.exit(0)", pre.signal)).rejects.toThrow(/cancelled/);
    const active = new AbortController();
    const pending = node("setInterval(() => process.stdout.write('partial'), 5)", active.signal);
    setTimeout(() => active.abort(), 50);
    await expect(pending).rejects.toThrow(/cancelled/);
    const late = new AbortController();
    await expect(fingerprint(cwd, async () => { late.abort(); return { code: 0, stdout: "", stderr: "" }; }, late.signal)).rejects.toThrow(/cancelled/);
  });

  it("retains the ten-minute timeout", async () => {
    const original = globalThis.setTimeout;
    vi.spyOn(globalThis, "setTimeout").mockImplementation(((fn: () => void, ms: number) => original(fn, ms === 600000 ? 50 : ms)) as typeof setTimeout);
    await expect(node("setInterval(() => {}, 1000)")).rejects.toThrow(/exceeded ten minutes/);
  });

  it("preserves private exclusions, modes, symlinks and complete fingerprint identity", async () => {
    execFileSync("git", ["init", "-q"], { cwd });
    writeFileSync(join(cwd, "app.ts"), "source");
    symlinkSync("app.ts", join(cwd, "link"));
    const before = await fingerprint(cwd);
    for (const name of [".pi", "vault", "node_modules", "dist", "coverage"]) {
      mkdirSync(join(cwd, name)); writeFileSync(join(cwd, name, "private"), "secret");
    }
    expect(await fingerprint(cwd)).toBe(before);
    chmodSync(join(cwd, "app.ts"), 0o755);
    expect(await fingerprint(cwd)).not.toBe(before);
    expect(await fingerprint(cwd)).toBe(sourceFingerprint(cwd));
  });
});

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sourceFingerprint } from "../src/kanban/execution.js";
import { createSnapshot, integrateSnapshot } from "../src/kanban/snapshot.js";

vi.mock("node:fs", async importOriginal => {
  const original = await importOriginal<typeof fs>();
  return { ...original, writeFileSync: vi.fn(original.writeFileSync), renameSync: vi.fn(original.renameSync), linkSync: vi.fn(original.linkSync) };
});
const real = await vi.importActual<typeof fs>("node:fs");
let root: string, project: string, workspace: string, manifest: string, before: string;
let indexBefore: Buffer, headBefore: Buffer;
const originalApp = "original caller source";
const replacement = "tested replacement source";
const fault = () => Object.assign(new Error("simulated partial write EIO"), { code: "EIO" });
const recoveries = () => fs.readdirSync(root).filter(name => name.startsWith(".kanban-integration-"));
const integrate = () => integrateSnapshot(project, workspace, manifest, sourceFingerprint(workspace));
beforeEach(() => {
  vi.mocked(fs.writeFileSync).mockImplementation(real.writeFileSync);
  vi.mocked(fs.renameSync).mockImplementation(real.renameSync);
  vi.mocked(fs.linkSync).mockImplementation(real.linkSync);
  root = fs.mkdtempSync(join(tmpdir(), "kanban-rollback-"));
  project = join(root, "project"); workspace = join(root, "snapshot"); manifest = join(root, "manifest.json");
  fs.mkdirSync(project);
  fs.writeFileSync(join(project, "app.ts"), originalApp); fs.chmodSync(join(project, "app.ts"), 0o755);
  fs.writeFileSync(join(project, "other.ts"), "other caller source");
  const git = (...args: string[]) => execFileSync("git", args, { cwd: project, stdio: "pipe" });
  git("init", "--quiet"); git("add", ".");
  git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--quiet", "-m", "fixture");
  indexBefore = fs.readFileSync(join(project, ".git/index")); headBefore = fs.readFileSync(join(project, ".git/HEAD"));
  before = sourceFingerprint(project); createSnapshot(project, workspace, manifest);
});
afterEach(() => {
  try {
    expect(fs.readFileSync(join(project, ".git/index"))).toEqual(indexBefore);
    expect(fs.readFileSync(join(project, ".git/HEAD"))).toEqual(headBefore);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

function partialWrite(bytes: string) {
  let injected = false;
  vi.mocked(fs.writeFileSync).mockImplementation((path, data, options) => {
    if (String(data) === bytes && !injected) {
      injected = true; real.writeFileSync(path, "partially written", options); throw fault();
    }
    return real.writeFileSync(path, data, options);
  });
  return () => injected;
}
function assertRestored(retained = false) {
  expect(sourceFingerprint(project)).toBe(before);
  expect(fs.readFileSync(join(project, "app.ts"), "utf8")).toBe(originalApp);
  expect(fs.statSync(join(project, "app.ts")).mode & 0o777).toBe(0o755);
  expect(recoveries()).toHaveLength(retained ? 1 : 0);
}

describe("snapshot integration fault recovery", () => {
  it.each(["app.ts", "new.ts"])("partial staging write for %s never damages caller or leaves partial creates", name => {
    fs.writeFileSync(join(workspace, name), replacement);
    const injected = partialWrite(replacement);
    expect(integrate).toThrow(/simulated partial write/); expect(injected()).toBe(true);
    assertRestored(); expect(fs.existsSync(join(project, "new.ts"))).toBe(false);
  });
  it("stages every file before any caller change when a later stage fails", () => {
    fs.writeFileSync(join(workspace, "app.ts"), replacement);
    fs.writeFileSync(join(workspace, "other.ts"), "second replacement");
    partialWrite("second replacement");
    expect(integrate).toThrow(/simulated partial write/); assertRestored();
  });
  it("restores earlier edits and current original when no-clobber publication fails", () => {
    fs.writeFileSync(join(workspace, "app.ts"), replacement);
    fs.writeFileSync(join(workspace, "other.ts"), "second replacement");
    vi.mocked(fs.linkSync).mockImplementation((from, to) => {
      if (String(from).includes("replacement-") && to === join(project, "other.ts")) throw fault();
      return real.linkSync(from, to);
    });
    expect(integrate).toThrow(/simulated partial write/); assertRestored(true);
  });
  it("removes earlier new files and newly created directories on later failure", () => {
    fs.mkdirSync(join(workspace, "aaa")); fs.writeFileSync(join(workspace, "aaa/new.ts"), replacement);
    fs.writeFileSync(join(workspace, "app.ts"), replacement);
    vi.mocked(fs.linkSync).mockImplementation((from, to) => {
      if (String(from).includes("replacement-") && to === join(project, "app.ts")) throw fault();
      return real.linkSync(from, to);
    });
    expect(integrate).toThrow(/simulated partial write/); assertRestored(true);
    expect(fs.existsSync(join(project, "aaa"))).toBe(false);
  });
  it("restores deletion and mode changes if a later operation fails", () => {
    fs.rmSync(join(workspace, "app.ts")); fs.chmodSync(join(workspace, "other.ts"), 0o755);
    vi.mocked(fs.linkSync).mockImplementation((from, to) => {
      if (String(from).includes("replacement-")) throw fault();
      return real.linkSync(from, to);
    });
    expect(integrate).toThrow(/simulated partial write/); assertRestored(true);
  });
  it("retains original bytes/modes and recovery journal after rollback failure, and restores other paths", () => {
    fs.writeFileSync(join(workspace, "app.ts"), replacement);
    fs.writeFileSync(join(workspace, "other.ts"), "second replacement");
    vi.mocked(fs.linkSync).mockImplementation((from, to) => {
      if (String(from).includes("replacement-") && to === join(project, "other.ts")) throw fault();
      if (String(from).includes("original-") && to === join(project, "other.ts")) throw new Error("restore denied");
      return real.linkSync(from, to);
    });
    expect(integrate).toThrow(/Rollback incomplete: other.ts.*Recovery required/);
    expect(fs.readFileSync(join(project, "app.ts"), "utf8")).toBe(originalApp);
    expect(recoveries()).toHaveLength(1);
    const recovery = join(root, recoveries()[0]);
    const journal = JSON.parse(fs.readFileSync(join(recovery, "recovery.json"), "utf8"));
    expect(journal.project).toBe(project);
    const item = journal.plan.find((p: { name: string }) => p.name === "other.ts");
    expect(fs.readFileSync(item.original, "utf8")).toBe("other caller source");
    expect(fs.statSync(recovery).mode & 0o777).toBe(0o700);
  });
  it("rejects a caller save during staging (reviewer reproduction)", () => {
    fs.writeFileSync(join(workspace, "app.ts"), replacement);
    vi.mocked(fs.writeFileSync).mockImplementation((path, data, options) => {
      real.writeFileSync(path, data, options);
      if (String(path).includes("replacement-")) real.writeFileSync(join(project, "app.ts"), "saved during staging");
    });
    expect(integrate).toThrow(/Integration conflict after staging: app.ts/);
    expect(fs.readFileSync(join(project, "app.ts"), "utf8")).toBe("saved during staging");
    expect(recoveries()).toHaveLength(0);
  });
  it.each([false, true])("validates retained original before replacement/deletion (delete=%s)", deletion => {
    if (deletion) fs.rmSync(join(workspace, "app.ts"));
    else fs.writeFileSync(join(workspace, "app.ts"), replacement);
    vi.mocked(fs.renameSync).mockImplementation((from, to) => {
      if (from === join(project, "app.ts") && String(to).includes("original-")) real.writeFileSync(from, "saved before retain");
      return real.renameSync(from, to);
    });
    expect(integrate).toThrow(/Integration conflict retaining original: app.ts/);
    expect(fs.readFileSync(join(project, "app.ts"), "utf8")).toBe("saved before retain");
  });
  it("restores earlier changes while preserving a later-file save", () => {
    fs.writeFileSync(join(workspace, "app.ts"), replacement);
    fs.writeFileSync(join(workspace, "other.ts"), "second replacement");
    vi.mocked(fs.linkSync).mockImplementation((from, to) => {
      real.linkSync(from, to);
      if (String(from).includes("replacement-") && to === join(project, "app.ts")) real.writeFileSync(join(project, "other.ts"), "saved later file");
    });
    expect(integrate).toThrow(/Integration conflict retaining original: other.ts/);
    expect(fs.readFileSync(join(project, "app.ts"), "utf8")).toBe(originalApp);
    expect(fs.readFileSync(join(project, "other.ts"), "utf8")).toBe("saved later file");
  });
  it.each(["new.ts", "app.ts"])("never clobbers a newly appearing publication destination %s", name => {
    fs.writeFileSync(join(workspace, name), replacement);
    vi.mocked(fs.linkSync).mockImplementation((from, to) => {
      if (String(from).includes("replacement-") && to === join(project, name)) real.writeFileSync(to, "new caller destination");
      return real.linkSync(from, to);
    });
    expect(integrate).toThrow(/EEXIST/);
    expect(fs.readFileSync(join(project, name), "utf8")).toBe("new caller destination");
    if (name === "app.ts") expect(fs.readFileSync(join(root, recoveries()[0], "original-0"), "utf8")).toBe(originalApp);
  });
  it("preserves a new destination for a deleted source during rollback", () => {
    fs.rmSync(join(workspace, "app.ts"));
    fs.writeFileSync(join(workspace, "other.ts"), replacement);
    vi.mocked(fs.linkSync).mockImplementation((from, to) => {
      real.linkSync(from, to);
      if (String(from).includes("replacement-")) real.writeFileSync(join(project, "app.ts"), "new save at deleted path");
    });
    expect(integrate).toThrow(/Rollback incomplete: app.ts.*EEXIST/);
    expect(fs.readFileSync(join(project, "app.ts"), "utf8")).toBe("new save at deleted path");
    expect(fs.readFileSync(join(project, "other.ts"), "utf8")).toBe("other caller source");
    expect(fs.readFileSync(join(root, recoveries()[0], "original-0"), "utf8")).toBe(originalApp);
  });
  it.each([false, true])("preserves an editor save racing rollback quarantine (atomic=%s)", atomic => {
    fs.writeFileSync(join(workspace, "app.ts"), replacement);
    fs.writeFileSync(join(workspace, "other.ts"), "second replacement");
    vi.mocked(fs.linkSync).mockImplementation((from, to) => {
      if (String(from).includes("replacement-") && to === join(project, "other.ts")) throw fault();
      return real.linkSync(from, to);
    });
    vi.mocked(fs.renameSync).mockImplementation((from, to) => {
      if (from === join(project, "app.ts") && String(to).includes("displaced-")) {
        if (atomic) { real.writeFileSync(join(project, "save.tmp"), "caller rollback save"); real.renameSync(join(project, "save.tmp"), from); }
        else real.writeFileSync(from, "caller rollback save");
      }
      return real.renameSync(from, to);
    });
    expect(integrate).toThrow(/Rollback incomplete: app.ts.*concurrent caller save preserved/);
    expect(fs.readFileSync(join(project, "app.ts"), "utf8")).toBe("caller rollback save");
    expect(fs.readFileSync(join(root, recoveries()[0], "original-0"), "utf8")).toBe(originalApp);
    expect(fs.readFileSync(join(project, "other.ts"), "utf8")).toBe("other caller source");
  });
  it("no-clobber restoration preserves a save after quarantine while retaining both prior versions", () => {
    fs.writeFileSync(join(workspace, "app.ts"), replacement);
    fs.writeFileSync(join(workspace, "other.ts"), "second replacement");
    vi.mocked(fs.linkSync).mockImplementation((from, to) => {
      if (String(from).includes("replacement-") && to === join(project, "other.ts")) throw fault();
      if (String(from).includes("original-") && to === join(project, "app.ts")) real.writeFileSync(to, "save after quarantine");
      return real.linkSync(from, to);
    });
    expect(integrate).toThrow(/Rollback incomplete: app.ts.*EEXIST/);
    expect(fs.readFileSync(join(project, "app.ts"), "utf8")).toBe("save after quarantine");
    const recovery = join(root, recoveries()[0]);
    expect(fs.readFileSync(join(recovery, "original-0"), "utf8")).toBe(originalApp);
    expect(fs.readFileSync(join(recovery, "displaced-0"), "utf8")).toBe(replacement);
  });
  it("preserves a caller deletion of an already published file during rollback", () => {
    fs.writeFileSync(join(workspace, "app.ts"), replacement);
    fs.writeFileSync(join(workspace, "other.ts"), "second replacement");
    vi.mocked(fs.linkSync).mockImplementation((from, to) => {
      if (String(from).includes("replacement-") && to === join(project, "other.ts")) {
        real.unlinkSync(join(project, "app.ts")); throw fault();
      }
      return real.linkSync(from, to);
    });
    expect(integrate).toThrow(/concurrent caller deletion preserved/);
    expect(fs.existsSync(join(project, "app.ts"))).toBe(false);
    expect(fs.readFileSync(join(root, recoveries()[0], "original-0"), "utf8")).toBe(originalApp);
  });
  it("detects a retained original edited through an open descriptor before final verification", () => {
    fs.writeFileSync(join(workspace, "app.ts"), replacement);
    const fd = fs.openSync(join(project, "app.ts"), "r+");
    vi.mocked(fs.linkSync).mockImplementation((from, to) => {
      real.linkSync(from, to);
      if (String(from).includes("replacement-")) fs.writeSync(fd, "save to retained inode", 0, "utf8");
    });
    try {
      expect(integrate).toThrow(/retained original edited at app.ts/);
      expect(fs.readFileSync(join(project, "app.ts"), "utf8")).toContain("save to retained inode");
    } finally { fs.closeSync(fd); }
  });
  it("retains original inodes and reports recovery path even after successful integration", () => {
    fs.writeFileSync(join(workspace, "app.ts"), replacement);
    const fd = fs.openSync(join(project, "app.ts"), "r+");
    const report = vi.fn();
    try {
      integrateSnapshot(project, workspace, manifest, sourceFingerprint(workspace), report);
      fs.writeSync(fd, "late open-fd save", 0, "utf8");
      const recovery = join(root, recoveries()[0]);
      expect(report).toHaveBeenCalledWith(recovery);
      expect(fs.readFileSync(join(recovery, "original-0"), "utf8")).toContain("late open-fd save");
      expect(fs.readFileSync(join(project, "app.ts"), "utf8")).toBe(replacement);
    } finally { fs.closeSync(fd); }
  });
  it("integrates without ever opening caller files for destructive writes", () => {
    fs.writeFileSync(join(workspace, "app.ts"), replacement);
    vi.mocked(fs.writeFileSync).mockImplementation((path, data, options) => {
      if (String(path).startsWith(`${project}/`)) throw new Error("caller must not be truncated");
      return real.writeFileSync(path, data, options);
    });
    expect(integrate()).toEqual(["app.ts"]);
    expect(fs.readFileSync(join(project, "app.ts"), "utf8")).toBe(replacement);
    expect(recoveries()).toHaveLength(1);
    expect(fs.readFileSync(join(root, recoveries()[0], "original-0"), "utf8")).toBe(originalApp);
  });
});

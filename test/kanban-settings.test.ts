import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applySettings, loadSettings, type SettingsAppliers, saveSettings } from "../src/settings.js";

let root: string, cwd: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "pi-kanban-settings-")); cwd = join(root, "project"); mkdirSync(cwd); vi.stubEnv("PI_CODING_AGENT_DIR", join(root, "agent")); });
afterEach(() => { vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); });
describe("Kanban setting and root wiring", () => {
  it("is opt-in and absent by default", () => { expect(loadSettings(cwd).kanbanEnabled).toBeUndefined(); });
  it.each([true, false])("persists a boolean value %s", kanbanEnabled => { expect(saveSettings({ kanbanEnabled }, cwd)).toBe(true); expect(loadSettings(cwd).kanbanEnabled).toBe(kanbanEnabled); });
  it("rejects truthy non-boolean settings", () => { mkdirSync(join(cwd, ".pi")); writeFileSync(join(cwd, ".pi", "subagents.json"), JSON.stringify({ kanbanEnabled: "true" })); expect(loadSettings(cwd).kanbanEnabled).toBeUndefined(); });
  it("applies both enabled and disabled values without inventing a default", () => { const setter = vi.fn(), appliers = { setKanbanEnabled: setter } as unknown as SettingsAppliers; applySettings({ kanbanEnabled: true }, appliers); applySettings({ kanbanEnabled: false }, appliers); applySettings({}, appliers); expect(setter.mock.calls).toEqual([[true], [false]]); });
  it("wires the toggle, complete snapshot, kban command, and lifecycle cleanup", () => {
    const source = readFileSync(fileURLToPath(new URL("../src/index.ts", import.meta.url)), "utf8");
    expect(source).toContain('id: "kanbanEnabled"'); expect(source).toContain("      kanbanEnabled,");
    expect(source).toContain('args.trim() !== "kban"'); expect(source).toContain("await startKanbanServer(controller)");
    expect(source).toContain("await stopKanban()"); expect(source).toContain("manager.setSpawnGuard");
    expect(source).toContain("if (!ctx.isProjectTrusted())"); expect(source).toContain('pi.on("before_agent_start"');
  });
});

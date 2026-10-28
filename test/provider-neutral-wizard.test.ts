import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionCommandHandler } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerAgents } from "../src/agent-types.js";
import agentsExtension from "../src/index.js";

let cwd: string;
let previousCwd: string;
let previousHome: string | undefined;
let previousAgentDir: string | undefined;

beforeEach(() => {
  previousCwd = process.cwd();
  previousHome = process.env.HOME;
  previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  cwd = mkdtempSync(join(tmpdir(), "pi-agents-wizard-"));
  process.chdir(cwd);
  process.env.HOME = cwd;
  process.env.PI_CODING_AGENT_DIR = join(cwd, "agent-dir");
});

afterEach(() => {
  Reflect.deleteProperty(globalThis, Symbol.for("pi-agents:manager"));
  process.chdir(previousCwd);
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  registerAgents(new Map());
  rmSync(cwd, { recursive: true, force: true });
});

function wizard(modelChoice: string) {
  let handler: ExtensionCommandHandler | undefined;
  const pi = {
    registerMessageRenderer: vi.fn(), registerEntryRenderer: vi.fn(),
    registerTool: vi.fn(), registerFlag: vi.fn(), getFlag: vi.fn(),
    registerCommand: vi.fn((name, command) => { if (name === "agents") handler = command.handler; }),
    getAllTools: vi.fn(() => []), setActiveTools: vi.fn(), on: vi.fn(),
    events: { emit: vi.fn(), on: vi.fn(() => vi.fn()) }, appendEntry: vi.fn(), sendMessage: vi.fn(),
  } as unknown as ExtensionAPI;
  agentsExtension(pi);
  const select = vi.fn()
    .mockResolvedValueOnce("Create new agent")
    .mockResolvedValueOnce("Project (.pi/agents/)")
    .mockResolvedValueOnce("Manual configuration")
    .mockResolvedValueOnce("all")
    .mockResolvedValueOnce(modelChoice)
    .mockResolvedValueOnce("inherit");
  const ctx = {
    cwd, hasUI: true,
    ui: {
      select, input: vi.fn().mockResolvedValueOnce("reviewer").mockResolvedValueOnce("Review code"),
      editor: vi.fn().mockResolvedValue("Review carefully."), notify: vi.fn(),
    },
    modelRegistry: {
      getAvailable: () => [
        { provider: "ollama", id: "qwen2.5-coder:7b" },
        { provider: "custom", id: "org/model" },
      ],
    },
  } as unknown as ExtensionCommandContext;
  return { run: () => handler?.("", ctx), select };
}

describe("provider-neutral creation wizard", () => {
  it("lists configured providers rather than hard-coded Claude tiers", async () => {
    const { run, select } = wizard("custom/org/model");
    await run();
    expect(select).toHaveBeenCalledWith("Creation method", [
      "Generate with current Pi model (recommended)", "Manual configuration",
    ]);
    expect(select).toHaveBeenCalledWith("Model", [
      "inherit (parent model)", "custom/org/model", "ollama/qwen2.5-coder:7b", "custom...",
    ]);
    expect(readFileSync(join(cwd, ".pi/agents/reviewer.md"), "utf8")).toContain('model: "custom/org/model"');
  });

  it("omits the model pin when the user chooses parent inheritance", async () => {
    const { run } = wizard("inherit (parent model)");
    await run();
    expect(readFileSync(join(cwd, ".pi/agents/reviewer.md"), "utf8")).not.toContain("model:");
  });
});

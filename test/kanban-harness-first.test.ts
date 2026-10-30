import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ toggle: undefined as undefined | ((enabled: boolean) => void) }));
vi.mock("../src/settings.js", async () => {
  const actual = await vi.importActual<typeof import("../src/settings.js")>("../src/settings.js");
  return { ...actual, loadSettings: () => ({}), applyAndEmitLoaded: (appliers: any) => { state.toggle = appliers.setKanbanEnabled; } };
});
vi.mock("../src/agent-runner.js", async () => {
  const actual = await vi.importActual<typeof import("../src/agent-runner.js")>("../src/agent-runner.js");
  return { ...actual, runAgent: vi.fn((_ctx, _type, _prompt, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener("abort", () => reject(new Error("Fixture aborted")), { once: true });
  })) };
});
vi.mock("node:child_process", async () => ({ ...await vi.importActual<typeof import("node:child_process")>("node:child_process"), spawn: vi.fn(() => ({ on: vi.fn(), unref: vi.fn() })) }));
vi.mock("../src/kanban/server.js", () => ({ startKanbanServer: vi.fn(async () => ({ url: "http://127.0.0.1/#fixture", close: vi.fn(async () => {}) })) }));

import extension from "../src/index.js";
import { startKanbanServer } from "../src/kanban/server.js";

let root: string;
let hooks: Map<string, any>;
let tools: Map<string, any>;
let pi: any;
let ctx: any;
const managerKey = Symbol.for("pi-agents:manager");
let priorManager: unknown;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "pi-harness-first-"));
  mkdirSync(join(root, "project"));
  vi.stubEnv("PI_CODING_AGENT_DIR", join(root, "agent"));
  priorManager = (globalThis as any)[managerKey];
  delete (globalThis as any)[managerKey];
  hooks = new Map(); tools = new Map();
  pi = {
    registerTool: (tool: any) => tools.set(tool.name, tool), on: (name: string, hook: any) => hooks.set(name, hook),
    registerCommand: vi.fn(), registerMessageRenderer: vi.fn(), registerEntryRenderer: vi.fn(), registerFlag: vi.fn(), getFlag: vi.fn(),
    events: { emit: vi.fn(), on: vi.fn(() => vi.fn()) }, appendEntry: vi.fn(), sendMessage: vi.fn(),
  };
  ctx = {
    hasUI: false, cwd: join(root, "project"), isProjectTrusted: () => true,
    ui: { notify: vi.fn(), setWidget: vi.fn(), setStatus: vi.fn() },
    modelRegistry: { find: vi.fn(), getAvailable: () => [] },
    sessionManager: { getSessionId: () => "harness-first-fixture", getBranch: () => [] }, getSystemPrompt: () => "parent context",
  };
  extension(pi);
});
afterEach(async () => {
  await hooks.get("session_shutdown")?.();
  if (priorManager === undefined) delete (globalThis as any)[managerKey];
  else (globalThis as any)[managerKey] = priorManager;
  vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true });
});
const call = (name: string, args: unknown) => tools.get(name).execute("fixture", args, new AbortController().signal, undefined, ctx);
const data = (result: any) => JSON.parse(result.content[0].text);
const spec = { holdInBacklog: true, title: "Native task", scope: "Verify native ownership", assignee: "operate", rubric: [{ title: "Native ownership preserved", weight: 100 }] };

describe("harness-first extension lifecycle", () => {
  it("toggles and persists Kanban through /crew on and off without opening the menu", async () => {
    const command = pi.registerCommand.mock.calls.find(([name]: [string]) => name === "crew")[1];
    const opened = vi.mocked(startKanbanServer).mock.calls.length;
    for (const mode of ["on", "on", "off", "off"]) {
      await command.handler(`  ${mode}  `, ctx);
      const saved = JSON.parse(readFileSync(join(ctx.cwd, ".pi", "subagents.json"), "utf8"));
      expect(saved.kanbanEnabled).toBe(mode === "on");
      expect(pi.events.emit).toHaveBeenLastCalledWith("subagents:settings_changed", expect.objectContaining({ persisted: true, settings: expect.objectContaining({ kanbanEnabled: mode === "on" }) }));
      const policy = await hooks.get("before_agent_start")({}, ctx);
      if (mode === "on") {
        expect(policy.message.customType).toBe("kanban-policy");
        expect(tools.get("Kanban").exposure).not.toBe("hidden");
      } else {
        expect(policy.systemPrompt).toContain("<direct_agent_workflow>");
        expect(tools.get("Kanban").exposure).toBe("hidden");
      }
    }
    expect(vi.mocked(startKanbanServer).mock.calls).toHaveLength(opened);
    expect(existsSync(join(root, "agent", "subagents.json"))).toBe(false);
    expect(ctx.ui.notify).toHaveBeenLastCalledWith(expect.stringContaining("Kanban off"), "info");
  });
  it("warns when a command toggle cannot be persisted while applying it for the session", async () => {
    writeFileSync(join(ctx.cwd, ".pi"), "not a directory");
    const command = pi.registerCommand.mock.calls.find(([name]: [string]) => name === "crew")[1];
    await command.handler("on", ctx);
    expect(ctx.ui.notify).toHaveBeenLastCalledWith(expect.stringContaining("session only; failed to persist"), "warning");
    const policy = await hooks.get("before_agent_start")({}, ctx);
    expect(policy.message.customType).toBe("kanban-policy");
  });
  it("removes only stale extension-owned Kanban context while off", () => {
    const ordinary = { role: "user", content: "User instructions" };
    const native = { role: "custom", customType: "subagent-notification", content: "Agent finished" };
    const messages = [ordinary, { role: "custom", customType: "kanban-policy", content: "Old policy" }, native, { role: "custom", customType: "kanban-update", content: "Old board update" }];
    expect(hooks.get("context")({ messages }).messages).toEqual([ordinary, native]);
    state.toggle!(true);
    expect(hooks.get("context")({ messages })).toBeUndefined();
  });
  it("does not initialize task storage through disabled commands", async () => {
    const command = pi.registerCommand.mock.calls.find(([name]: [string]) => name === "crew")[1];
    await command.handler("tasks", ctx);
    await command.handler("tasks pause-all", ctx);
    await command.handler("kban", ctx);
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Kanban is off"), "info");
    expect(tools.has("Kanban")).toBe(false);
    expect(existsSync(join(root, "agent", "kanban"))).toBe(false);
  });
  it("reports the loaded package version without starting agents or opening the interface", async () => {
    expect(pi.registerCommand.mock.calls.some(([name]: [string]) => name === "agents")).toBe(false);
    const command = pi.registerCommand.mock.calls.find(([name]: [string]) => name === "crew")[1];
    expect(command.description).toContain("/crew version");
    const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    const lock = JSON.parse(readFileSync(new URL("../package-lock.json", import.meta.url), "utf8"));
    expect(lock.version).toBe(manifest.version);
    expect(lock.packages[""].version).toBe(manifest.version);
    const opened = vi.mocked(startKanbanServer).mock.calls.length;
    await command.handler("  version  ", ctx);
    expect(ctx.ui.notify).toHaveBeenCalledWith(`pi-crew v${manifest.version} (loaded)`, "info");
    expect(vi.mocked(startKanbanServer).mock.calls).toHaveLength(opened);
    expect(tools.has("Kanban")).toBe(false);
  });
  it("uses native delegation without task storage, policy or tools when off", async () => {
    const policy = await hooks.get("before_agent_start")({ systemPrompt: "Original system" }, ctx);
    expect(policy.systemPrompt).toContain("Original system");
    expect(policy.systemPrompt).toContain("<direct_agent_workflow>");
    expect(policy.systemPrompt).toContain("human-readable");
    expect(policy.message).toBeUndefined();
    expect(tools.has("Kanban")).toBe(false);
    expect(existsSync(join(root, "agent", "kanban"))).toBe(false);
    expect(hooks.get("tool_call")?.({ toolName: "bash" }, ctx)?.block).not.toBe(true);
    const spawned = await call("Agent", { prompt: "fixture work", description: "Native fixture", subagent_type: "operate", run_in_background: true });
    const id = /Agent ID: (\S+)/.exec(spawned.content[0].text)![1];
    const manager = (globalThis as any)[managerKey];
    const record = manager.getRecord(id), signal = record.abortController.signal;
    state.toggle!(true);
    const enabledPolicy = await hooks.get("before_agent_start")({}, ctx);
    expect(enabledPolicy.message.customType).toBe("kanban-policy");
    const created = data(await call("Kanban", { action: "create", ...spec }));
    const staleTool = tools.get("Kanban");
    expect(signal.aborted).toBe(false);
    expect(hooks.get("tool_call")?.({ toolName: "Agent" }, ctx)?.block).not.toBe(true);
    // Native delegation remains usable while the optional interface is enabled.
    const second = await call("Agent", { prompt: "second fixture", description: "Second native fixture", subagent_type: "operate", run_in_background: true });
    expect(second.content[0].text).toContain("Agent ID:");
    const command = pi.registerCommand.mock.calls.find(([name]: [string]) => name === "crew")[1];
    await command.handler("kban", ctx);
    const web = await vi.mocked(startKanbanServer).mock.results.at(-1)!.value;
    state.toggle!(false);
    expect(web.close).toHaveBeenCalledOnce();
    expect(signal.aborted).toBe(false);
    expect(manager.getRecord(id)).toBe(record);
    expect(tools.get("Kanban").exposure).toBe("hidden");
    expect(tools.get("Kanban").promptGuidelines).toEqual([]);
    await expect(call("Kanban", { action: "list" })).rejects.toThrow("Kanban is off");
    await expect(staleTool.execute("stale", { action: "list" })).rejects.toThrow("Kanban is off");
    state.toggle!(true);
    expect(tools.get("Kanban").exposure).toBe("direct");
    const view = data(await call("Kanban", { action: "list" }));
    expect(view.harnessRuns.find((run: any) => run.id === id).status).toBe("running");
    expect(view.tasks.find((task: any) => task.id === created.id).column).toBe("backlog");
    await call("Kanban", { action: "pause-agent", id });
    expect(signal.aborted).toBe(true);
  });
  it("preserves a managed worker's binding, signal and snapshot across mode toggles", async () => {
    state.toggle!(true);
    await hooks.get("before_agent_start")({}, ctx);
    const task = data(await call("Kanban", { action: "create", ...spec }));
    await call("Kanban", { action: "ready", id: task.id });
    await vi.waitFor(async () => {
      const view = data(await call("Kanban", { action: "list" }));
      expect(view.harnessRuns).toHaveLength(1);
    });
    const before = data(await call("Kanban", { action: "get", id: task.id }));
    const view = data(await call("Kanban", { action: "list" }));
    const run = (globalThis as any)[managerKey].getRecord(view.harnessRuns[0].id);
    const signal = run.abortController.signal;
    state.toggle!(true); state.toggle!(false); state.toggle!(true);
    const after = data(await call("Kanban", { action: "get", id: task.id }));
    expect(after.lease.token).toBe(before.lease.token);
    expect(after.workspace).toBe(before.workspace);
    expect(signal.aborted).toBe(false);
    await call("Kanban", { action: "pause-all" });
    expect(signal.aborted).toBe(true);
    const paused = data(await call("Kanban", { action: "get", id: task.id }));
    expect(paused).toMatchObject({ column: "backlog", userPaused: true });
    await expect(call("Kanban", { action: "ready", id: task.id })).rejects.toThrow(/Only the user/);
  });
  it("closes a late web-server startup if the user toggles the interface off", async () => {
    state.toggle!(true);
    const web = { url: "http://127.0.0.1/#late", close: vi.fn(async () => {}) };
    let opened!: (value: typeof web) => void;
    vi.mocked(startKanbanServer).mockImplementationOnce(() => new Promise(resolve => { opened = resolve; }));
    const command = pi.registerCommand.mock.calls.find(([name]: [string]) => name === "crew")[1];
    const opening = command.handler("kban", ctx);
    state.toggle!(false); opened(web); await opening;
    expect(web.close).toHaveBeenCalledOnce();
    expect(ctx.ui.notify).not.toHaveBeenCalledWith(expect.stringContaining("#late"), "info");
    expect(tools.get("Kanban").exposure).toBe("hidden");
  });
  it("does not touch unavailable task storage while off, and falls back safely on enabled failure", async () => {
    rmSync(join(root, "agent"), { recursive: true, force: true });
    writeFileSync(join(root, "agent"), "not a directory");
    expect(() => hooks.get("before_agent_start")({}, ctx)).not.toThrow();
    expect(ctx.ui.notify).not.toHaveBeenCalled();
    state.toggle!(true);
    const policy = hooks.get("before_agent_start")({}, ctx);
    expect(policy).toBeUndefined();
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("ordinary tools remain available"), "warning");
    expect(tools.has("Agent")).toBe(true);
  });
  it("keeps task activation behind project trust without blocking ordinary tools", async () => {
    ctx.isProjectTrusted = () => false;
    state.toggle!(true);
    await hooks.get("before_agent_start")({}, ctx);
    expect(tools.has("Kanban")).toBe(false);
    expect(tools.has("Agent")).toBe(true);
    expect(hooks.get("tool_call")?.({ toolName: "edit" }, ctx)?.block).not.toBe(true);
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/agent-runner.js", async () => ({
  ...await vi.importActual<typeof import("../src/agent-runner.js")>("../src/agent-runner.js"),
  runAgent: vi.fn(), resumeAgent: vi.fn(),
}));

import { resumeAgent, runAgent } from "../src/agent-runner.js";
import subagentsExtension from "../src/index.js";
import { setParentModelInheritance } from "../src/model-inheritance.js";
import { ctx, flush, hermeticDir, makePi, textOf } from "./helpers/boot-extension.js";

const parent = { provider: "waypoint-local", id: "gpt-6.1-sol" };
let sandbox: ReturnType<typeof hermeticDir>;
let boot: ReturnType<typeof makePi>;
let context: ReturnType<typeof ctx>;

beforeEach(() => {
  sandbox = hermeticDir({ settings: {
    inheritParentModel: true, schedulingEnabled: false, outputTranscript: false,
    fleetView: false, widgetMode: "off",
  } });
  boot = makePi();
  context = ctx({ model: parent });
  subagentsExtension(boot.pi);
  vi.mocked(runAgent).mockImplementation(async (_ctx, _type, _prompt, options: any) => {
    const session = { model: parent, messages: [], dispose: vi.fn(), subscribe: vi.fn(() => vi.fn()) } as any;
    options.onSessionCreated?.(session);
    return { responseText: "done", session, aborted: false, steered: false };
  });
  vi.mocked(resumeAgent).mockResolvedValue({ text: "resumed", aborted: false, steered: false });
});

afterEach(async () => {
  await boot.lifecycle.get("session_shutdown")?.({}, context);
  sandbox.restore();
  setParentModelInheritance(false);
  vi.clearAllMocks();
});

describe("locked Agent tool", () => {
  it("omits model overrides from the real registered schema", () => {
    const tool = boot.tools.get("Agent");
    expect(tool.parameters.properties).not.toHaveProperty("model");
    expect(tool.description).toContain("Model overrides are disabled");
  });

  it("ignores a stale explicit override before registry resolution", async () => {
    const tool = boot.tools.get("Agent");
    const result = await tool.execute("spawn", {
      prompt: "test", description: "Test inheritance", subagent_type: "operate",
      model: "gpt-5.3-codex", run_in_background: false,
    }, undefined, undefined, context);
    expect(textOf(result)).toContain("done");
    expect(context.modelRegistry.find).not.toHaveBeenCalled();
    expect(vi.mocked(runAgent).mock.calls[0][3].model).toBe(parent);
  });

  it.each([false, true])("forwards the current parent to resumes (background=%s)", async (background) => {
    const tool = boot.tools.get("Agent");
    const spawned = await tool.execute("spawn", {
      prompt: "test", description: "Test inheritance", subagent_type: "operate", run_in_background: true,
    }, undefined, undefined, context);
    const id = /Agent ID: (\S+)/.exec(textOf(spawned))?.[1];
    expect(id).toBeTruthy();
    await flush();
    const current = { provider: "waypoint-local", id: "changed-parent" };
    const resumed = await tool.execute("resume", {
      prompt: "retry", description: "Retry inheritance", subagent_type: "operate",
      resume: id, model: "", run_in_background: background,
    }, undefined, undefined, { ...context, model: current });
    await flush();
    expect(textOf(resumed)).not.toContain("Error");
    expect(vi.mocked(resumeAgent).mock.calls.at(-1)?.[2].parentModel).toBe(current);
  });
});

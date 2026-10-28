import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveAgentInvocationConfig } from "../src/invocation-config.js";
import {
  enforceParentSessionModel,
  modelParam,
  requireParentModel,
  setParentModelInheritance,
} from "../src/model-inheritance.js";
import { applySettings } from "../src/settings.js";

const parent = { provider: "waypoint-local", id: "gpt-6.1-sol" } as any;
const rejected = { provider: "openai-codex", id: "gpt-5.3-codex" } as any;
afterEach(() => setParentModelInheritance(false));

describe("parent provider/model lock", () => {
  it("removes the override from the model-facing schema", () => {
    expect(modelParam()).toHaveProperty("model");
    setParentModelInheritance(true);
    expect(modelParam()).not.toHaveProperty("model");
  });

  it("ignores both tool-call and agent-file pins instead of resolving them", () => {
    setParentModelInheritance(true);
    for (const config of [undefined, { model: "openai-codex/gpt-5.3-codex" }]) {
      const result = resolveAgentInvocationConfig(config as any, { model: "gpt-5.3-codex" });
      expect(result.modelInput).toBeUndefined();
      expect(result.modelFromParams).toBe(false);
      expect(result.overridden?.model).toBe("gpt-5.3-codex");
    }
  });

  it.each(["", "   ", "default", "inherit", "parent", " DEFAULT "])("treats filler %j as inheritance even when unlocked", (model) => {
    expect(resolveAgentInvocationConfig(undefined, { model }).modelInput).toBeUndefined();
  });

  it("retains normal override precedence when unlocked", () => {
    expect(resolveAgentInvocationConfig(undefined, { model: "explicit" }).modelInput).toBe("explicit");
    expect(resolveAgentInvocationConfig({ model: "pinned" } as any, { model: "explicit" }).modelInput).toBe("pinned");
  });

  it("repairs the exact failed provider/model on resume", async () => {
    setParentModelInheritance(true);
    const session = { model: rejected, setModel: vi.fn(async () => {}) };
    await enforceParentSessionModel(session as any, parent);
    expect(session.setModel).toHaveBeenCalledExactlyOnceWith(parent);
  });

  it("inherits the parent's current selection rather than a previous model", async () => {
    setParentModelInheritance(true);
    const current = { provider: "waypoint-local", id: "another-model" } as any;
    const session = { model: parent, setModel: vi.fn(async () => {}) };
    await enforceParentSessionModel(session as any, current);
    expect(session.setModel).toHaveBeenCalledExactlyOnceWith(current);
  });

  it("does not change an already inherited session or an unlocked resume", async () => {
    const session = { model: parent, setModel: vi.fn() };
    setParentModelInheritance(true);
    await enforceParentSessionModel(session as any, parent);
    setParentModelInheritance(false);
    await enforceParentSessionModel(session as any, rejected);
    expect(session.setModel).not.toHaveBeenCalled();
  });

  it("fails closed when there is no current parent model", async () => {
    setParentModelInheritance(true);
    expect(() => requireParentModel(undefined)).toThrow("parent has no active model");
    const session = { model: rejected, setModel: vi.fn() };
    await expect(enforceParentSessionModel(session as any, undefined)).rejects.toThrow("parent has no active model");
    expect(session.setModel).not.toHaveBeenCalled();
  });

  it("propagates model-switch failure instead of using the stale model", async () => {
    setParentModelInheritance(true);
    const session = { model: rejected, setModel: vi.fn(async () => { throw new Error("unavailable parent"); }) };
    await expect(enforceParentSessionModel(session as any, parent)).rejects.toThrow("unavailable parent");
  });

  it("applies the persisted setting in both directions", () => {
    const apply = vi.fn(setParentModelInheritance);
    applySettings({ inheritParentModel: true }, { setInheritParentModel: apply } as any);
    expect(modelParam()).not.toHaveProperty("model");
    applySettings({ inheritParentModel: false }, { setInheritParentModel: apply } as any);
    expect(modelParam()).toHaveProperty("model");
  });
});

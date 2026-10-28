import type { Model } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { resolveDefaultModel } from "../src/agent-runner.js";
import { DEFAULT_AGENTS } from "../src/default-agents.js";
import { describeModel, resolveModel } from "../src/model-resolver.js";

const models = [
  { provider: "openai", id: "gpt-4o", name: "GPT-4o" },
  { provider: "google", id: "gemini-2.5-pro", name: "Gemini 2.5 Pro" },
  { provider: "ollama", id: "qwen2.5-coder:7b", name: "Qwen Coder" },
  { provider: "custom-gateway", id: "org/model-v1", name: "Custom Model" },
] as Model<"openai-completions">[];

function registry() {
  return {
    find: vi.fn((provider: string, id: string) => models.find(m => m.provider === provider && m.id === id)),
    getAll: () => models,
    getAvailable: () => models,
  };
}

describe("provider-neutral agent defaults", () => {
  for (const parent of models) {
    it(`inherits ${parent.provider}/${parent.id} for every built-in agent without querying another provider`, () => {
      const available = registry();
      for (const config of DEFAULT_AGENTS.values()) {
        expect(resolveDefaultModel(parent, available, config.model)).toBe(parent);
      }
      expect(available.find).not.toHaveBeenCalled();
    });

    it(`resolves explicit ${parent.provider}/${parent.id} without Anthropic configured`, () => {
      expect(resolveModel(`${parent.provider}/${parent.id}`, registry())).toBe(parent);
    });

    it(`honors a custom agent's ${parent.provider} model pin over the parent`, () => {
      expect(resolveDefaultModel(models[(models.indexOf(parent) + 1) % models.length], registry(), `${parent.provider}/${parent.id}`))
        .toBe(parent);
    });

    it(`preserves the ${parent.provider} model's identity in UI labels`, () => {
      expect(describeModel(parent)).toEqual({
        modelName: parent.name.toLowerCase(),
        modelId: `${parent.provider}/${parent.id}`,
      });
    });
  }

  it("does not invent a provider when there is no parent model", () => {
    for (const config of DEFAULT_AGENTS.values()) {
      expect(resolveDefaultModel(undefined, registry(), config.model)).toBeUndefined();
    }
  });

  it("reports unavailable models rather than requiring Anthropic credentials", () => {
    expect(resolveModel("nonexistent-model", registry())).toContain("Available models:");
    expect(resolveModel("nonexistent-model", registry())).not.toContain("anthropic/");
  });
});

import { describe, expect, it, vi } from "vitest";
import { runAgentsDemo } from "../src/demo.js";

describe("native agents demo", () => {
  it("runs two parallel workers before independent tester and reviewer", async () => {
    const names: string[] = [];
    const run = vi.fn(async (name: string) => {
      names.push(name);
      return { status: "completed", result: name.endsWith("A") ? "4" : name.endsWith("B") ? "tac" : '{"score":100,"passed":true}' };
    });
    const result = await runAgentsDemo({ run, report: vi.fn() });
    expect(result.passed).toBe(true);
    expect(names).toEqual(["Demo worker A", "Demo worker B", "Demo tester", "Demo reviewer"]);
    expect(result.message).toContain("not managed certification");
  });
  it("rejects wrong worker output despite inflated scores", async () => {
    const result = await runAgentsDemo({ report: vi.fn(), run: async name => ({ status: "completed", result: name.includes("worker") ? "wrong" : '{"score":100,"passed":true}' }) });
    expect(result.passed).toBe(false);
  });
  it("rejects malformed scores without claiming success", async () => {
    const result = await runAgentsDemo({ report: vi.fn(), run: async name => ({ status: "completed", result: name.endsWith("A") ? "4" : name.endsWith("B") ? "tac" : "not JSON" }) });
    expect(result.passed).toBe(false);
  });
  it("cancels hanging agents at the deadline", async () => {
    vi.useFakeTimers();
    try {
      let signal: AbortSignal | undefined;
      const pending = runAgentsDemo({ report: vi.fn(), run: async (_name, _prompt, s) => { signal = s; return new Promise(() => {}); } }, 1_000);
      await vi.advanceTimersByTimeAsync(1_000);
      const result = await pending;
      expect(result.passed).toBe(false);
      expect(result.timedOut).toBe(true);
      expect(signal?.aborted).toBe(true);
    } finally { vi.useRealTimers(); }
  });
  it("does not launch on an already cancelled signal", async () => {
    const abort = new AbortController(); abort.abort();
    const run = vi.fn();
    const result = await runAgentsDemo({ run, report: vi.fn(), signal: abort.signal });
    expect(result.passed).toBe(false);
    expect(run).not.toHaveBeenCalled();
  });
});

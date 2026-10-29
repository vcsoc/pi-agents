import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { bindKanbanGate, type KanbanBinding } from "../src/kanban/agent.js";

function fixture(observe = vi.fn()) {
  let emit!: (event: any) => void;
  const session = { subscribe: (handler: typeof emit) => { emit = handler; }, agent: {} } as unknown as AgentSession;
  bindKanbanGate(session, { observe, assertAllowed: () => {} } as unknown as KanbanBinding);
  return { emit: (event: any) => emit(event), observe };
}
describe("observable SDK worker audit", () => {
  it("uses real thinking signals, never message text or token-by-token persistence", () => {
    const { emit, observe } = fixture();
    emit({ type: "agent_start" });
    emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "waiting on user password=private" } });
    emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "more tokens" } });
    expect(observe.mock.calls.map(c => c[2])).toEqual(["working", "working"]);
    emit({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "hidden secret" } });
    emit({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "more hidden secret" } });
    expect(observe).toHaveBeenLastCalledWith("assistant thinking signalled", null, "thinking");
    expect(observe).toHaveBeenCalledTimes(3);
    expect(JSON.stringify(observe.mock.calls)).not.toContain("secret");
    expect(JSON.stringify(observe.mock.calls)).not.toContain("private");
  });
  it("observes each thinking phase across repeated tool cycles while deduplicating contiguous deltas", () => {
    let state: string | undefined;
    const observer = vi.fn((_event: string, _duration: number | null | undefined, next?: string) => { if (next) state = next; });
    const { emit, observe } = fixture(observer);
    const think = () => emit({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "private thought" } });
    emit({ type: "agent_start" });
    think(); think();
    expect(state).toBe("thinking");
    for (let cycle = 0; cycle < 3; cycle++) {
      emit({ type: "tool_execution_start", toolCallId: String(cycle), toolName: "read" });
      expect(state).toBe("working");
      emit({ type: "tool_execution_end", toolCallId: String(cycle), toolName: "read", isError: false });
      think(); think();
      expect(state).toBe("thinking");
      expect(observe.mock.calls.filter(c => c[0] === "assistant thinking signalled")).toHaveLength(cycle + 2);
    }
    expect(JSON.stringify(observe.mock.calls)).not.toContain("private thought");
  });
  it("starts a fresh generation phase after assistant message boundaries", () => {
    const { emit, observe } = fixture();
    for (let message = 0; message < 2; message++) {
      emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "private response" } });
      emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "more tokens" } });
      emit({ type: "message_end", message: { role: "assistant" } });
    }
    expect(observe.mock.calls.map(c => c[0])).toEqual([
      "assistant response started", "assistant message completed", "assistant response started", "assistant message completed",
    ]);
    expect(JSON.stringify(observe.mock.calls)).not.toContain("private response");
  });
  it("measures end/error/abort from tool start and does not record tool args or results", () => {
    const { emit, observe } = fixture();
    emit({ type: "tool_execution_start", toolCallId: "1", toolName: "read", args: { token: "private" } });
    emit({ type: "tool_execution_end", toolCallId: "1", toolName: "read", isError: false, result: "secret result" });
    emit({ type: "tool_execution_start", toolCallId: "2", toolName: "bash" });
    emit({ type: "tool_execution_end", toolCallId: "2", toolName: "bash", isError: true });
    emit({ type: "tool_execution_start", toolCallId: "3", toolName: "write" });
    emit({ type: "agent_end" });
    const calls = observe.mock.calls;
    for (const label of ["tool end: read", "tool error: bash", "tool abort: write"]) {
      const event = calls.find(c => c[0] === label)!; expect(event[1]).toBeGreaterThanOrEqual(0);
    }
    expect(observe).toHaveBeenLastCalledWith("worker turn ended", null, "idle");
    expect(JSON.stringify(calls)).not.toContain("private"); expect(JSON.stringify(calls)).not.toContain("secret result");
    emit({ type: "agent_end" }); expect(calls.filter(c => c[0] === "tool abort: write")).toHaveLength(1);
  });
  it("labels missing tool start durations unknown and contains observer failures", () => {
    const { emit, observe } = fixture();
    emit({ type: "tool_execution_end", toolCallId: "missing", toolName: "read", isError: true });
    expect(observe).toHaveBeenLastCalledWith("tool error: read", null);
    observe.mockImplementation(() => { throw new Error("store temporarily busy"); });
    expect(() => emit({ type: "agent_start" })).not.toThrow();
    expect(() => emit({ type: "tool_execution_start", toolCallId: "1", toolName: "bash" })).not.toThrow();
    expect(() => emit({ type: "agent_end" })).not.toThrow();
  });
});

import type { AgentSession, InlineExtension, ToolDefinition } from "@earendil-works/pi-coding-agent";

export interface KanbanBinding {
  prompt: string;
  identity?: import("./store.js").WorkerIdentity;
  observe?: (event: string, durationMs?: number | null, state?: import("./store.js").WorkerState) => void;
  tool: ToolDefinition<any, any>;
  assertAllowed: (toolName: string) => void;
}
export function kanbanGate(binding: KanbanBinding): InlineExtension {
  return {
    name: "pi-agents-kanban-gate", hidden: true,
    factory: pi => {
      pi.on("tool_call", event => {
        try { binding.assertAllowed(event.toolName); } catch (e) { return { block: true, reason: String(e) }; }
      });
    },
  };
}
export function bindKanbanGate(session: AgentSession, binding: KanbanBinding): void {
  const tools = new Map<string, { name: string; started: number }>();
  let generation: "thinking" | "working" | undefined;
  let auditFailure: string | undefined;
  // Preserve SDK cleanup, but fail closed before any subsequent tool execution.
  const observe: NonNullable<KanbanBinding["observe"]> = (...args) => {
    try { binding.observe?.(...args); } catch (e) { auditFailure = `Audit delivery degraded: ${String(e)}. Stop work and recover the durable audit outbox.`; }
  };
  session.subscribe(event => {
    if (event.type === "message_update") {
      const kind = event.assistantMessageEvent.type;
      const state = kind === "thinking_delta" ? "thinking" : kind === "text_delta" ? "working" : undefined;
      if (state && generation !== state) { generation = state; observe(`assistant ${state === "thinking" ? "thinking signalled" : "response started"}`, null, state); }
    }
    if (event.type === "tool_execution_start") {
      // Dedupe only contiguous generation deltas, never across tool phases.
      generation = undefined;
      tools.set(event.toolCallId, { name: event.toolName, started: performance.now() });
      observe(`tool start: ${event.toolName}`, null, "working");
    } else if (event.type === "tool_execution_end") {
      generation = undefined;
      const tool = tools.get(event.toolCallId);
      tools.delete(event.toolCallId);
      observe(`tool ${event.isError ? "error" : "end"}: ${event.toolName}`, tool ? Math.max(0, performance.now() - tool.started) : null);
    } else if (event.type === "agent_end") {
      generation = undefined;
      for (const tool of tools.values()) observe(`tool abort: ${tool.name}`, Math.max(0, performance.now() - tool.started));
      tools.clear();
      observe("worker turn ended", null, "idle");
    } else if (event.type === "agent_start") { generation = undefined; observe("worker turn started", null, "working"); }
    else if (event.type === "message_end" && event.message.role === "assistant") { generation = undefined; observe("assistant message completed"); }
  });
  const prior = session.agent.beforeToolCall;
  session.agent.beforeToolCall = async (context, signal) => {
    if (auditFailure) return { block: true, reason: auditFailure };
    try { binding.assertAllowed(context.toolCall.name); } catch (e) { return { block: true, reason: String(e) }; }
    return prior?.(context, signal);
  };
}

import type { AgentSession, InlineExtension, ToolDefinition } from "@earendil-works/pi-coding-agent";

export interface KanbanBinding {
  prompt: string;
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
  const prior = session.agent.beforeToolCall;
  session.agent.beforeToolCall = async (context, signal) => {
    try { binding.assertAllowed(context.toolCall.name); } catch (e) { return { block: true, reason: String(e) }; }
    return prior?.(context, signal);
  };
}

import type { ToolRenderers } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
// Bound before normalization, and never interpret task-owned terminal escapes.
const brief = (value: unknown, max = 160): string => typeof value === "string"
  ? value.slice(0, max + 1).replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max) + (value.length > max ? "…" : "")
  : "";
const identity = (task: Record<string, unknown>): string =>
  [brief(task.id, 40), brief(task.title, 100)].filter(Boolean).join(" · ");
const state = (task: Record<string, unknown>): string => {
  if (record(task.disposition).kind === "cancelled") return "cancelled (not accepted)";
  if (task.archived) return "archived";
  return [brief(task.column ?? task.state ?? task.status, 40), brief(task.phase, 30)].filter(Boolean).join(" / ");
};

function nextSteps(task: Record<string, unknown>): string[] {
  const id = brief(task.id, 40) || "this task";
  const lines: string[] = [];
  const worker = task.workerStatus ? record(task.workerStatus) : task;
  const blocked = brief(task.blocked, 320);
  if (blocked) lines.push(`Blocked: ${blocked}`, `Next: ask the agent to inspect Kanban get for ${id} and resolve the blocker before retrying.`);
  if (task.suspension) lines.push("Waiting for dependencies to be accepted Done; ask the agent to inspect the task's blocking links with Kanban get.");
  if (worker.state === "waiting_user" || task.approvalRequired === true) {
    lines.push(`User action required: ${brief(worker.reason ?? task.reason, 320) || "approval or clarification needed"}`,
      `Next: reply in Pi with your decision for ${id}; the agent must use the required approval flow before continuing.`);
  } else if (worker.state === "waiting_dependency") {
    lines.push(`Waiting on ${brief(worker.dependencyId, 40) || "dependency"}: ${brief(worker.reason, 240)}`);
  }
  if (task.column === "backlog" && !task.archived && !task.disposition) lines.push(`Paused in Backlog. To start, ask the agent to refine ${id} if needed, then call Kanban ready with that id.`);
  if (task.userPaused && task.column !== "backlog") lines.push(`Paused by user. To resume, ask the agent to call Kanban ready for ${id}.`);
  return lines;
}

function outcome(task: Record<string, unknown>, action: string): { status: string; failed: boolean; next?: string } | undefined {
  if (action === "test") {
    const tests = Array.isArray(task.tests) ? task.tests : [];
    const latest = record(tests.at(-1));
    if (typeof latest.exitCode !== "number") return { status: "test outcome unavailable", failed: false };
    const failed = latest.exitCode !== 0;
    return { status: `test ${failed ? "failed" : "passed"} (exit ${latest.exitCode})`, failed,
      next: failed ? "Next: expand diagnostics, address the failure, then ask the tester to rerun the exact recorded command with KanbanTask test." : undefined };
  }
  if (action === "evaluate") {
    // A below-threshold evaluation resets current evidence; its audit event is retained.
    const history = Array.isArray(task.history) ? task.history : [];
    let event: unknown;
    for (let i = history.length - 1; i >= 0; i--) {
      if (record(history[i]).event === "rubric evaluation") { event = history[i]; break; }
    }
    const evaluations = Object.values(record(task.evaluations)).map(record);
    const evaluation = event ? record(record(event).data) : evaluations.sort((a, b) => brief(a.at).localeCompare(brief(b.at))).at(-1);
    if (!evaluation || typeof evaluation.total !== "number" || !Number.isFinite(evaluation.total)) return { status: "evaluation outcome unavailable", failed: false };
    const failed = evaluation.total < 85;
    return { status: `evaluation ${evaluation.total.toFixed(2)}% · ${failed ? "changes requested (below 85%)" : "threshold met (not task acceptance)"}`, failed,
      next: failed ? "Next: expand evaluation/fix instructions; ask the operator to address them, then resubmit for independent tests and evaluation." : undefined };
  }
  return undefined;
}

/** Presentation only: content/details remain untouched for model, audit and persistence. */
export const kanbanRenderers: ToolRenderers = {
  renderCall(args, theme) {
    const data = record(args);
    return new Text(theme.fg("toolTitle", `Kanban ${brief(data.action, 32) || "request"}`)
      + (identity(data) ? ` · ${identity(data)}` : ""), 0, 0);
  },
  renderResult(result, { expanded, isPartial }, theme, context) {
    const data = record(result.details);
    const args = record(context?.args);
    const action = brief(args.action, 32) || "result";
    const error = context?.isError || !!data.error;
    const current = !error && !isPartial ? outcome(data, action) : undefined;
    const failed = error || current?.failed;
    const lines = [`Kanban ${action} · ${error ? "error" : isPartial ? "updating…" : current?.status ?? "received"}`];
    if (current?.next) lines.push(current.next);
    if (error) {
      const error = typeof data.error === "string" ? data.error : record(data.error).message;
      const text = result.content?.find(part => part.type === "text");
      const reason = error ?? (text?.type === "text" ? text.text : undefined);
      // Structured payloads are diagnostics, not a useful collapsed error message.
      const summary = brief(reason, 480);
      lines.push(summary.startsWith("{") || summary.startsWith("[") ? "Request failed; expand for error details." : summary || "Request failed; expand for details.");
      lines.push("Next: ask the agent to address this error before retrying; required approvals still apply.");
    }
    const tasks = Array.isArray(result.details) ? result.details : Array.isArray(data.tasks) ? data.tasks : undefined;
    if (tasks) {
      const runs = Array.isArray(data.harnessRuns) ? data.harnessRuns : [];
      lines.push(`${tasks.length} task(s) · ${runs.length} live run(s)`);
      for (const task of tasks.slice(0, 3)) {
        const item = record(task);
        lines.push(`${identity(item) || "Task"} · ${state(item) || "status unavailable"}${item.blocked || item.suspension ? " · blocked" : ""}`);
      }
      if (tasks.length > 3) lines.push(`${tasks.length - 3} more task(s); expand for details.`);
      const attention = tasks.find(task => record(record(task).workerStatus).state === "waiting_user" || record(task).approvalRequired === true);
      if (attention) lines.push(...nextSteps(record(attention)));
      lines.push("For task actions/blockers, ask the agent to call Kanban get with the task id.");
    } else if (identity(data) || data.column || data.state) {
      lines.push([identity(data), state(data)].filter(Boolean).join(" · "));
      if (data.reason && !data.column) lines.push(brief(data.reason, 320));
      lines.push(...nextSteps(data));
    } else if (!failed && !isPartial) {
      lines.push(brief(data.summary, 240) || "Result available; expand for details.");
    }
    if (!expanded) lines.push("Expand tool output for diagnostics (Pi app.tools.expand; default Ctrl+O, see /hotkeys).");
    if (expanded) {
      lines.push("Diagnostics:");
      try {
        lines.push(JSON.stringify(result.details, null, 2) ?? "No structured details.");
      } catch {
        lines.push("Structured details cannot be serialized.");
      }
      for (const part of result.content ?? []) if (part.type === "text") lines.push(part.text);
    }
    return new Text(theme.fg(failed ? "error" : "muted", lines.join("\n")), 0, 0);
  },
};

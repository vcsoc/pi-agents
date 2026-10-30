import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { KanbanController } from "../src/kanban/controller.js";
import { kanbanRenderers } from "../src/kanban/render.js";

const theme = { fg: (_: string, text: string) => text } as any;
function render(details: unknown, options: { expanded?: boolean; isPartial?: boolean; isError?: boolean; action?: string; text?: string; width?: number } = {}) {
  const result = { details, content: [{ type: "text" as const, text: options.text ?? JSON.stringify(details) ?? "" }] };
  const before = JSON.stringify(result);
  const component = kanbanRenderers.renderResult!(result, { expanded: options.expanded ?? false, isPartial: options.isPartial ?? false }, theme,
    { args: { action: options.action ?? "get" }, isError: options.isError ?? false } as any);
  const lines = component.render(options.width ?? 100);
  expect(JSON.stringify(result)).toBe(before);
  return lines.join("\n");
}
const huge = { id: "task-123", title: "Readable task", column: "in progress", phase: "operator", scope: "SECRET_SCOPE".repeat(10000), history: [{ data: "SECRET_HISTORY".repeat(10000) }], tests: [{ output: "SECRET_TESTS".repeat(10000) }] };
describe("Kanban tool presentation", () => {
  it("bounds huge collapsed results and hides scope/history/tests/JSON", () => {
    const output = render(huge);
    expect(output.length).toBeLessThan(500);
    expect(output).toContain("task-123 · Readable task");
    expect(output).toContain("in progress / operator");
    expect(output).not.toMatch(/SECRET|\{|"history"/);
    expect(output).toContain("Ctrl+O");
    const expanded = render(huge, { expanded: true });
    expect(expanded).toContain("SECRET_HISTORY");
    expect(expanded).toContain("SECRET_SCOPE");
    expect(expanded).toContain("SECRET_TESTS");
  });
  it.each([0, 1, 127])("summarizes latest native command exit %s without dumping evidence", exitCode => {
    const task = { ...huge, column: "review", phase: "tester", tests: [{ exitCode: 1, command: "old" }, { command: "npm test", exitCode, output: "PRIVATE_COMMAND_OUTPUT" }] };
    const output = render(task, { action: "test" });
    expect(output).toContain(`test ${exitCode === 0 ? "passed" : "failed"} (exit ${exitCode})`);
    expect(output.length).toBeLessThan(1000);
    expect(output).not.toMatch(/PRIVATE|SECRET|npm test/);
    if (exitCode) expect(output.replace(/\s+/g, " ")).toContain("rerun the exact recorded command with KanbanTask test");
    expect(render(task, { action: "test", expanded: true })).toContain("PRIVATE_COMMAND_OUTPUT");
  });
  it.each([77.5, 85, 99])("summarizes native evaluation %s including reset evidence", total => {
    const evaluation = { role: "tester", total, notes: "PRIVATE_FIX_INSTRUCTIONS", at: "2026-10-30T15:00:00Z" };
    const task = { ...huge, column: total < 85 ? "ready" : "review", evaluations: total < 85 ? {} : { tester: evaluation }, history: [{ event: "rubric evaluation", data: evaluation }] };
    const output = render(task, { action: "evaluate" });
    expect(output).toContain(`evaluation ${total.toFixed(2)}%`);
    expect(output).toContain(total < 85 ? "changes requested" : "not task acceptance");
    if (total < 85) expect(output).toContain("ask the operator to address them");
    expect(output).not.toMatch(/PRIVATE|SECRET/);
    expect(output.length).toBeLessThan(1000);
    expect(render(task, { action: "evaluate", expanded: true })).toContain("PRIVATE_FIX_INSTRUCTIONS");
    if (total >= 85) expect(render({ ...task, history: [] }, { action: "evaluate" })).toContain(total.toFixed(2));
  });
  it("does not invent outcomes for incomplete native evidence", () => {
    expect(render({ ...huge, tests: [{}] }, { action: "test" })).toContain("outcome unavailable");
    expect(render({ ...huge, evaluations: {} }, { action: "evaluate" })).toContain("outcome unavailable");
    expect(render({ ...huge, tests: [{ exitCode: 1 }] }, { action: "test", isPartial: true })).toContain("updating…");
  });
  it("renders compact calls without dumping request details", () => {
    const call = kanbanRenderers.renderCall!({ ...huge, action: "edit" }, theme, {} as any).render(100).join("\n");
    expect(call).toContain("Kanban edit");
    expect(call).toContain("Readable task");
    expect(call).not.toContain("SECRET");
  });
  it("bounds lists while reporting counts, live runs and user action outside the first three tasks", () => {
    const tasks = Array.from({ length: 1000 }, (_, i) => ({ id: `task-${i}`, title: huge.title, column: huge.column, history: ["SECRET_HISTORY".repeat(100)] }));
    tasks[999] = { ...tasks[999], workerStatus: { state: "waiting_user", reason: "Approve dependency install" } } as any;
    const output = render({ tasks, harnessRuns: [{ id: "native-1" }] }, { action: "list" });
    expect(output).toContain("1000 task(s) · 1 live run(s)");
    expect(output).toContain("997 more");
    expect(output).toContain("Approve dependency install");
    expect(output).toContain("reply in Pi");
    expect(output.length).toBeLessThan(1400);
    expect(output).not.toContain("SECRET");
  });
  it("reports blockers, holds, cancellation and dependency waits without inventing acceptance", () => {
    expect(render({ ...huge, blocked: "Audit unavailable" })).toContain("Blocked: Audit unavailable");
    expect(render({ ...huge, blocked: "Audit unavailable" })).toContain("resolve the blocker before retrying");
    expect(render({ ...huge, column: "backlog" })).toContain("Kanban ready");
    expect(render({ ...huge, disposition: { kind: "cancelled" }, column: "done" })).toContain("cancelled (not accepted)");
    expect(render({ ...huge, suspension: { dependencyIds: ["dep"] } })).toContain("accepted Done");
    expect(render({ state: "waiting_user", reason: "Need approval" })).toContain("reply in Pi");
    expect(render({ ...huge, workerStatus: { state: "waiting_dependency", reason: "Review", dependencyId: "dep-123" } })).toContain("dep-123");
  });
  it("shows thrown errors with empty details, structured errors and approval instructions", () => {
    const output = render({}, { isError: true, text: "Permission denied: obtain user approval" });
    expect(output).toContain("Permission denied");
    expect(output).toContain("required approvals still apply");
    expect(output).not.toContain("received");
    expect(render({ error: { message: "Task blocked" } })).toContain("Task blocked");
    expect(render({}, { isError: true, text: '{"history":"PRIVATE"}' })).not.toContain("PRIVATE");
    expect(render({}, { isError: true, text: "diagnostic", expanded: true })).toContain("diagnostic");
  });
  it("handles empty, malformed and partial data defensively", () => {
    for (const value of [undefined, null, {}, [], { tasks: [null, 12, {}] }]) expect(() => render(value)).not.toThrow();
    expect(render(undefined, { isPartial: true })).toContain("updating…");
    expect(render({ tasks: [] })).toContain("0 task(s)");
    expect(render({ id: "comment", summary: "Added evidence" })).not.toContain("SECRET");
  });
  it("fits narrow terminal widths and normalizes task-owned control characters", () => {
    const output = render({ ...huge, title: "界".repeat(1000) + "\n\u001b[31m" }, { width: 22 });
    for (const line of output.split("\n")) expect(visibleWidth(line)).toBeLessThanOrEqual(22);
    expect(output).not.toContain("\u001b");
  });
  it("wires the shared renderers into both native task tools", async () => {
    // Constructors do not own renderer behavior; inspect definitions without starting workers.
    const tool = KanbanController.prototype.orchestratorTool.call({} as KanbanController);
    expect(tool.renderCall).toBe(kanbanRenderers.renderCall);
    expect(tool.renderResult).toBe(kanbanRenderers.renderResult);
    const { readFileSync } = await import("node:fs");
    const source = readFileSync(new URL("../src/kanban/controller.ts", import.meta.url), "utf8");
    expect(source).toContain('name: "KanbanTask", label: "Kanban task", ...kanbanRenderers');
  });
});

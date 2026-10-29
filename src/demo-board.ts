import { createHash, randomUUID } from "node:crypto";
import type { ReadOnlyKanbanSource } from "./kanban/server.js";
import type { Board, Task } from "./kanban/store.js";

export const DEMO_BOARD_ID = createHash("sha256").update("agents demo").digest("hex");
const names = ["Demo worker A", "Demo worker B", "Demo tester", "Demo reviewer"];

// Deliberately in-memory: no project path, store, scheduler, leases or certification.
export class DemoBoard implements ReadOnlyKanbanSource {
  readonly readOnly = true as const;
  private readonly board: Board;
  constructor() {
    const at = new Date().toISOString();
    this.board = {
      version: 1, id: DEMO_BOARD_ID, name: "agents demo (virtual, not managed certification)",
      projectPath: "agents demo", sequence: 1,
      tasks: names.map((title): Task => ({
        id: randomUUID(), title, scope: "Isolated native demonstration only. Scores are illustrative, not managed certification.",
        assignee: "operate", testerAgent: "operate", reviewerAgent: "operate", column: "ready", phase: title === "Demo tester" ? "tester" : title === "Demo reviewer" ? "reviewer" : "operator",
        revision: 1, rubric: [{ title: "Correctness", weight: 80 }, { title: "Exact formatting", weight: 20 }],
        evaluations: {}, tests: [], comments: [], history: [], archived: false, createdAt: at, updatedAt: at,
        prMode: "none", mergeApproved: false, runs: 0, maxRuns: 1,
      })),
    };
  }
  view() { return { ...structuredClone(this.board), activity: [], harnessRuns: [] }; }
  update(name: string, state: "running" | "completed", details?: string) {
    const task = this.board.tasks.find(t => t.title === name);
    if (!task) return;
    const at = new Date().toISOString();
    task.column = state === "running" ? "in progress" : "done";
    task.updatedAt = at;
    if (state === "running") task.runs = 1;
    task.history.push({ id: randomUUID(), at, actor: name, event: `demo ${state}`, data: details, durationMs: null });
    if (details) task.comments.push({ id: randomUUID(), at, author: name, text: details, summary: "Demo output", details });
    this.board.sequence++;
  }
  finish(passed: boolean, message: string) {
    const at = new Date().toISOString();
    for (const task of this.board.tasks) {
      if (!passed && task.column !== "done") task.blocked = message;
      task.comments.push({ id: randomUUID(), at, author: "demo", text: message, summary: passed ? "Demo passed (not managed certification)" : "Demo stopped", details: message });
      task.updatedAt = at;
    }
    this.board.sequence++;
  }
}

import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { DEMO_BOARD_ID, DemoBoard } from "../src/demo-board.js";
import { startKanbanServer } from "../src/kanban/server.js";

describe("isolated virtual demo board", () => {
  it("uses the literal agents demo hash and no project folder", () => {
    const board = new DemoBoard();
    expect(board.view().id).toBe(createHash("sha256").update("agents demo").digest("hex"));
    expect(board.view().id).toBe(DEMO_BOARD_ID);
    expect(board.view().projectPath).toBe("agents demo");
    expect(board.view().tasks).toHaveLength(4);
    expect(board.view().tasks.every(t => t.column === "ready")).toBe(true);
  });
  it("updates cards with outputs and final result without fabricating managed evidence", () => {
    const board = new DemoBoard();
    board.update("Demo worker A", "running");
    expect(board.view().tasks[0].column).toBe("in progress");
    board.update("Demo worker A", "completed", "4");
    board.finish(true, "PASS, not managed certification");
    const task = board.view().tasks[0];
    expect(task.column).toBe("done");
    expect(task.comments[0].details).toBe("4");
    expect(task.evaluations).toEqual({});
    expect(task.tests).toEqual([]);
    expect(new DemoBoard().view().tasks.every(t => t.column === "ready")).toBe(true);
  });
  it("marks unfinished cards blocked after cancellation", () => {
    const board = new DemoBoard();
    board.update("Demo worker A", "running");
    board.finish(false, "Timed out");
    expect(board.view().tasks.every(t => t.blocked === "Timed out")).toBe(true);
  });
  it("serves only the virtual board and rejects mutation or dispatch over HTTP", async () => {
    const board = new DemoBoard();
    const server = await startKanbanServer(board);
    const url = new URL(server.url);
    const headers = { Authorization: `Bearer ${url.hash.slice(1)}`, "Content-Type": "application/json" };
    try {
      const response = await fetch(`${url.origin}/api/board`, { headers });
      expect(response.status).toBe(200);
      expect((await response.json()).id).toBe(DEMO_BOARD_ID);
      const sequence = board.view().sequence;
      for (const action of ["create", "move", "cancel", "pause-all", "archive-done"]) {
        const mutation = await fetch(`${url.origin}/api/action`, { method: "POST", headers, body: JSON.stringify({ action }) });
        expect(mutation.status).toBe(403);
      }
      expect(board.view().sequence).toBe(sequence);
      board.update("Demo tester", "running");
      const updated = await (await fetch(`${url.origin}/api/board`, { headers })).json();
      expect(updated.tasks[2].column).toBe("in progress");
    } finally { await server.close(); }
  });
});

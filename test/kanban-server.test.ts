import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Script } from "node:vm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { KanbanController } from "../src/kanban/controller.js";
import { type KanbanWebServer, startKanbanServer } from "../src/kanban/server.js";
import { KanbanStore } from "../src/kanban/store.js";
import { KANBAN_HTML, KANBAN_SCRIPT } from "../src/kanban/web.js";

let root: string, store: KanbanStore, controller: KanbanController, server: KanbanWebServer, origin: string, headers: Record<string, string>;
const input = { title: "<script>alert('xss')</script>", scope: "Test full API", assignee: "operate", rubric: [{ title: "Correctness", weight: 100 }] };
async function post(data: unknown, extra?: Record<string, string>) { return fetch(origin + "/api/action", { method: "POST", headers: { ...headers, ...extra }, body: JSON.stringify(data) }); }
beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "pi-kanban-server-")); const cwd = join(root, "project"); mkdirSync(cwd);
  store = new KanbanStore(cwd, join(root, "state"));
  controller = new KanbanController(store, { spawn: () => { throw new Error("No model calls in HTTP tests"); }, record: () => undefined, stop: vi.fn(), steer: vi.fn(), validAgent: () => true, notify: vi.fn() });
  server = await startKanbanServer(controller); const url = new URL(server.url); origin = url.origin; headers = { Authorization: "Bearer " + url.hash.slice(1), "Content-Type": "application/json" };
});
afterEach(async () => { await server.close(); await controller.close(); rmSync(root, { recursive: true, force: true }); });
describe("loopback-only authenticated Kanban web server", () => {
  it("serves the page and CSP without exposing authentication in its HTML", async () => { const response = await fetch(origin); expect(response.status).toBe(200); expect(response.headers.get("content-security-policy")).toContain("frame-ancestors 'none'"); expect(await response.text()).not.toContain(headers.Authorization); });
  it("requires bearer authentication for board data and events", async () => { expect((await fetch(origin + "/api/board")).status).toBe(401); expect((await fetch(origin + "/api/events")).status).toBe(401); });
  it("rejects a wrong bearer token", async () => { expect((await fetch(origin + "/api/board", { headers: { Authorization: "Bearer wrong" } })).status).toBe(401); });
  it("rejects cross-origin requests even with the token", async () => { expect((await fetch(origin + "/api/board", { headers: { ...headers, Origin: "https://untrusted.example" } })).status).toBe(403); });
  it("rejects hostile Host headers to prevent DNS rebinding", async () => {
    const status = await new Promise<number | undefined>((resolve, reject) => {
      const req = request(origin + "/api/board", { headers: { ...headers, Host: "untrusted.example" } }, response => { response.resume(); resolve(response.statusCode); });
      req.on("error", reject); req.end();
    });
    expect(status).toBe(403);
  });
  it("returns current durable project state", async () => { const task = store.create(input, "orchestrator"); const response = await fetch(origin + "/api/board", { headers }); expect(response.status).toBe(200); expect((await response.json()).tasks[0].id).toBe(task.id); });
  it("streams the initial board and updates without reloading", async () => {
    const abort = new AbortController(); const response = await fetch(origin + "/api/events", { headers, signal: abort.signal });
    const reader = response.body!.getReader(); const initial = new TextDecoder().decode((await reader.read()).value); expect(initial).toContain("data: ");
    const task = store.create(input, "orchestrator");
    let update = ""; while (!update.includes(task.id)) update += new TextDecoder().decode((await reader.read()).value);
    expect(update).toContain(task.id); abort.abort(); await reader.cancel().catch(() => {});
  });
  it("archives tasks without deleting comments/history", async () => { const task = store.create(input, "orchestrator"); const response = await post({ action: "archive", id: task.id, expectedUpdatedAt: task.updatedAt }); expect(response.status).toBe(200); expect(store.read().tasks[0].archived).toBe(true); expect(store.read().tasks[0].history).toHaveLength(2); });
  it("rejects stale browser actions with a conflict response", async () => { const task = store.create(input, "orchestrator"); store.comment(task.id, "Changed", "user"); expect((await post({ action: "archive", id: task.id, expectedUpdatedAt: task.updatedAt })).status).toBe(409); expect(store.read().tasks[0].archived).toBe(false); });
  it("accepts user comments for the assigned worker to receive", async () => { const task = store.create(input, "orchestrator"); const response = await post({ action: "comment", id: task.id, text: "Please verify empty inputs", expectedUpdatedAt: task.updatedAt }); expect(response.status).toBe(200); expect(store.read().tasks[0].comments[0].author).toBe("user"); });
  it("cannot bypass completion by dragging a task to done", async () => { const task = store.create(input, "orchestrator"); expect((await post({ action: "move", id: task.id, column: "done", expectedUpdatedAt: task.updatedAt })).status).toBe(400); expect(store.read().tasks[0].column).toBe("backlog"); });
  it("edits backlog scope without accepting forged scores or execution state", async () => { const task = store.create(input, "orchestrator"); const response = await post({ action: "edit", id: task.id, expectedUpdatedAt: task.updatedAt, task: { ...input, scope: "Updated", column: "done", evaluations: { orchestrator: { total: 100 } }, mergeApproved: true } }); expect(response.status).toBe(200); expect(store.read().tasks[0].scope).toBe("Updated"); expect(store.read().tasks[0].evaluations).toEqual({}); expect(store.read().tasks[0].mergeApproved).toBe(false); });
  it("requires explicit user approval for a merge-policy task", async () => { const task = store.create({ ...input, prMode: "merge" }, "orchestrator"); expect(task.mergeApproved).toBe(false); const response = await post({ action: "approve-merge", id: task.id, expectedUpdatedAt: task.updatedAt }); expect(response.status).toBe(200); expect(store.read().tasks[0].mergeApproved).toBe(true); expect(store.read().tasks[0].history.at(-1)?.actor).toBe("user"); });
  it("does not expose orchestrator or worker score actions over the user API", async () => { const task = store.create(input, "orchestrator"); expect((await post({ action: "evaluate", id: task.id, expectedUpdatedAt: task.updatedAt, scores: [100] })).status).toBe(400); });
  it("requires JSON and limits request size", async () => { expect((await post({}, { "Content-Type": "text/plain" })).status).toBe(415); const response = await post({ text: "x".repeat(256001) }); expect(response.status).toBe(413); });
  it("returns a readable error for malformed actions", async () => { expect((await post({ action: "archive", id: "missing", expectedUpdatedAt: "now" })).status).toBe(400); });
  it("ships syntactically valid self-contained JS and accessible modal UI", () => { expect(() => new Script(KANBAN_SCRIPT)).not.toThrow(); expect(KANBAN_HTML).toContain('aria-labelledby="modal-title"'); expect(KANBAN_SCRIPT).not.toContain(".innerHTML"); expect(KANBAN_SCRIPT).toContain('getData("text/plain")'); expect(KANBAN_SCRIPT).toContain('addEventListener("contextmenu"'); });
});

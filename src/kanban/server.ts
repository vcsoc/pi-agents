import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { KanbanController } from "./controller.js";
import { type NewTask, text } from "./store.js";
import { KANBAN_HTML, KANBAN_SCRIPT } from "./web.js";

export interface KanbanWebServer { url: string; close: () => Promise<void> }
export async function startKanbanServer(controller: KanbanController): Promise<KanbanWebServer> {
  const token = randomBytes(32).toString("hex");
  const listeners = new Set<ServerResponse>();
  let origin = "", previous = "";
  const boardSnapshot = () => controller.view();
  const snapshot = () => JSON.stringify(boardSnapshot());
  const send = (res: ServerResponse, status: number, data: unknown) => {
    res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" }); res.end(JSON.stringify(data));
  };
  const server = createServer(async (req, res) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Content-Security-Policy", "default-src 'none'; script-src 'self'; connect-src 'self'; style-src 'unsafe-inline'; img-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
    let url: URL;
    try { url = new URL(req.url ?? "/", origin || "http://127.0.0.1"); } catch { send(res, 400, { error: "Invalid request URL" }); return; }
    if (req.headers.host !== new URL(origin).host || (req.headers.origin && req.headers.origin !== origin)) { send(res, 403, { error: "Local same-origin requests only" }); return; }
    if (req.method === "GET" && url.pathname === "/") { res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" }); res.end(KANBAN_HTML); return; }
    if (req.method === "GET" && url.pathname === "/app.js") { res.writeHead(200, { "Content-Type": "text/javascript; charset=utf-8", "Cache-Control": "no-store" }); res.end(KANBAN_SCRIPT); return; }
    const auth = Buffer.from(req.headers.authorization ?? "");
    const expected = Buffer.from(`Bearer ${token}`);
    if (auth.length !== expected.length || !timingSafeEqual(auth, expected)) { send(res, 401, { error: "Open the board from /agents kban to authenticate" }); return; }
    try {
      if (req.method === "GET" && url.pathname === "/api/board") { send(res, 200, boardSnapshot()); return; }
      if (req.method === "GET" && url.pathname === "/api/events") {
        res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", "Connection": "keep-alive" });
        const board = boardSnapshot();
        res.write(`id: ${board.sequence}\ndata: ${JSON.stringify(board)}\n\n`); listeners.add(res);
        req.on("close", () => listeners.delete(res)); return;
      }
      if (req.method !== "POST" || url.pathname !== "/api/action") { send(res, 404, { error: "Not found" }); return; }
      if (!(req.headers["content-type"] ?? "").startsWith("application/json")) { send(res, 415, { error: "JSON required" }); return; }
      let size = 0; const chunks: Buffer[] = [];
      for await (const part of req) {
        const buffer = Buffer.from(part); size += buffer.length;
        if (size > 256000) { send(res, 413, { error: "Request exceeds 256KB" }); return; }
        chunks.push(buffer);
      }
      const input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      const actor = "user";
      if (input.action === "create") controller.createTask(input.task as NewTask, actor);
      else if (input.action === "pause-all") await controller.pauseAll();
      else if (input.action === "pause-agent") await controller.pauseAgent(text(input.id, "Agent id", 100));
      else if (input.action === "archive-done") controller.store.archiveDone(actor);
      else {
        const id = text(input.id, "Task id", 100);
        const task = controller.store.task(controller.store.read(), id);
        if (input.expectedUpdatedAt !== task.updatedAt) { send(res, 409, { error: "Task changed; reopen it to avoid overwriting newer work" }); return; }
        if (input.action === "comment") controller.store.comment(id, input.summary !== undefined ? { summary: text(input.summary, "Comment summary", 500), details: input.details ?? input.text } : text(input.text, "Comment", 200000), actor, input.expectedUpdatedAt);
        else if (input.action === "move") controller.store.move(id, input.column, actor, input.expectedUpdatedAt);
        else if (input.action === "archive") controller.store.archive(id, actor, input.expectedUpdatedAt);
        else if (input.action === "edit") controller.store.edit(id, input.task as NewTask, actor, input.expectedUpdatedAt);
        else if (input.action === "approve-merge") controller.store.change(b => {
          const t = controller.store.task(b, id);
          if (t.updatedAt !== input.expectedUpdatedAt) throw new Error("Task changed; reopen before approving merge");
          if (t.archived || t.prMode !== "merge") throw new Error("Task does not request a merge");
          t.mergeApproved = true; if (t.blocked === "Awaiting explicit user approval to merge") t.blocked = undefined; controller.store.audit(t, actor, "explicitly approved PR merge");
        });
        else throw new Error("Unsupported user action");
      }
      await controller.tick();
      send(res, 200, boardSnapshot());
    } catch (e) { if (!res.headersSent) send(res, 400, { error: e instanceof Error ? e.message : String(e) }); else res.end(); }
  });
  server.requestTimeout = 15000; server.headersTimeout = 10000;
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => { server.removeListener("error", reject); resolve(); }); });
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const timer = setInterval(() => {
    try {
      const current = snapshot();
      if (current !== previous) { previous = current; const data = `data: ${current}\n\n`; for (const res of listeners) { if (res.writableLength > 1024 * 1024) res.destroy(); else res.write(data); } }
      else for (const res of listeners) res.write(": heartbeat\n\n");
    } catch { for (const res of listeners) res.end(); listeners.clear(); }
  }, 750); timer.unref(); server.unref();
  return {
    url: `${origin}/#${token}`,
    close: async () => { clearInterval(timer); for (const res of listeners) res.end(); listeners.clear(); await new Promise<void>((resolve, reject) => { server.close(e => e ? reject(e) : resolve()); server.closeAllConnections(); }); },
  };
}

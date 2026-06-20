// Copilot IDE bridge — the Obsidian side of GitHub Copilot CLI's IDE integration.
//
// Unlike Claude (TCP WebSocket + ~/.claude/ide/<port>.lock), Copilot connects
// over a UNIX DOMAIN SOCKET using Streamable-HTTP MCP and discovers us via a
// lock file in ~/.copilot/ide/<id>.lock. Verified against copilot 1.0.64:
//   - Copilot watches ~/.copilot/ide/, validates the lock schema, matches by
//     workspaceFolders + ideName, then connects.
//   - It POSTs JSON-RPC to /mcp (initialize, notifications/initialized,
//     tools/list, tools/call) and opens a long-lived GET /mcp SSE stream for
//     server→client pushes (selection_changed).
//   - It echoes the lock's `headers` on every request (our auth token).
//   - It recognises the standard IDE tool vocabulary (getCurrentSelection,
//     getOpenEditors, openDiff, …) and consumes it as native IDE features —
//     injected context nudges, not model-callable tools.
//
// We reuse the shared tool catalog + dispatch (ide-tools.ts) and diff modal
// (diff-modal.ts) so behaviour matches the Claude bridge tool-for-tool.

import * as http from "http";
import * as crypto from "crypto";
import * as path from "path";
import * as fs from "fs";
import * as os from "os";
import { App, Platform, TFile, MarkdownView } from "obsidian";
import { getToolCatalog, handleToolCall, ToolError } from "./ide-tools";
import { DiffModal } from "./diff-modal";
import type { SelectionParams, IIdeServer } from "./types";

const AUTH_HEADER = "x-obsidian-ide-auth";
const DEFAULT_PROTOCOL_VERSION = "2025-11-25";

interface JsonRpcMessage {
  jsonrpc?: string;
  id?: number | string;
  method?: string;
  params?: { name?: string; arguments?: Record<string, unknown>; protocolVersion?: string };
}

export class CopilotIdeServer implements IIdeServer {
  private server: http.Server | null = null;
  private socketPath: string | null = null;
  private lockFilePath: string | null = null;
  private authToken: string | null = null;
  private sseClients = new Set<http.ServerResponse>();
  private selectionDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  private lastSelection: SelectionParams | null = null;
  private pendingDiffPromises = new Map<number, (result: string) => void>();

  /** Always null — Copilot connects over a Unix socket, not a TCP port. */
  public port: number | null = null;
  public notifyCallback:
    | ((type: string, notificationType: string | null, message: string | null, tabId: string | null) => void)
    | null = null;

  constructor(
    private app: App,
    private getVaultPath: () => string,
  ) {}

  start(): void {
    if (Platform?.isMobile) return;
    this.authToken = crypto.randomUUID();
    this.cleanStaleLockFiles();

    const id = crypto.randomBytes(4).toString("hex");
    const sockPath = path.join(os.tmpdir(), `obsidian-copilot-ide-${id}.sock`);
    try { fs.unlinkSync(sockPath); } catch (_e) { /* not present */ }

    const server = http.createServer((req, res) => this.handleHttp(req, res));
    server.on("error", (e) => console.warn("[copilot-ide] server error:", e));
    server.listen(sockPath, () => {
      this.server = server;
      this.socketPath = sockPath;
      this.writeLockFile(id);
      console.log(`[copilot-ide] MCP server listening on ${sockPath}`);
    });
  }

  stop(): void {
    if (this.selectionDebounceTimer) {
      clearTimeout(this.selectionDebounceTimer);
      this.selectionDebounceTimer = null;
    }
    for (const res of this.sseClients) {
      try { res.end(); } catch (_e) { /* ignore */ }
    }
    this.sseClients.clear();
    if (this.server) {
      this.server.close();
      this.server = null;
    }
    if (this.lockFilePath) {
      try { fs.unlinkSync(this.lockFilePath); } catch (_e) { /* ignore */ }
      this.lockFilePath = null;
    }
    if (this.socketPath) {
      try { fs.unlinkSync(this.socketPath); } catch (_e) { /* ignore */ }
      this.socketPath = null;
    }
  }

  pushSelection(): void {
    if (this.sseClients.size === 0) return;
    if (this.selectionDebounceTimer) clearTimeout(this.selectionDebounceTimer);
    this.selectionDebounceTimer = setTimeout(() => {
      const params = this.computeSelection();
      if (!params) return;
      // Preserve last meaningful selection when focus moves to the terminal.
      if (params.text || !this.lastSelection || this.lastSelection.filePath !== params.filePath) {
        this.lastSelection = params;
      }
      this.broadcast({ jsonrpc: "2.0", method: "selection_changed", params });
    }, 150);
  }

  // ─── HTTP / MCP ─────────────────────────────────────────────────────────

  private handleHttp(req: http.IncomingMessage, res: http.ServerResponse): void {
    const url = req.url || "";
    if (this.authToken && req.headers[AUTH_HEADER] !== this.authToken) {
      res.writeHead(401);
      res.end();
      return;
    }
    // Bell: the notify hook scripts POST here over the Unix socket.
    if (req.method === "POST" && url.indexOf("/notify") === 0) {
      this.handleNotify(req, res);
      return;
    }
    if (url.indexOf("/mcp") !== 0) {
      res.writeHead(404);
      res.end();
      return;
    }
    if (req.method === "POST") {
      this.handlePost(req, res);
      return;
    }
    if (req.method === "GET") {
      this.handleSse(req, res);
      return;
    }
    if (req.method === "DELETE") {
      res.writeHead(200);
      res.end();
      return;
    }
    res.writeHead(405);
    res.end();
  }

  private handleNotify(req: http.IncomingMessage, res: http.ServerResponse): void {
    let body = "";
    req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
    req.on("end", () => {
      try {
        const data = JSON.parse(body);
        this.notifyCallback?.(
          typeof data.type === "string" ? data.type : "notification",
          data.notification_type ?? null,
          data.message ?? null,
          typeof data.tab_id === "string" ? data.tab_id : null,
        );
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      } catch (_e) {
        res.writeHead(400);
        res.end();
      }
    });
  }

  /** Long-lived SSE stream: Copilot opens GET /mcp to receive server→client
   *  notifications (selection_changed nudges). */
  private handleSse(req: http.IncomingMessage, res: http.ServerResponse): void {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    res.write(": connected\n\n");
    this.sseClients.add(res);
    req.on("close", () => this.sseClients.delete(res));
  }

  private handlePost(req: http.IncomingMessage, res: http.ServerResponse): void {
    let body = "";
    req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
    req.on("end", () => {
      let msg: JsonRpcMessage | JsonRpcMessage[];
      try {
        msg = JSON.parse(body);
      } catch (_e) {
        res.writeHead(400);
        res.end();
        return;
      }
      const messages = Array.isArray(msg) ? msg : [msg];
      Promise.all(messages.map((m) => this.dispatch(m)))
        .then((results) => {
          const out = results.filter((r): r is object => r !== null);
          if (out.length === 0) {
            res.writeHead(202);
            res.end();
            return;
          }
          const headers: Record<string, string> = { "Content-Type": "application/json" };
          if (messages.some((m) => m.method === "initialize")) {
            headers["Mcp-Session-Id"] = crypto.randomUUID();
          }
          res.writeHead(200, headers);
          res.end(JSON.stringify(Array.isArray(msg) ? out : out[0]));
        })
        .catch((err) => {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32000, message: String(err) } }));
        });
    });
  }

  private async dispatch(msg: JsonRpcMessage): Promise<object | null> {
    if (!msg || msg.method === undefined) return null; // a response/ack — ignore
    const id = msg.id;

    if (msg.method === "initialize") {
      return {
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: msg.params?.protocolVersion || DEFAULT_PROTOCOL_VERSION,
          serverInfo: { name: "obsidian-copilot-sidebar", version: "1.0.0" },
          capabilities: { tools: {} },
        },
      };
    }
    if (msg.method === "notifications/initialized") return null;
    if (msg.method === "tools/list") {
      return { jsonrpc: "2.0", id, result: { tools: getToolCatalog() } };
    }
    if (msg.method === "tools/call") {
      const toolName = msg.params?.name ?? "";
      const args = msg.params?.arguments ?? {};
      try {
        const result = await handleToolCall(this.toolContext(), toolName, args);
        return { jsonrpc: "2.0", id, result };
      } catch (err) {
        if (err instanceof ToolError) {
          return { jsonrpc: "2.0", id, error: { code: err.code, message: err.message } };
        }
        return { jsonrpc: "2.0", id, error: { code: -32000, message: String(err) } };
      }
    }
    // Unknown request: return an empty result so Copilot isn't left hanging.
    if (id !== undefined) return { jsonrpc: "2.0", id, result: {} };
    return null;
  }

  private toolContext() {
    return {
      app: this.app,
      getVaultPath: this.getVaultPath,
      showDiff: (filePath: string, oldContent: string, newContent: string) =>
        DiffModal.show(
          this.app,
          filePath,
          oldContent,
          newContent,
          async (relPath: string, content: string) => {
            const file = this.app.vault.getAbstractFileByPath(relPath);
            if (file && file instanceof TFile) {
              await this.app.vault.modify(file, content);
            }
          },
        ),
      getLastSelection: () => this.lastSelection,
      pendingDiffPromises: this.pendingDiffPromises,
    };
  }

  private broadcast(obj: unknown): void {
    const data = `data: ${JSON.stringify(obj)}\n\n`;
    for (const res of this.sseClients) {
      try { res.write(data); } catch (_e) { /* dropped client */ }
    }
  }

  private computeSelection(): SelectionParams | null {
    const leaf = this.app.workspace.getMostRecentLeaf();
    const view = leaf?.view instanceof MarkdownView ? leaf.view : null;
    const editor = view?.editor ?? this.app.workspace.activeEditor?.editor;
    const file = view?.file ?? this.app.workspace.getActiveFile();
    if (!file) return null;
    const vaultPath = this.getVaultPath();
    const filePath = `${vaultPath}/${file.path}`;
    const text = editor?.getSelection() || "";
    const from = editor?.getCursor("from") || { line: 0, ch: 0 };
    const to = editor?.getCursor("to") || { line: 0, ch: 0 };
    return {
      text,
      filePath,
      fileUrl: `file://${filePath}`,
      selection: {
        start: { line: from.line, character: from.ch },
        end: { line: to.line, character: to.ch },
        isEmpty: !text,
      },
    };
  }

  // ─── Lock file ──────────────────────────────────────────────────────────

  private writeLockFile(id: string): void {
    const lockDir = path.join(os.homedir(), ".copilot", "ide");
    fs.mkdirSync(lockDir, { recursive: true });
    const lockPath = path.join(lockDir, `${id}.lock`);
    // Schema confirmed against Copilot's validator: socketPath/scheme/headers/
    // timestamp are required; workspaceFolders + ideName drive workspace matching.
    const lockData = {
      socketPath: this.socketPath,
      scheme: "ws",
      headers: { [AUTH_HEADER]: this.authToken },
      timestamp: Date.now(),
      workspaceFolders: [this.getVaultPath()],
      ideName: "Obsidian",
      pid: process.pid,
      transport: "ws",
    };
    fs.writeFileSync(lockPath, JSON.stringify(lockData, null, 2));
    this.lockFilePath = lockPath;
  }

  private cleanStaleLockFiles(): void {
    const lockDir = path.join(os.homedir(), ".copilot", "ide");
    try {
      if (!fs.existsSync(lockDir)) return;
      for (const file of fs.readdirSync(lockDir)) {
        if (!file.endsWith(".lock")) continue;
        const lockPath = path.join(lockDir, file);
        try {
          const data = JSON.parse(fs.readFileSync(lockPath, "utf8"));
          if (data.ideName !== "Obsidian") continue;
          try {
            process.kill(data.pid, 0); // alive — leave it
          } catch (_e) {
            fs.unlinkSync(lockPath);
            if (typeof data.socketPath === "string") {
              try { fs.unlinkSync(data.socketPath); } catch (_e2) { /* ignore */ }
            }
          }
        } catch (_e) {
          try { fs.unlinkSync(lockPath); } catch (_e2) { /* ignore */ }
        }
      }
    } catch (_e) { /* ignore */ }
  }
}

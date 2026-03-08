import { App, TFile, MarkdownView } from "obsidian";
import { getToolCatalog, handleToolCall, ToolError } from "./ide-tools";
import { DiffModal } from "./diff-modal";
import type { SelectionParams } from "./types";
import type { SpriteManager } from "./sprite-manager";
import { createAuthWebSocket, WS_OPEN, type CompatWebSocket } from "./ws-compat";

export class RemoteIdeClient {
  private ws: CompatWebSocket | null = null;
  private lastSelection: SelectionParams | null = null;
  private selectionDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingDiffPromises = new Map<number, (result: string) => void>();
  private recvBuffer = '';

  constructor(
    private app: App,
    private getVaultPath: () => string,
    private spriteManager: SpriteManager,
  ) {}

  async connect(): Promise<void> {
    // Wait for relay to start (launched as background process in terminal bash)
    console.log('[RemoteIDE] waiting for relay to start...');
    await new Promise(r => setTimeout(r, 2000));

    // Connect to terminal server's /ide endpoint which proxies to the IDE relay
    const serverUrl = await this.spriteManager.getTerminalServerUrl();
    const ticket = await this.spriteManager.getTerminalTicket();
    const wsUrl = `${serverUrl.replace(/^http/, 'ws')}/ide`;

    await this.openConnection(wsUrl, ticket);
    console.log('[RemoteIDE] connected via terminal server /ide proxy');

    // After a delay, fetch relay log to check what happened
    setTimeout(async () => {
      try {
        const log = new TextDecoder().decode(
          await this.spriteManager.downloadFile('/tmp/relay.log')
        );
        console.log('[RemoteIDE] relay log:\n' + log.substring(0, 1000));
      } catch { console.log('[RemoteIDE] relay log: not found'); }
    }, 5000);
  }

  private openConnection(url: string, ticket: string): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        this.ws = createAuthWebSocket(url, ticket);
      } catch (err) {
        reject(err);
        return;
      }

      let resolved = false;

      this.ws.on('open', () => {
        console.log('[RemoteIDE] WebSocket connected');
        // Terminal server handles the TCP proxy + backhaul auth internally.
        // Connection is ready to use immediately.
        if (!resolved) {
          resolved = true;
          resolve();
        }
      });

      this.ws.on('error', (err: Error) => {
        console.error('[RemoteIDE] ws error:', err.message);
        if (!resolved) {
          resolved = true;
          reject(err);
        }
      });

      this.ws.on('message', (data: unknown) => {
        const text =
          typeof data === 'string'
            ? data
            : new TextDecoder().decode(data as ArrayBuffer);

        console.debug('[RemoteIDE] ws message received, len:', text.length);
        this.handleProxyData(text);
      });

      this.ws.on('close', (code: number) => {
        console.debug('[RemoteIDE] WebSocket closed, code:', code);
        if (!resolved) {
          resolved = true;
          reject(new Error('WebSocket closed before connecting'));
        }
      });

      // Timeout if connection doesn't establish
      setTimeout(() => {
        if (!resolved) {
          resolved = true;
          reject(new Error('Connection timeout'));
        }
      }, 10000);
    });
  }

  private handleProxyData(data: string): void {
    console.debug('[RemoteIDE] proxy data received, len:', data.length);
    // Line-buffer incoming data from the relay
    this.recvBuffer += data;
    const lines = this.recvBuffer.split('\n');
    this.recvBuffer = lines.pop() || '';

    for (const line of lines) {
      if (!line.trim()) continue;
      this.handleMessage(line);
    }
  }

  private handleMessage(text: string): void {
    let msg: {
      jsonrpc?: string;
      id?: number;
      method?: string;
      params?: Record<string, unknown>;
    };
    try {
      msg = JSON.parse(text);
    } catch {
      console.debug('[RemoteIDE] non-JSON from relay:', text.substring(0, 200));
      return;
    }

    if (!msg.method || msg.id === undefined) return;

    console.log('[RemoteIDE] MCP request:', msg.method, 'id:', msg.id);
    this.handleMcpMessage(msg.id, msg.method, msg.params || {});
  }

  private async handleMcpMessage(
    id: number,
    method: string,
    params: Record<string, unknown>
  ): Promise<void> {
    if (method === 'initialize') {
      this.sendResponse(id, {
        protocolVersion: '2025-03-26',
        serverInfo: { name: 'obsidian-claude-sidebar-remote', version: '1.0.0' },
        capabilities: { tools: {} },
      });
      return;
    }

    if (method === 'notifications/initialized') {
      return; // No response needed
    }

    if (method === 'tools/list') {
      this.sendResponse(id, { tools: getToolCatalog() });
      return;
    }

    if (method === 'tools/call') {
      const toolName = (params.name as string) || '';
      const args = (params.arguments as Record<string, unknown>) || {};

      const ctx = {
        app: this.app,
        getVaultPath: this.getVaultPath,
        showDiff: (filePath: string, oldContent: string, newContent: string) => {
          return DiffModal.show(
            this.app,
            filePath,
            oldContent,
            newContent,
            async (relPath: string, content: string) => {
              const file = this.app.vault.getAbstractFileByPath(relPath);
              if (file && file instanceof TFile) {
                await this.app.vault.modify(file, content);
              }
            }
          );
        },
        getLastSelection: () => this.lastSelection,
        pendingDiffPromises: this.pendingDiffPromises,
      };

      try {
        const result = await handleToolCall(ctx, toolName, args);
        this.sendResponse(id, result);
      } catch (err) {
        if (err instanceof ToolError) {
          this.sendError(id, err.code, err.message);
        } else {
          this.sendError(id, -32000, String(err));
        }
      }
      return;
    }
  }

  // Push selection changes to Claude Code via the relay
  pushSelection(): void {
    if (!this.ws || this.ws.readyState !== WS_OPEN) return;

    if (this.selectionDebounceTimer) clearTimeout(this.selectionDebounceTimer);
    this.selectionDebounceTimer = setTimeout(() => {
      const leaf = this.app.workspace.getMostRecentLeaf();
      const view = leaf?.view instanceof MarkdownView ? leaf.view : null;
      const editor = view?.editor ?? this.app.workspace.activeEditor?.editor;
      const file = view?.file ?? this.app.workspace.getActiveFile();
      if (!file) return;

      // Use sprite path so Claude Code on the remote sprite can find the file
      const filePath = `/home/sprite/obsidian/${file.path}`;
      const text = editor?.getSelection() || '';
      const from = editor?.getCursor('from') || { line: 0, ch: 0 };
      const to = editor?.getCursor('to') || { line: 0, ch: 0 };

      const params: SelectionParams = {
        text,
        filePath,
        fileUrl: `file://${filePath}`,
        selection: {
          start: { line: from.line, character: from.ch },
          end: { line: to.line, character: to.ch },
          isEmpty: !text,
        },
      };

      if (text || !this.lastSelection || this.lastSelection.filePath !== filePath) {
        this.lastSelection = params;
      }

      this.sendNotification('selection_changed', params);
    }, 150);
  }

  private sendResponse(id: number, result: unknown): void {
    this.sendToRelay(JSON.stringify({ jsonrpc: '2.0', id, result }));
  }

  private sendError(id: number, code: number, message: string): void {
    this.sendToRelay(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }));
  }

  private sendNotification(method: string, params: unknown): void {
    this.sendToRelay(JSON.stringify({ jsonrpc: '2.0', method, params }));
  }

  private sendToRelay(msg: string): void {
    if (this.ws?.readyState === WS_OPEN) {
      console.debug('[RemoteIDE] sending to relay, len:', msg.length);
      this.ws.send(msg + '\n');
    } else {
      console.warn('[RemoteIDE] sendToRelay: ws not open, state:', this.ws?.readyState);
    }
  }

  disconnect(): void {
    if (this.selectionDebounceTimer) {
      clearTimeout(this.selectionDebounceTimer);
      this.selectionDebounceTimer = null;
    }
    for (const [, resolver] of this.pendingDiffPromises) {
      resolver('DIFF_REJECTED');
    }
    this.pendingDiffPromises.clear();
    if (this.ws) {
      this.ws.removeAllListeners();
      this.ws.close();
      this.ws = null;
    }
  }
}

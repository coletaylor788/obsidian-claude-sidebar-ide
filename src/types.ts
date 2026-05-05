import type { SessionGroups } from "./session-groups";

export interface PluginData {
  cliBackend?: string;
  defaultWorkingDir?: string | null;
  additionalFlags?: string | null;
  lastCwd?: string | null;
  runtimeMode?: 'local' | 'sprites';
  spritesApiToken?: string | null;
  autoResume?: boolean;
  /** Per-Claude-session main-area layout snapshots, keyed by stable sessionId. */
  sessionGroups?: SessionGroups;
  /** Most-recently-active Claude session at quit time. Used on reload to
   *  pick the right tab to sync with main, so we don't capture stale main
   *  state into the wrong session's group. */
  activeSessionId?: string;
}

export interface Backend {
  label: string;
  binary: string;
  pathHints: string[];
  yoloFlag: string | null;
  resumeFlag: string | null;
  resumeIsSubcommand: boolean;
}

export interface WsClient {
  socket: import("net").Socket;
  buffer: Buffer;
  fragments: Buffer[];
}

export interface WsFrame {
  fin: boolean;
  opcode: number;
  payload: Buffer;
  totalLength: number;
}

export interface SelectionParams {
  text: string;
  filePath: string;
  fileUrl: string;
  selection: {
    start: { line: number; character: number };
    end: { line: number; character: number };
    isEmpty: boolean;
  };
}

export interface McpMessage {
  jsonrpc: "2.0";
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { code: number; message: string };
}

export interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface McpToolResult {
  content: Array<{ type: "text"; text: string }>;
}

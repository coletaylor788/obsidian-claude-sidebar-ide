import { requestUrl } from "obsidian";
import type { ShellOptions, ShellCallbacks, IShellManager } from "./shell-interface";
import type { Backend, PluginData } from "./types";
import type { SpriteManager } from "./sprite-manager";
import { IDE_RELAY_SCRIPT } from "./ide-relay";
import NodeWebSocket from "ws";

export class RemoteShellManager implements IShellManager {
  private ws: NodeWebSocket | null = null;
  private callbacks: ShellCallbacks | null = null;
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private _isRunning = false;
  private _exitHandled = false;
  private lastCmd: string | null = null;
  private lastCols = 80;
  private lastRows = 24;

  private static readonly MAX_RECONNECT_ATTEMPTS = 15;
  private static readonly MAX_RECONNECT_DELAY = 30000;
  // Show reconnecting overlay only after this many attempts
  private static readonly SILENT_RETRIES = 3;

  constructor(
    private getBackend: () => Backend,
    private pluginData: PluginData,
    private spriteManager: SpriteManager,
  ) {}

  get isRunning(): boolean {
    return this._isRunning;
  }

  // Reject shell metacharacters to prevent command injection via additionalFlags
  private static sanitizeFlags(flags: string | null | undefined): string | null {
    if (!flags) return null;
    // Only allow flags that look like CLI arguments (alphanumeric, dashes, dots, equals, commas, spaces)
    if (/[;&|`$(){}\\!\n\r<>'"#]/.test(flags)) {
      console.warn('[RemoteShell] additionalFlags rejected — contains shell metacharacters');
      return null;
    }
    return flags.trim();
  }

  start(opts: ShellOptions, callbacks: ShellCallbacks): void {
    this.stop();
    this.callbacks = callbacks;
    this._isRunning = false;
    this._exitHandled = false;

    // Build the command to run on the Sprite
    const backend = this.getBackend();

    // Build CLI command
    let cliCmd = backend.binary;
    if (backend.binary === 'claude') cliCmd += ' --ide';
    if (opts.yoloMode && backend.yoloFlag) cliCmd += ' ' + backend.yoloFlag;
    const sanitizedFlags = RemoteShellManager.sanitizeFlags(this.pluginData.additionalFlags);
    if (sanitizedFlags) cliCmd += ' ' + sanitizedFlags;

    if (opts.continueSession && backend.resumeFlag) {
      if (backend.resumeIsSubcommand) {
        cliCmd = `${backend.binary} ${backend.resumeFlag}`;
        if (sanitizedFlags) cliCmd += ' ' + sanitizedFlags;
      } else {
        cliCmd += ' ' + backend.resumeFlag;
      }
    }

    // Set environment and run from the vault working directory
    const envVars = 'CLAUDE_CODE_SSE_PORT=9501 ENABLE_IDE_INTEGRATION=true';
    const fullCmd = `cd /home/sprite/obsidian && ${envVars} ${cliCmd}`;

    // Async connection
    this.connectAsync(fullCmd, opts, callbacks).catch(err => {
      callbacks.onStderr(`\r\n[Connection error: ${(err as Error).message}]\r\n`);
      callbacks.onExit(1, null);
    });
  }

  private async connectAsync(
    cmd: string,
    opts: ShellOptions,
    callbacks: ShellCallbacks
  ): Promise<void> {
    const spriteName = await this.spriteManager.ensureSprite();
    const token = this.pluginData.spritesApiToken?.replace(/\s/g, '');
    if (!token) throw new Error('Sprites API token not configured');

    // Upload IDE relay script before starting the terminal session
    // (exec POST doesn't work on Sprites, so relay must start via the terminal bash)
    try {
      await this.spriteManager.uploadFile('/home/sprite/ide-relay.js', IDE_RELAY_SCRIPT);
      console.log('[RemoteShell] IDE relay script uploaded');
    } catch (err) {
      console.warn('[RemoteShell] IDE relay upload failed:', err);
    }

    const cols = opts.cols || 80;
    const rows = opts.rows || 24;
    this.lastCmd = cmd;
    this.lastCols = cols;
    this.lastRows = rows;

    // Connect with bash first — Sprites API ignores cols/rows query params,
    // so we resize after connect, then write the actual command to stdin
    const wsUrl =
      `wss://api.sprites.dev/v1/sprites/${spriteName}/exec` +
      `?cmd=${encodeURIComponent('bash')}&tty=true&cols=${cols}&rows=${rows}`;

    console.log('[RemoteShell] sprite:', spriteName, 'cols:', cols, 'rows:', rows);
    console.log('[RemoteShell] cmd:', cmd);

    await this.openWebSocket(wsUrl, token, callbacks);

    // Resize terminal to correct dimensions
    this.resize(cols, rows);

    // Give resize a moment to take effect, then send the actual command.
    // Start the IDE relay as a background process first, then run the main command.
    // The relay needs ~1s to start listening before Claude Code can discover it.
    await new Promise(r => setTimeout(r, 300));
    this.write(
      'pkill -f "node /home/sprite/ide-relay.js" 2>/dev/null; ' +
      'node /home/sprite/ide-relay.js > /tmp/relay.log 2>&1 & ' +
      'sleep 1; ' +
      cmd + '\n'
    );
  }

  private openWebSocket(
    url: string,
    token: string,
    callbacks: ShellCallbacks
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        this.ws = new NodeWebSocket(url, {
          headers: { 'Authorization': `Bearer ${token}` },
        });
      } catch (err) {
        reject(err);
        return;
      }

      const onOpen = () => {
        this._isRunning = true;
        const priorAttempts = this.reconnectAttempts;
        const wasReconnecting = priorAttempts > 0;
        this.reconnectAttempts = 0;
        cleanup();
        if (wasReconnecting) {
          const wasSilent = priorAttempts <= RemoteShellManager.SILENT_RETRIES;
          this.resize(this.lastCols, this.lastRows);
          if (this.lastCmd) {
            setTimeout(() => {
              // Exec WS drop kills the bash session — always restart relay + Claude
              console.log(`[RemoteShell] reconnect succeeded (attempt ${priorAttempts})`);
              this.write(
                'pkill -f "node /home/sprite/ide-relay.js" 2>/dev/null; ' +
                'node /home/sprite/ide-relay.js > /tmp/relay.log 2>&1 & ' +
                'sleep 1; ' +
                this.lastCmd + '\n'
              );
              callbacks.onReconnected?.();
            }, 300);
          } else {
            callbacks.onReconnected?.();
          }
        }
        resolve();
      };

      const onError = (err: Error) => {
        cleanup();
        reject(err);
      };

      const cleanup = () => {
        this.ws?.removeListener('open', onOpen);
        this.ws?.removeListener('error', onError);
      };

      this.ws.on('open', onOpen);
      this.ws.on('error', onError);

      // Wire up persistent handlers — Sprites API sends JSON-framed messages
      this.ws.on('message', (data: NodeWebSocket.Data) => {
        const text =
          typeof data === 'string'
            ? data
            : Buffer.isBuffer(data)
              ? data.toString('utf-8')
              : new TextDecoder().decode(data as ArrayBuffer);

        // Try to parse as JSON control message
        try {
          const msg = JSON.parse(text);
          console.debug('[RemoteShell] ws msg:', msg.type);
          if (msg.type === 'data' && msg.data != null) {
            callbacks.onStdout(msg.data);
            return;
          }
          if (msg.type === 'exit') {
            this._isRunning = false;
            if (!this._exitHandled) {
              this._exitHandled = true;
              callbacks.onExit(msg.exit_code ?? 0, null);
            }
            return;
          }
          // All other JSON control messages (session_info, port_opened, etc.) — ignore
          return;
        } catch {
          // Not JSON — treat as raw terminal output
        }
        callbacks.onStdout(text);
      });

      this.ws.on('close', (code: number, reason: Buffer) => {
        const reasonStr = reason?.toString('utf-8') || '';
        console.log(`[RemoteShell] ws close: code=${code} reason="${reasonStr}" isRunning=${this._isRunning} exitHandled=${this._exitHandled}`);
        if (this._isRunning) {
          // Unexpected disconnect — try reconnect
          this._isRunning = false;
          this.attemptReconnect(url, token, callbacks);
        } else if (!this._exitHandled) {
          this._exitHandled = true;
          callbacks.onExit(code === 1000 ? 0 : code, null);
        }
      });

      this.ws.on('error', (err: Error) => {
        console.error('[RemoteShell] ws error:', err.message);
      });
    });
  }

  write(data: string): void {
    if (this.ws?.readyState === NodeWebSocket.OPEN) {
      this.ws.send(Buffer.from(data, 'utf-8'));
    }
  }

  resize(cols: number, rows: number): void {
    const spriteName = this.spriteManager.currentSpriteName;
    const token = this.pluginData.spritesApiToken?.replace(/\s/g, '');
    if (!spriteName || !token) return;

    // Best-effort resize via REST API (use requestUrl to bypass CORS)
    requestUrl({
      url: `https://api.sprites.dev/v1/sprites/${spriteName}/exec/resize`,
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ rows, cols }),
    }).catch(() => {});
  }

  stop(): void {
    this._isRunning = false;
    this._exitHandled = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.removeAllListeners();
      this.ws.close();
      this.ws = null;
    }
  }

  private attemptReconnect(
    url: string,
    token: string,
    callbacks: ShellCallbacks
  ): void {
    if (this.reconnectAttempts >= RemoteShellManager.MAX_RECONNECT_ATTEMPTS) {
      callbacks.onStdout('\r\n[Connection lost after max retries.]\r\n');
      callbacks.onExit(1, null);
      return;
    }

    this.reconnectAttempts++;
    // Fast retries for transient 503s, then exponential backoff
    const delay = this.reconnectAttempts <= RemoteShellManager.SILENT_RETRIES
      ? 500 * this.reconnectAttempts  // 500ms, 1s, 1.5s
      : Math.min(1000 * Math.pow(2, this.reconnectAttempts - RemoteShellManager.SILENT_RETRIES - 1), RemoteShellManager.MAX_RECONNECT_DELAY);
    console.log(`[RemoteShell] reconnect attempt ${this.reconnectAttempts}/${RemoteShellManager.MAX_RECONNECT_ATTEMPTS} in ${delay}ms`);
    // Only show reconnecting overlay after silent retries exhausted
    if (this.reconnectAttempts > RemoteShellManager.SILENT_RETRIES) {
      callbacks.onReconnecting?.();
    }

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this._isRunning = true; // Optimistically set so onclose triggers reconnect
      this.openWebSocket(url, token, callbacks).catch(() => {
        this._isRunning = false;
        this.attemptReconnect(url, token, callbacks);
      });
    }, delay);
  }
}

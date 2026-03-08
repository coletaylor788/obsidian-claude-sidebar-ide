import { requestUrl } from "obsidian";
import { TERMINAL_SERVER_SCRIPT, PTY_HELPER_SCRIPT } from "./terminal-server";

export class SpriteManager {
  currentSpriteName: string | null = null;
  private cachedPublicUrl: string | null = null;
  private cachedMasterSecret: string | null = null;

  constructor(
    private apiToken: string,
    private vaultName: string,
  ) {}

  private get spriteName(): string {
    const slug = this.vaultName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 30);
    const hash = this.simpleHash(this.vaultName).toString(36).slice(0, 4);
    return `obc-${slug}-${hash}`;
  }

  private get cleanToken(): string {
    return this.apiToken.replace(/\s/g, '');
  }

  private get headers(): Record<string, string> {
    return {
      'Authorization': `Bearer ${this.cleanToken}`,
      'Content-Type': 'application/json',
    };
  }

  async ensureSprite(): Promise<string> {
    const name = this.spriteName;
    this.currentSpriteName = name;

    try {
      await requestUrl({
        url: `https://api.sprites.dev/v1/sprites/${name}`,
        headers: this.headers,
      });
    } catch (err: unknown) {
      const status = (err as { status?: number }).status;
      if (status === 404) {
        await this.createSprite(name);
      } else {
        throw new Error(`Sprites API error: ${status}`);
      }
    }
    // If sleeping, it wakes automatically on exec
    return name;
  }

  private async createSprite(name: string): Promise<void> {
    await requestUrl({
      url: 'https://api.sprites.dev/v1/sprites',
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify({ name }),
    });
  }

  async ensureClaudeInstalled(onProgress?: (msg: string) => void): Promise<void> {
    const name = this.currentSpriteName || this.spriteName;

    // Check if claude is already installed
    try {
      const result = await this.exec(name, 'which claude');
      if (result.trim()) {
        // Claude installed — verify terminal server and node-pty are set up
        try {
          await this.exec(name, 'test -f /home/sprite/.ws-terminal/server.js && test -f /home/sprite/.ws-terminal/pty-helper.py');
          return; // Both claude and terminal server are ready
        } catch {
          // Terminal server not set up — install it (upgrade path)
          await this.setupTerminalServer(onProgress);
          await this.checkpoint(name);
          return;
        }
      }
    } catch {
      // Not found — proceed with full install
    }

    onProgress?.('Installing Claude Code on sprite...');
    await this.exec(name, 'curl -fsSL https://claude.ai/install.sh | bash');

    // Pre-trust the home directory so Claude Code doesn't prompt
    await this.exec(name, 'mkdir -p /home/sprite/obsidian').catch(() => {});
    await this.exec(name, 'claude config set -g trustedDirectories /home/sprite/obsidian').catch(() => {});

    onProgress?.('Claude Code installed. Setting up terminal server...');
    await this.setupTerminalServer(onProgress);

    onProgress?.('Creating checkpoint...');
    await this.checkpoint(name);
    onProgress?.('Sprite ready.');
  }

  async setupClaudeCode(): Promise<void> {
    await this.ensureClaudeInstalled();
  }

  async uploadFile(remotePath: string, content: ArrayBuffer | string): Promise<void> {
    const name = this.currentSpriteName || this.spriteName;
    const body = typeof content === 'string' ? new TextEncoder().encode(content).buffer : content;
    await requestUrl({
      url: `https://api.sprites.dev/v1/sprites/${name}/fs/write?path=${encodeURIComponent(remotePath)}&mkdir=true`,
      method: 'PUT',
      headers: { 'Authorization': `Bearer ${this.cleanToken}` },
      body,
    });
  }

  async downloadFile(remotePath: string): Promise<ArrayBuffer> {
    const name = this.currentSpriteName || this.spriteName;
    const res = await requestUrl({
      url: `https://api.sprites.dev/v1/sprites/${name}/fs/read?path=${encodeURIComponent(remotePath)}`,
      headers: { 'Authorization': `Bearer ${this.cleanToken}` },
    });
    return res.arrayBuffer;
  }

  async listFiles(remotePath: string): Promise<Array<{ name: string; type: string; size: number; modTime: string }>> {
    const name = this.currentSpriteName || this.spriteName;
    try {
      const res = await requestUrl({
        url: `https://api.sprites.dev/v1/sprites/${name}/fs/list?path=${encodeURIComponent(remotePath)}&recursive=true`,
        headers: this.headers,
      });
      return res.json;
    } catch {
      return [];
    }
  }

  async deleteFile(remotePath: string): Promise<void> {
    const name = this.currentSpriteName || this.spriteName;
    await requestUrl({
      url: `https://api.sprites.dev/v1/sprites/${name}/fs/delete?path=${encodeURIComponent(remotePath)}`,
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${this.cleanToken}` },
    });
  }

  async exec(name: string, cmd: string): Promise<string> {
    // Use non-TTY exec for setup commands
    const res = await requestUrl({
      url: `https://api.sprites.dev/v1/sprites/${name}/exec`,
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify({ cmd, tty: false }),
    });
    return res.text;
  }

  async checkpoint(name: string): Promise<void> {
    await requestUrl({
      url: `https://api.sprites.dev/v1/sprites/${name}/checkpoint`,
      method: 'POST',
      headers: this.headers,
    });
  }

  async destroy(): Promise<void> {
    const name = this.currentSpriteName || this.spriteName;
    await requestUrl({
      url: `https://api.sprites.dev/v1/sprites/${name}`,
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${this.cleanToken}` },
    });
    this.currentSpriteName = null;
  }

  async getStatus(): Promise<'running' | 'sleeping' | 'destroyed'> {
    const name = this.currentSpriteName || this.spriteName;
    try {
      const res = await requestUrl({
        url: `https://api.sprites.dev/v1/sprites/${name}`,
        headers: this.headers,
      });
      const data = res.json;
      return data.status || 'sleeping';
    } catch {
      return 'destroyed';
    }
  }

  async setupTerminalServer(onProgress?: (msg: string) => void): Promise<void> {
    const name = this.currentSpriteName || this.spriteName;

    // Install node-pty locally so the terminal server script can require() it
    onProgress?.('Installing node-pty...');
    await this.exec(name, 'mkdir -p /home/sprite/.ws-terminal && cd /home/sprite/.ws-terminal && npm install node-pty').catch(() => {
      console.warn('[SpriteManager] node-pty install failed — PTY may not work');
    });

    // Upload the terminal server script and Python PTY helper
    onProgress?.('Uploading terminal server...');
    await this.uploadFile('/home/sprite/.ws-terminal/server.js', TERMINAL_SERVER_SCRIPT);
    await this.uploadFile('/home/sprite/.ws-terminal/pty-helper.py', PTY_HELPER_SCRIPT);

    // Set sprite URL to public (no auth headers required for HTTP/WS access)
    await requestUrl({
      url: `https://api.sprites.dev/v1/sprites/${name}`,
      method: 'PUT',
      headers: this.headers,
      body: JSON.stringify({ url_settings: { auth: 'public' } }),
    });

    // Register as a Sprites service (auto-restarts on wake)
    await requestUrl({
      url: `https://api.sprites.dev/v1/sprites/${name}/services/terminal`,
      method: 'PUT',
      headers: this.headers,
      body: JSON.stringify({
        cmd: 'node',
        args: ['/home/sprite/.ws-terminal/server.js'],
        http_port: 8080,
      }),
    });

    onProgress?.('Terminal server registered.');
  }

  async getTerminalServerUrl(): Promise<string> {
    if (this.cachedPublicUrl) return this.cachedPublicUrl;

    const name = this.currentSpriteName || this.spriteName;
    const res = await requestUrl({
      url: `https://api.sprites.dev/v1/sprites/${name}`,
      headers: this.headers,
    });
    const data = res.json;
    // Extract public URL from sprite info — try common fields
    const url = data.url || data.public_url || `https://${name}.sprites.dev`;
    this.cachedPublicUrl = url;
    return url;
  }

  async getTerminalTicket(): Promise<string> {
    // Read master secret — retry to allow the terminal server service to start
    if (!this.cachedMasterSecret) {
      for (let attempt = 0; attempt < 10; attempt++) {
        try {
          const secretData = await this.downloadFile('/home/sprite/.ws-terminal/master-secret');
          this.cachedMasterSecret = new TextDecoder().decode(secretData).trim();
          break;
        } catch {
          if (attempt === 9) throw new Error('Terminal server not ready — master secret not found');
          await new Promise(r => setTimeout(r, 1000));
        }
      }
    }

    // Request a one-time ticket from the terminal server
    const serverUrl = await this.getTerminalServerUrl();
    const res = await requestUrl({
      url: `${serverUrl}/api/ticket`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ secret: this.cachedMasterSecret }),
    });
    return res.json.ticket;
  }

  /** @deprecated Use getTerminalTicket() instead */
  async getWsTicket(): Promise<string> {
    return this.getTerminalTicket();
  }

  /** Clear cached values (e.g., after sprite restart) */
  clearCache(): void {
    this.cachedPublicUrl = null;
    this.cachedMasterSecret = null;
  }

  private simpleHash(str: string): number {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      hash = ((hash << 5) - hash) + str.charCodeAt(i);
      hash |= 0;
    }
    return Math.abs(hash);
  }
}

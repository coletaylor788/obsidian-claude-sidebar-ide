import { requestUrl } from "obsidian";

export class SpriteManager {
  currentSpriteName: string | null = null;

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
      if (result.trim()) return; // Already installed
    } catch {
      // Not found — proceed with install
    }

    onProgress?.('Installing Claude Code on sprite...');
    await this.exec(name, 'curl -fsSL https://claude.ai/install.sh | bash');

    // Pre-trust the home directory so Claude Code doesn't prompt
    await this.exec(name, 'mkdir -p /home/sprite/obsidian').catch(() => {});
    await this.exec(name, 'claude config set -g trustedDirectories /home/sprite/obsidian').catch(() => {});

    onProgress?.('Claude Code installed. Creating checkpoint...');
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

  private simpleHash(str: string): number {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      hash = ((hash << 5) - hash) + str.charCodeAt(i);
      hash |= 0;
    }
    return Math.abs(hash);
  }
}

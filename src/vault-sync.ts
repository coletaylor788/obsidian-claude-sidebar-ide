import { Vault, TFile, TAbstractFile } from "obsidian";
import type { SpriteManager } from "./sprite-manager";
import { createAuthWebSocket, type CompatWebSocket } from "./ws-compat";

export class VaultSync {
  private pushDebounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private pullDebounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private inFlightPushes = new Map<string, number>(); // path → push timestamp
  private watchWs: CompatWebSocket | null = null;
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private vaultEventRefs: Array<() => void> = [];
  private stopped = false;

  private static readonly PUSH_DEBOUNCE_MS = 500;
  private static readonly PULL_DEBOUNCE_MS = 200;
  private static readonly IN_FLIGHT_SUPPRESS_MS = 5000;
  private static readonly MAX_FILE_SIZE = 5 * 1024 * 1024; // 5MB
  private static readonly SKIP_PATTERNS = [
    '.obsidian/', '.git/', 'node_modules/', '.DS_Store',
    '.trash/', '.omc/', '.claude/',
    '.claude.json', '.claude_', '.tmp.', '.lock', '.swp', '.swo', '~',
    '.bash_history', '.bashrc', '.profile', '.cache/',
  ];
  private static readonly CONCURRENT_UPLOADS = 10;
  private static readonly MAX_RECONNECT_ATTEMPTS = 10;
  private static readonly MAX_RECONNECT_DELAY = 30000;

  constructor(
    private vault: Vault,
    private spriteManager: SpriteManager,
    private remoteWorkDir: string,
  ) {}

  // --- Initial Upload ---

  async initialUpload(onProgress?: (done: number, total: number) => void): Promise<void> {
    const files = this.vault.getFiles().filter(f => this.shouldSync(f.path));
    let done = 0;
    const total = files.length;

    for (let i = 0; i < files.length; i += VaultSync.CONCURRENT_UPLOADS) {
      if (this.stopped) return;
      const batch = files.slice(i, i + VaultSync.CONCURRENT_UPLOADS);
      const results = await Promise.allSettled(batch.map(async (file) => {
        await this.pushFile(file);
        done++;
        onProgress?.(done, total);
      }));
      const allFailed = results.every(r => r.status === 'rejected');
      if (allFailed && batch.length > 0) {
        const firstErr = (results[0] as PromiseRejectedResult).reason;
        console.warn('VaultSync: all uploads in batch failed, aborting. First error:', firstErr);
        return;
      }
      for (const r of results) {
        if (r.status === 'rejected') {
          console.warn('VaultSync: failed to upload file:', r.reason);
        }
      }
    }
  }

  // --- Live: Obsidian → Sprite (debounced) ---

  startWatchingVault(): void {
    const onModify = (file: unknown) => this.debouncedPush(file as TAbstractFile);
    const onCreate = (file: unknown) => this.debouncedPush(file as TAbstractFile);
    const onDelete = (file: unknown) => this.handleLocalDelete((file as TAbstractFile).path);
    const onRename = (file: unknown, oldPath: unknown) => this.handleLocalRename(file as TAbstractFile, oldPath as string);

    this.vault.on('modify', onModify);
    this.vault.on('create', onCreate);
    this.vault.on('delete', onDelete);
    this.vault.on('rename', onRename);

    this.vaultEventRefs.push(
      () => this.vault.off('modify', onModify as (...data: unknown[]) => unknown),
      () => this.vault.off('create', onCreate as (...data: unknown[]) => unknown),
      () => this.vault.off('delete', onDelete as (...data: unknown[]) => unknown),
      () => this.vault.off('rename', onRename as (...data: unknown[]) => unknown),
    );
  }

  private debouncedPush(file: TAbstractFile): void {
    if (!(file instanceof TFile) || !this.shouldSync(file.path)) return;

    // Skip if we just pulled this file from the sprite (avoid echo loop)
    const lastPull = this.inFlightPushes.get(file.path);
    if (lastPull && Date.now() - lastPull < VaultSync.IN_FLIGHT_SUPPRESS_MS) {
      return;
    }

    const existing = this.pushDebounceTimers.get(file.path);
    if (existing) clearTimeout(existing);

    this.pushDebounceTimers.set(
      file.path,
      setTimeout(() => {
        this.pushDebounceTimers.delete(file.path);
        this.pushFile(file).catch(err => {
          console.warn(`VaultSync: push failed for ${file.path}:`, err);
        });
        this.inFlightPushes.set(file.path, Date.now());
      }, VaultSync.PUSH_DEBOUNCE_MS)
    );
  }

  private async pushFile(file: TFile): Promise<void> {
    if (file.stat.size > VaultSync.MAX_FILE_SIZE) return;
    const content = await this.vault.readBinary(file);
    const remotePath = `${this.remoteWorkDir}/${file.path}`;
    await this.spriteManager.uploadFile(remotePath, content);
  }

  private async handleLocalDelete(filePath: string): Promise<void> {
    if (!this.shouldSync(filePath)) return;
    const remotePath = `${this.remoteWorkDir}/${filePath}`;
    try {
      await this.spriteManager.deleteFile(remotePath);
    } catch (err) {
      console.warn(`VaultSync: delete failed for ${filePath}:`, err);
    }
  }

  private async handleLocalRename(file: TAbstractFile, oldPath: string): Promise<void> {
    if (!this.shouldSync(file.path)) return;
    await this.handleLocalDelete(oldPath);
    if (file instanceof TFile) {
      await this.pushFile(file).catch(err => {
        console.warn(`VaultSync: rename push failed for ${file.path}:`, err);
      });
    }
  }

  // --- Live: Sprite → Obsidian (WebSocket watch) ---

  startWatchingRemote(): void {
    this.connectWatch();
  }

  private async connectWatch(): Promise<void> {
    if (this.stopped) return;

    try {
      const serverUrl = await this.spriteManager.getTerminalServerUrl();
      const ticket = await this.spriteManager.getTerminalTicket();
      const wsUrl = `${serverUrl.replace(/^http/, 'ws')}/watch?path=${encodeURIComponent(this.remoteWorkDir)}`;

      this.watchWs = createAuthWebSocket(wsUrl, ticket);
    } catch (err) {
      console.warn('VaultSync: failed to create watch WebSocket:', err);
      return;
    }

    this.watchWs.on('open', () => {
      console.log('[VaultSync] watch connected');
      this.reconnectAttempts = 0;

      // Subscribe to changes in the remote work directory
      this.watchWs!.send(JSON.stringify({
        type: 'subscribe',
        paths: [this.remoteWorkDir],
        recursive: true,
      }));
    });

    this.watchWs.on('message', (data: unknown) => {
      const text =
        typeof data === 'string'
          ? data
          : new TextDecoder().decode(data as ArrayBuffer);

      try {
        const msg = JSON.parse(text);
        console.debug('[VaultSync] watch event:', msg.event, msg.path?.substring(0, 80));
        this.handleWatchEvent(msg);
      } catch {
        console.debug('[VaultSync] watch non-JSON:', text.substring(0, 100));
      }
    });

    this.watchWs.on('close', () => {
      if (!this.stopped) {
        this.attemptReconnect();
      }
    });

    this.watchWs.on('error', (err: Error) => {
      // Transient WebSocket errors are expected during sprite activity
      console.debug('[VaultSync] watch error:', err.message);
    });
  }

  private handleWatchEvent(msg: {
    type?: string;
    path?: string;
    event?: string;
    size?: number;
    isDir?: boolean;
  }): void {
    // Skip non-event messages (e.g. subscription confirmations)
    if (!msg.path || !msg.event) return;
    if (msg.isDir) return;

    // Convert absolute remote path to vault-relative path
    const prefix = this.remoteWorkDir + '/';
    if (!msg.path.startsWith(prefix)) return;
    const relativePath = msg.path.slice(prefix.length);

    if (!this.shouldSync(relativePath)) return;

    // Check in-flight suppression — skip if we just pushed this file
    if (this.inFlightPushes.has(relativePath)) {
      const pushTime = this.inFlightPushes.get(relativePath)!;
      if (Date.now() - pushTime < VaultSync.IN_FLIGHT_SUPPRESS_MS) return;
      this.inFlightPushes.delete(relativePath);
    }

    // Debounce per-file to avoid rapid-fire downloads
    const existing = this.pullDebounceTimers.get(relativePath);
    if (existing) clearTimeout(existing);

    this.pullDebounceTimers.set(
      relativePath,
      setTimeout(() => {
        this.pullDebounceTimers.delete(relativePath);
        if (msg.event === 'delete') {
          this.handleRemoteDelete(relativePath);
        } else {
          this.handleRemotePull(relativePath);
        }
      }, VaultSync.PULL_DEBOUNCE_MS)
    );
  }

  private async handleRemotePull(relativePath: string): Promise<void> {
    console.log('[VaultSync] pulling:', relativePath);
    // Suppress the vault modify → push-back echo for this file
    this.inFlightPushes.set(relativePath, Date.now());
    try {
      const remotePath = `${this.remoteWorkDir}/${relativePath}`;
      const content = await this.spriteManager.downloadFile(remotePath);

      const existingFile = this.vault.getAbstractFileByPath(relativePath);
      if (existingFile && existingFile instanceof TFile) {
        await this.vault.modifyBinary(existingFile, content);
      } else {
        const dir = relativePath.substring(0, relativePath.lastIndexOf('/'));
        if (dir) {
          try { await this.vault.createFolder(dir); } catch { /* may exist */ }
        }
        try {
          await this.vault.createBinary(relativePath, content);
        } catch {
          // File may have been created between check and write — retry as modify
          const retryFile = this.vault.getAbstractFileByPath(relativePath);
          if (retryFile && retryFile instanceof TFile) {
            await this.vault.modifyBinary(retryFile, content);
          }
        }
      }
    } catch (err: unknown) {
      const status = (err as { status?: number }).status;
      // 404 = file already gone (temp file), don't spam logs
      if (status !== 404) {
        console.warn(`VaultSync: failed to pull ${relativePath}:`, err);
      }
    }
  }

  private async handleRemoteDelete(relativePath: string): Promise<void> {
    try {
      const existingFile = this.vault.getAbstractFileByPath(relativePath);
      if (existingFile) {
        await this.vault.delete(existingFile);
      }
    } catch (err) {
      console.warn(`VaultSync: failed to delete local ${relativePath}:`, err);
    }
  }

  private attemptReconnect(): void {
    if (this.reconnectAttempts >= VaultSync.MAX_RECONNECT_ATTEMPTS) {
      console.warn('VaultSync: watch reconnect failed after max attempts');
      return;
    }

    this.reconnectAttempts++;
    const delay = Math.min(
      1000 * Math.pow(2, this.reconnectAttempts - 1),
      VaultSync.MAX_RECONNECT_DELAY
    );
    console.debug(`[VaultSync] reconnecting watch (attempt ${this.reconnectAttempts})...`);

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connectWatch();
    }, delay);
  }

  // --- Helpers ---

  private shouldSync(filePath: string): boolean {
    // Reject path traversal attempts
    if (filePath.includes('..') || filePath.startsWith('/')) return false;
    return !VaultSync.SKIP_PATTERNS.some(p => filePath.includes(p));
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.watchWs) {
      this.watchWs.removeAllListeners();
      this.watchWs.close();
      this.watchWs = null;
    }
    for (const timer of this.pushDebounceTimers.values()) {
      clearTimeout(timer);
    }
    for (const timer of this.pullDebounceTimers.values()) {
      clearTimeout(timer);
    }
    this.pushDebounceTimers.clear();
    this.pullDebounceTimers.clear();
    this.inFlightPushes.clear();
    for (const unsub of this.vaultEventRefs) {
      unsub();
    }
    this.vaultEventRefs = [];
  }
}

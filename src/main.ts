import { Plugin, WorkspaceLeaf, Menu, TFile, TFolder, Notice, Platform } from "obsidian";
import { TerminalView, VIEW_TYPE } from "./terminal-view";
import { ClaudeSidebarSettingsTab } from "./settings";
import { CLI_BACKENDS } from "./backends";
import { SpriteManager } from "./sprite-manager";
import { SpritesSetupModal } from "./setup-modal";
import type { IShellManager } from "./shell-interface";
import type { PluginData, Backend } from "./types";
import {
  debounce,
  generateSessionId,
  pruneSessionGroups,
  type SessionGroup,
} from "./session-groups";

// Type-only imports for modules that depend on Node.js built-ins.
// Actual modules are lazy-loaded via require() to avoid crashing on mobile.
import type { IdeServer } from "./ide-server";
import type { VaultSync } from "./vault-sync";
import type { RemoteIdeClient } from "./remote-ide-client";

export default class VaultTerminalPlugin extends Plugin {
  pluginData: PluginData = {};
  ideServer: IdeServer | null = null;
  spriteManager: SpriteManager | null = null;
  vaultSync: VaultSync | null = null;
  remoteIdeClient: RemoteIdeClient | null = null;
  private lastActiveTerminalLeaf: WorkspaceLeaf | null = null;
  private lastRibbonClick = 0;
  /** Most-recently-focused Claude session id. Drives auto-collect + swap. */
  private activeSessionId: string | null = null;
  /** True while we are restoring a layout — suppresses auto-collect feedback. */
  private swapping = false;
  /** False until initSessionGroups completes. Suppresses session-group writes
   *  during Obsidian's workspace restore phase, where active-leaf-change /
   *  layout-change events fire before we've established the correct
   *  activeSessionId, and any captures or swaps would corrupt saved groups. */
  private sessionGroupsReady = false;
  /** Debounced snapshot of the current main-area layout into the active session. */
  private snapshotDebounced: ReturnType<typeof debounce<[]>> | null = null;

  async onload() {
    this.pluginData = await this.loadData() || {};
    this.lastActiveTerminalLeaf = null;

    this.registerView(VIEW_TYPE, (leaf) => new TerminalView(leaf, this));

    // On mobile, migrate any sidebar leaves to full-width tabs after layout restores
    if (Platform.isMobile) {
      this.app.workspace.onLayoutReady(() => {
        const sidebarLeaves = this.app.workspace.getLeavesOfType(VIEW_TYPE)
          .filter(l => l.getRoot() !== this.app.workspace.rootSplit);
        for (const old of sidebarLeaves) {
          old.detach();
        }
      });
    }

    // Track the most recently focused Claude tab
    this.registerEvent(
      this.app.workspace.on("active-leaf-change", (leaf) => {
        if (leaf && leaf.view instanceof TerminalView) {
          this.lastActiveTerminalLeaf = leaf;
        }
      })
    );

    // Session groups: assign sessionIds to existing tabs, then wire swap + auto-collect.
    this.snapshotDebounced = debounce(() => this.captureActiveSnapshot(), 400);
    this.app.workspace.onLayoutReady(() => void this.initSessionGroups());

    // Swap main-area layout when the focused Claude session changes;
    // also direct keystrokes into the xterm element so Ctrl+Tab and tab-header
    // clicks land you ready-to-type instead of needing a click into the terminal.
    this.registerEvent(
      this.app.workspace.on("active-leaf-change", (leaf) => {
        if (!this.sessionGroupsReady || this.swapping || !leaf) return;
        if (leaf.view instanceof TerminalView) {
          const view = leaf.view;
          const id = view.sessionId;
          console.log("[claude-sidebar-ide] leaf-change to claude tab id=%s active=%s",
            id?.slice(0, 8), this.activeSessionId?.slice(0, 8));
          if (id && id !== this.activeSessionId) {
            void this.switchSession(id);
          } else {
            setTimeout(() => view.term?.focus(), 0);
          }
        } else if (leaf.getRoot() === this.app.workspace.rootSplit) {
          this.snapshotDebounced?.();
        }
      })
    );

    // Catch splits / tab moves / file opens that don't trip active-leaf-change.
    this.registerEvent(
      this.app.workspace.on("layout-change", () => {
        if (!this.sessionGroupsReady || this.swapping) return;
        this.dedupeSessionIds();
        this.snapshotDebounced?.();
        this.pruneStaleGroups();
      })
    );

    const ribbonIcon = this.addRibbonIcon("bot", "New Claude Tab", () => {
      const now = Date.now();
      if (now - this.lastRibbonClick < 1500) return; // 1.5s throttle to prevent accidental double-clicks
      this.lastRibbonClick = now;
      this.createNewTab();
    });

    // Right-click context menu
    ribbonIcon.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      const menu = new Menu();
      const activeBackend = CLI_BACKENDS[this.pluginData.cliBackend || "claude"];
      if (activeBackend.yoloFlag) {
        menu.addItem((item) => {
          item.setTitle("Open in YOLO mode")
            .setIcon("zap")
            .onClick(() => {
              const now = Date.now();
              if (now - this.lastRibbonClick < 1500) return;
              this.lastRibbonClick = now;
              this.createNewTab(null, true);
            });
        });
      }
      menu.addItem((item) => {
        item.setTitle("Run from active folder")
          .setIcon("folder-open")
          .onClick(() => {
            const now = Date.now();
            if (now - this.lastRibbonClick < 1500) return;
            this.lastRibbonClick = now;
            const file = this.app.workspace.getActiveFile();
            let dir: string | null = null;
            if (file) {
              const vaultPath = this.getVaultPath();
              const parentPath = file.parent ? file.parent.path : "";
              dir = parentPath ? `${vaultPath}/${parentPath}` : vaultPath;
            }
            this.createNewTab(dir);
          });
      });
      if (activeBackend.resumeFlag) {
        menu.addItem((item) => {
          item.setTitle("Resume last conversation")
            .setIcon("history")
            .onClick(() => {
              const now = Date.now();
              if (now - this.lastRibbonClick < 1500) return;
              this.lastRibbonClick = now;
              const lastCwd = this.pluginData.lastCwd || null;
              this.createNewTab(lastCwd, false, true);
            });
        });
      }
      menu.showAtMouseEvent(e);
    });

    this.addCommand({
      id: "open-claude",
      name: "Open Claude Code",
      callback: () => this.activateView(),
    });

    this.addCommand({
      id: "new-claude-tab",
      name: "New Claude Tab",
      callback: () => this.createNewTab(),
    });

    this.addCommand({
      id: "new-claude-tab-yolo",
      name: "New Tab (YOLO mode)",
      checkCallback: (checking) => {
        const backend = CLI_BACKENDS[this.pluginData.cliBackend || "claude"];
        if (!backend?.yoloFlag) return false;
        if (!checking) this.createNewTab(null, true);
        return true;
      },
    });

    this.addCommand({
      id: "close-claude-tab",
      name: "Close Claude Tab",
      checkCallback: (checking) => {
        const view = this.app.workspace.getActiveViewOfType(TerminalView);
        if (view) {
          if (!checking) view.leaf.detach();
          return true;
        }
        return false;
      },
    });

    this.addCommand({
      id: "toggle-claude-focus",
      name: "Toggle Focus: Editor \u2194 Claude",
      callback: () => this.toggleFocus(),
    });

    this.addCommand({
      id: "send-file-to-claude",
      name: "Send File Path to Claude",
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        if (!file) return false;
        if (!checking) {
          const absolutePath = `"${this.getVaultPath()}/${file.path}" `;
          this.sendTextToTerminal(absolutePath);
        }
        return true;
      },
    });

    this.addCommand({
      id: "send-selection-to-claude",
      name: "Send Selection to Claude",
      checkCallback: (checking) => {
        const editor = this.app.workspace.activeEditor?.editor;
        if (!editor) return false;
        const selection = editor.getSelection();
        if (!selection) return false;
        if (!checking) {
          this.sendTextToTerminal(selection);
        }
        return true;
      },
    });

    this.addCommand({
      id: "run-claude-from-folder",
      name: "Run Claude from this folder",
      callback: () => {
        const file = this.app.workspace.getActiveFile();
        let dir: string | null = null;
        if (file) {
          const vaultPath = this.getVaultPath();
          const parentPath = file.parent ? file.parent.path : "";
          dir = parentPath ? `${vaultPath}/${parentPath}` : vaultPath;
        }
        this.createNewTab(dir);
      },
    });

    this.addCommand({
      id: "resume-claude",
      name: "Resume last conversation",
      checkCallback: (checking) => {
        const backend = CLI_BACKENDS[this.pluginData.cliBackend || "claude"];
        if (!backend?.resumeFlag) return false;
        if (!checking) {
          const lastCwd = this.pluginData.lastCwd || null;
          this.createNewTab(lastCwd, false, true);
        }
        return true;
      },
    });

    // Register folder context menu (desktop only — requires filesystem adapter)
    if (Platform.isDesktopApp) {
      this.registerEvent(
        this.app.workspace.on("file-menu", (menu, file) => {
          // Only show for folders, not files
          if (file instanceof TFolder) {
            menu.addItem((item) =>
              item
                .setTitle("Open Claude here")
                .setIcon("bot")
                .onClick(() => {
                  const absolutePath = (this.app.vault.adapter as any).getFullPath(file.path);
                  this.createNewTab(absolutePath);
                })
            );
            const folderBackend = CLI_BACKENDS[this.pluginData.cliBackend || "claude"];
            if (folderBackend.yoloFlag) {
              menu.addItem((item) =>
                item
                  .setTitle("Open Claude here (YOLO)")
                  .setIcon("zap")
                  .onClick(() => {
                    const absolutePath = (this.app.vault.adapter as any).getFullPath(file.path);
                    this.createNewTab(absolutePath, true);
                  })
              );
            }
          }
        })
      );
    }

    // Register editor context menu (right-click on selected text)
    this.registerEvent(
      this.app.workspace.on("editor-menu", (menu, editor) => {
        const selection = editor.getSelection();
        if (selection) {
          menu.addItem((item) =>
            item
              .setTitle("Send selection to Claude")
              .setIcon("bot")
              .onClick(() => {
                this.sendTextToTerminal(selection);
              })
          );
        }
      })
    );

    // IDE integration: push selection_changed on active leaf change
    this.registerEvent(
      this.app.workspace.on("active-leaf-change", () => {
        this.ideServer?.pushSelection();
        this.remoteIdeClient?.pushSelection();
      })
    );

    // IDE integration: track editor content and selection changes
    this.registerEvent(
      this.app.workspace.on("editor-change", () => {
        this.ideServer?.pushSelection();
        this.remoteIdeClient?.pushSelection();
      })
    );

    // Capture selection changes (cursor moves, text highlights) via DOM event
    const selHandler = () => {
      this.ideServer?.pushSelection();
      this.remoteIdeClient?.pushSelection();
    };
    document.addEventListener("selectionchange", selHandler);
    this.register(() => document.removeEventListener("selectionchange", selHandler));

    // Initialize runtime infrastructure based on mode
    this.updateRuntimeMode();

    this.addSettingTab(new ClaudeSidebarSettingsTab(this.app, this));
  }

  onunload() {
    // Stop remote services
    this.stopRemoteSession();
    // Stop IDE integration server
    this.stopIdeServer();
    // Kill all terminal processes before unloading to prevent orphans
    const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE);
    for (const leaf of leaves) {
      const view = leaf.view;
      if (view instanceof TerminalView) {
        view.stopShell();
      }
    }
  }

  getVaultPath(): string {
    const adapter = this.app.vault.adapter as any;
    return adapter.basePath || "";
  }

  startIdeServer(): void {
    const { IdeServer: IdeServerImpl } = require("./ide-server");
    this.ideServer = new IdeServerImpl(this.app, () => this.getVaultPath());
    this.ideServer!.notifyCallback = (type: string, notificationType: string | null, _message: string | null) => {
      if (type === "stop") {
        new Notice("Claude finished", 4000);
      } else if (type === "notification") {
        if (notificationType === "permission_prompt") {
          new Notice("Claude needs permission", 8000);
        } else if (notificationType === "elicitation_dialog") {
          new Notice("Claude is asking a question", 8000);
        }
      }
    };
    this.ideServer!.start();
  }

  stopIdeServer(): void {
    this.ideServer?.stop();
    this.ideServer = null;
  }

  /** (Re-)initialize runtime infrastructure when mode or token changes. */
  updateRuntimeMode(): void {
    if (this.pluginData.runtimeMode === 'sprites' && this.pluginData.spritesApiToken) {
      // Sprites mode — create SpriteManager, stop local IDE server
      this.stopIdeServer();
      this.spriteManager = new SpriteManager(
        this.pluginData.spritesApiToken,
        this.app.vault.getName(),
      );
    } else {
      // Local mode — start IDE server, clear sprite manager
      this.spriteManager = null;
      try {
        this.startIdeServer();
      } catch {
        // Mobile — Node.js modules unavailable, IDE server not needed
      }
    }
  }

  // --- Remote Shell Support ---

  createShellManager(
    getBackend: () => Backend,
    pluginData: PluginData,
    getVaultPath: () => string,
    getIdePort: () => number | null,
  ): IShellManager {
    if (this.pluginData.runtimeMode === 'sprites' && this.spriteManager) {
      const { RemoteShellManager } = require("./remote-shell-manager");
      return new RemoteShellManager(getBackend, pluginData, this.spriteManager);
    }
    try {
      const { ShellManager } = require("./shell-manager");
      return new ShellManager(getBackend, pluginData, getVaultPath, getIdePort);
    } catch {
      // Mobile without Sprites — Node.js modules unavailable
      return {
        get isRunning() { return false; },
        start(_opts: unknown, callbacks: { onStdout(s: string): void; onExit(c: number, s: null): void }) {
          callbacks.onStdout('\r\nSprites mode is required on mobile.\r\nConfigure it in plugin settings.\r\n');
          callbacks.onExit(1, null);
        },
        write() {},
        resize() {},
        stop() {},
      };
    }
  }

  async startRemoteSession(spriteName: string): Promise<void> {
    if (!this.pluginData.spritesApiToken || !this.spriteManager) return;

    // Start vault sync — upload files to a dedicated subdirectory on the sprite
    const { VaultSync: VaultSyncImpl } = require("./vault-sync");
    this.vaultSync = new VaultSyncImpl(
      this.app.vault,
      this.spriteManager,
      '/home/sprite/obsidian',
    );
    try {
      await this.vaultSync!.initialUpload();
    } catch (err) {
      console.warn('VaultSync initial upload failed:', err);
    }
    // Guard against race: stopRemoteSession() may have nulled vaultSync during await
    if (!this.vaultSync) return;

    // Ensure Claude Code is installed before starting the watch WebSocket,
    // since ensureClaudeInstalled may checkpoint/restart the sprite
    await this.spriteManager.ensureClaudeInstalled();

    this.vaultSync.startWatchingVault();
    this.vaultSync.startWatchingRemote();

    // Start remote IDE client
    const { RemoteIdeClient: RemoteIdeClientImpl } = require("./remote-ide-client");
    this.remoteIdeClient = new RemoteIdeClientImpl(this.app, () => this.getVaultPath(), this.spriteManager);
    try {
      await this.remoteIdeClient!.connect();
    } catch (err) {
      console.warn('RemoteIdeClient connection failed:', err);
    }
  }

  stopRemoteSession(): void {
    this.vaultSync?.stop();
    this.vaultSync = null;
    this.remoteIdeClient?.disconnect();
    this.remoteIdeClient = null;
  }

  async destroySprite(): Promise<void> {
    this.stopRemoteSession();
    if (this.spriteManager) {
      try {
        await this.spriteManager.destroy();
        new Notice('Sprite destroyed.');
      } catch (err) {
        new Notice(`Failed to destroy Sprite: ${(err as Error).message}`);
      }
    }
  }

  private async toggleFocus(): Promise<void> {
    const activeView = this.app.workspace.getActiveViewOfType(TerminalView);
    if (activeView) {
      // Currently in Claude, go to editor
      const leaves = this.app.workspace.getLeavesOfType("markdown");
      if (leaves.length > 0) {
        this.app.workspace.setActiveLeaf(leaves[0], { focus: true });
      }
    } else {
      // Currently in editor, go to Claude (prefer last-active tab)
      const claudeLeaves = this.app.workspace.getLeavesOfType(VIEW_TYPE);
      if (claudeLeaves.length > 0) {
        let target = claudeLeaves[0];
        if (this.lastActiveTerminalLeaf && claudeLeaves.includes(this.lastActiveTerminalLeaf)) {
          target = this.lastActiveTerminalLeaf;
        }
        this.app.workspace.setActiveLeaf(target, { focus: true });
        const view = target.view;
        if (view instanceof TerminalView && view.term) {
          view.term.focus();
        }
      }
    }
  }

  private async activateView(): Promise<void> {
    const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE);
    if (leaves.length) {
      this.app.workspace.revealLeaf(leaves[0]);
      return;
    }
    await this.createNewTab();
  }

  async createNewTab(
    workingDir: string | null = null,
    yoloMode = false,
    continueSession = false
  ): Promise<void> {
    let leaf: WorkspaceLeaf;
    const isMobile = Platform.isMobile;
    if (isMobile) {
      // On mobile, open as a full-width tab in the main content area
      // Detach any existing Claude leaves stuck in the sidebar
      for (const old of this.app.workspace.getLeavesOfType(VIEW_TYPE)) {
        if (old.getRoot() !== this.app.workspace.rootSplit) {
          old.detach();
        }
      }
      // Reuse existing main-area leaf, or create one explicitly in rootSplit
      const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE)
        .filter(l => l.getRoot() === this.app.workspace.rootSplit);
      leaf = existing.length > 0
        ? existing[0]
        : this.app.workspace.createLeafInParent(this.app.workspace.rootSplit, 0);
    } else {
      // Always spin up a fresh leaf so multi-tab actually works. The previous
      // logic reused the first existing Claude leaf, which broke the multi-tab
      // spawn UX and made the session-groups feature confused about identity.
      leaf = this.app.workspace.getRightLeaf(true)!;
    }
    if (leaf) {
      const state: Record<string, unknown> = {};
      if (workingDir) state.workingDir = workingDir;
      if (yoloMode) state.yoloMode = yoloMode;
      if (continueSession) state.continueSession = continueSession;
      // Reuse existing sessionId if this leaf already had one (re-init case);
      // otherwise mint a fresh one so the session-groups feature can track it.
      const existingId = (leaf.view instanceof TerminalView ? leaf.view.sessionId : null);
      const sessionId = existingId || generateSessionId();
      state.sessionId = sessionId;
      await leaf.setViewState({
        type: VIEW_TYPE,
        active: true,
        state,
      });
      // setViewState replaces the view; re-read and stamp the id explicitly so it
      // is available immediately to the active-leaf-change listener that will fire.
      if (leaf.view instanceof TerminalView) {
        leaf.view.sessionId = sessionId;
      }
      this.setActiveSession(sessionId);
      this.app.workspace.revealLeaf(leaf);
      // Focus the terminal after the leaf is revealed
      setTimeout(() => {
        const view = leaf.view;
        if (view instanceof TerminalView && view.term) {
          view.term.focus();
        }
      }, 50);
    }
  }

  async sendTextToTerminal(text: string): Promise<boolean> {
    let leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE);
    const needsNewTab = leaves.length === 0;
    if (needsNewTab) {
      await this.createNewTab();
      leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE);
    }
    if (leaves.length === 0) return false;

    // Prefer the most recently focused Claude tab, fall back to first
    let leaf = leaves[0];
    if (this.lastActiveTerminalLeaf && leaves.includes(this.lastActiveTerminalLeaf)) {
      leaf = this.lastActiveTerminalLeaf;
    }
    const view = leaf.view;

    if (!(view instanceof TerminalView)) return false;

    if (needsNewTab) {
      // Wait for process to start
      let attempts = 0;
      while ((!view.isShellRunning || !view.hasOutput) && attempts < 100) {
        await new Promise((r) => setTimeout(r, 50));
        attempts++;
      }
      // Additional delay for Claude to fully initialize after first output
      await new Promise((r) => setTimeout(r, 1000));
    }

    if (!view.isShellRunning) return false;

    view.writeToShell(text);

    this.app.workspace.setActiveLeaf(leaf, { focus: true });
    if (view.term) {
      view.term.focus();
    }
    return true;
  }

  // ─── Session Groups ────────────────────────────────────────────────────────

  /**
   * Called once on layout-ready. Assigns a stable id to any pre-existing Claude
   * tab that has none (BRAT-installed or pre-feature data), then seeds
   * activeSessionId from the most-recently-focused tab.
   */
  private async initSessionGroups(): Promise<void> {
    // Wrap the entire init in `swapping` so any active-leaf-change /
    // layout-change events that fire during workspace restore can't trigger
    // an auto-capture before we sync main with the active session's saved
    // state. Without this, the user's previous session-group data gets
    // overwritten by whatever Obsidian's main split happens to be holding
    // at reload time.
    this.swapping = true;
    try {
      const claudeLeaves = this.app.workspace.getLeavesOfType(VIEW_TYPE);
      for (const leaf of claudeLeaves) {
        if (!(leaf.view instanceof TerminalView)) continue;
        if (!leaf.view.sessionId) {
          // In-memory only — Obsidian's next workspace save will pick it up
          // via getState(). Calling setViewState() here would re-trigger
          // setState() on the live TerminalView and restart the running shell.
          leaf.view.sessionId = generateSessionId();
        }
      }
      // Resolve initial active session in this priority order:
      //   1. pluginData.activeSessionId (the session that was active at quit) —
      //      this matters because Obsidian doesn't auto-focus a sidebar leaf on
      //      reload, so getActiveViewOfType is unreliable here.
      //   2. The currently-focused TerminalView, if any.
      //   3. The first Claude leaf as a fallback.
      const liveIds = new Set<string>();
      for (const leaf of claudeLeaves) {
        const id = this.leafSessionId(leaf);
        if (id) liveIds.add(id);
      }
      const persisted = this.pluginData.activeSessionId;
      const focused = this.app.workspace.getActiveViewOfType(TerminalView);
      let resolved: string | null = null;
      if (persisted && liveIds.has(persisted)) {
        resolved = persisted;
      } else if (focused?.sessionId && liveIds.has(focused.sessionId)) {
        resolved = focused.sessionId;
      } else if (claudeLeaves[0]?.view instanceof TerminalView) {
        resolved = claudeLeaves[0].view.sessionId ?? null;
      }
      if (resolved) this.setActiveSession(resolved);

      // Sync main with the active session's saved group so the first user
      // action doesn't destructively capture stale workspace state into it.
      if (this.activeSessionId) {
        const group = this.pluginData.sessionGroups?.[this.activeSessionId];
        if (group) {
          await this.restoreSession(group);
        }
      }

      this.pruneStaleGroups();
    } catch (err) {
      console.warn("[claude-sidebar-ide] initSessionGroups failed:", err);
    } finally {
      this.swapping = false;
      this.sessionGroupsReady = true;
    }
  }

  /**
   * Walk main-area leaves and collect (vault-relative) file paths for the
   * notes currently open. Skips empty leaves, search/graph views, and any
   * non-file content.
   */
  private collectMainFiles(): { files: string[]; activeFile: string | null } {
    const files: string[] = [];
    this.app.workspace.iterateRootLeaves((leaf) => {
      const file = (leaf.view as { file?: { path?: string } } | undefined)?.file;
      if (file?.path) files.push(file.path);
    });
    const af = this.app.workspace.getActiveFile();
    const activeFile = af && files.includes(af.path) ? af.path : null;
    return { files, activeFile };
  }

  /** Save the current main-area files into the given session's group. */
  private captureToSession(sessionId: string): void {
    const { files, activeFile } = this.collectMainFiles();
    if (!this.pluginData.sessionGroups) this.pluginData.sessionGroups = {};
    this.pluginData.sessionGroups[sessionId] = {
      files,
      activeFile,
      lastUpdated: Date.now(),
    };
    void this.saveData(this.pluginData);
  }

  /** Snapshot current main-area files into the active session's group. */
  private captureActiveSnapshot(): void {
    if (this.swapping || !this.activeSessionId) return;
    this.captureToSession(this.activeSessionId);
  }

  /**
   * Replace the main area with the files from the given session's group.
   *
   * Strategy: open all target files first (Obsidian's openLinkText handles
   * focusing existing leaves vs creating new ones). Then walk main and
   * reconcile by file path — keep exactly one leaf per target file, detach
   * everything else. Tracking by leaf object reference proved unreliable
   * because Obsidian recycles leaves across openLinkText calls.
   */
  private async restoreSession(group: SessionGroup): Promise<void> {
    // Resolve target file paths to TFile refs; skip missing.
    const targetFiles: TFile[] = [];
    const missing: string[] = [];
    for (const filePath of group.files) {
      const f = this.app.vault.getAbstractFileByPath(filePath);
      if (f instanceof TFile) targetFiles.push(f);
      else missing.push(filePath);
    }
    console.log("[claude-sidebar-ide]   restoreSession resolved=%d missing=%o",
      targetFiles.length, missing);

    if (targetFiles.length === 0) {
      // Saved group is intentionally empty — clear main.
      const toDetach: WorkspaceLeaf[] = [];
      this.app.workspace.iterateRootLeaves((leaf) => toDetach.push(leaf));
      for (const leaf of toDetach) leaf.detach();
      return;
    }

    // Open every target file. This may create new tabs or focus existing leaves
    // displaying the same file. Either way, after this loop main contains at
    // least one leaf per target file (plus possibly leftover leaves from before).
    for (const file of targetFiles) {
      await this.app.workspace.openLinkText(file.path, "", "tab", { active: false });
    }

    // Reconcile: keep exactly one leaf per target file, detach everything else.
    const targetPaths = new Set(targetFiles.map((f) => f.path));
    const kept = new Set<string>();
    const toDetach: WorkspaceLeaf[] = [];
    let activeLeaf: WorkspaceLeaf | null = null;
    this.app.workspace.iterateRootLeaves((leaf) => {
      const path = (leaf.view as { file?: { path?: string } } | undefined)?.file?.path;
      if (!path || !targetPaths.has(path) || kept.has(path)) {
        toDetach.push(leaf);
        return;
      }
      kept.add(path);
      if (path === group.activeFile) activeLeaf = leaf;
    });
    for (const leaf of toDetach) leaf.detach();

    if (activeLeaf) this.app.workspace.setActiveLeaf(activeLeaf, { focus: false });
  }

  /**
   * Capture the outgoing session's files, then rebuild the main area from the
   * incoming session's files. If the incoming session has no saved group,
   * leave the main area as-is (first switch becomes the seed for that group).
   */
  private async switchSession(newId: string): Promise<void> {
    if (this.swapping) return;
    console.log("[claude-sidebar-ide] switchSession %s -> %s",
      this.activeSessionId?.slice(0, 8), newId.slice(0, 8));
    this.swapping = true;
    try {
      this.snapshotDebounced?.cancel();
      if (this.activeSessionId && this.activeSessionId !== newId) {
        this.captureToSession(this.activeSessionId);
      }
      const incoming = this.pluginData.sessionGroups?.[newId];
      console.log("[claude-sidebar-ide]   incoming=%o", incoming?.files);
      if (incoming) {
        await this.restoreSession(incoming);
        console.log("[claude-sidebar-ide]   restoreSession returned");
      }
      this.setActiveSession(newId);
      await this.saveData(this.pluginData);

      // restoreSession sets the visible tab in main via setActiveLeaf, which
      // moves keyboard focus to the editor. Pull it back so the user lands on
      // the Claude tab they just switched to and Ctrl+Tab keeps cycling
      // sessions instead of cycling main-area .md files.
      const newLeaf = this.app.workspace.getLeavesOfType(VIEW_TYPE).find(
        (l) => l.view instanceof TerminalView && l.view.sessionId === newId,
      );
      if (newLeaf) {
        this.app.workspace.setActiveLeaf(newLeaf, { focus: true });
        const view = newLeaf.view;
        if (view instanceof TerminalView) view.term?.focus();
      }
    } catch (err) {
      console.warn("[claude-sidebar-ide] switchSession failed:", err);
    } finally {
      this.swapping = false;
    }
  }

  /**
   * Obsidian's "split" duplicates a view's state onto the new leaf, including
   * our sessionId. Walk Claude leaves; the first occurrence of each id keeps
   * it, any duplicate gets a fresh id.
   *
   * When a fresh id is minted (a split-cloned session is now distinct), we
   * also snap activeSessionId to it. Reason: after a split, focus typically
   * lands on an empty leaf in the new pane, NOT on the new Claude tab — so
   * `active-leaf-change` won't fire for the new session. Without this snap,
   * subsequent file opens would keep capturing into the OLD session,
   * overwriting its state with what the user thinks is "the new session's"
   * content. Capture the outgoing state first so it survives.
   */
  private dedupeSessionIds(): void {
    const seen = new Set<string>();
    let newestId: string | null = null;
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) {
      if (!(leaf.view instanceof TerminalView)) continue;
      const id = leaf.view.sessionId;
      if (!id) {
        leaf.view.sessionId = generateSessionId();
        seen.add(leaf.view.sessionId);
        newestId = leaf.view.sessionId;
      } else if (seen.has(id)) {
        leaf.view.sessionId = generateSessionId();
        seen.add(leaf.view.sessionId);
        newestId = leaf.view.sessionId;
      } else {
        seen.add(id);
      }
    }
    if (newestId) {
      // Capture outgoing first so its state isn't lost.
      if (this.activeSessionId && this.activeSessionId !== newestId) {
        this.captureToSession(this.activeSessionId);
      }
      this.setActiveSession(newestId);
    }
  }

  /** In-memory + on-disk update of the active session pointer, so reload picks
   *  the right tab back up. captureToSession / saveData calls elsewhere may
   *  also persist this — having a single helper keeps all writers consistent. */
  private setActiveSession(id: string): void {
    this.activeSessionId = id;
    this.pluginData.activeSessionId = id;
    void this.saveData(this.pluginData);
  }

  /**
   * Read the sessionId for a Claude leaf, falling back to the leaf's persisted
   * view state when the live view hasn't been instantiated yet. Obsidian lazy-
   * loads tabs that aren't currently visible in their tab group, so a dormant
   * Claude tab may exist as a leaf with no `TerminalView` yet — but its
   * sessionId is still present in workspace.json via getViewState.
   */
  private leafSessionId(leaf: WorkspaceLeaf): string | null {
    if (leaf.view instanceof TerminalView && leaf.view.sessionId) {
      return leaf.view.sessionId;
    }
    const stored = (leaf.getViewState()?.state as { sessionId?: unknown } | undefined)?.sessionId;
    return typeof stored === "string" ? stored : null;
  }

  /** Drop session-group entries whose Claude tab no longer exists. */
  private pruneStaleGroups(): void {
    const liveIds: string[] = [];
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) {
      const id = this.leafSessionId(leaf);
      if (id) liveIds.push(id);
    }
    const before = this.pluginData.sessionGroups;
    const after = pruneSessionGroups(before, liveIds);
    if (before && Object.keys(before).length !== Object.keys(after).length) {
      this.pluginData.sessionGroups = after;
      void this.saveData(this.pluginData);
    }
    if (this.activeSessionId && !liveIds.includes(this.activeSessionId)) {
      this.activeSessionId = liveIds[0] ?? null;
    }
  }
}

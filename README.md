# Claude Sidebar IDE

Run Claude Code (and other AI coding CLIs) directly in your Obsidian sidebar — on desktop or mobile — with full IDE awareness of what you're editing, **each Claude tab keeping its own conversation across reloads**, and **each Claude tab keeping its own group of open notes** so the main editor swaps to match whichever session you're focused on.

## Fork Lineage

Three generations, each adding one big capability on top of the previous:

| Generation | Repo | What it added |
|---|---|---|
| 1 — Original | [`derek-larson14/obsidian-claude-sidebar`](https://github.com/derek-larson14/obsidian-claude-sidebar) | Embedded an xterm.js terminal in the Obsidian sidebar so you could run Claude Code (and other AI CLIs) inside your vault. Manual "Send File / Send Selection" commands. Multi-backend (Claude Code, Codex, Gemini CLI, OpenCode, Aider). |
| 2 — IDE | [`MatthewHallCom/obsidian-claude-sidebar-ide`](https://github.com/MatthewHallCom/obsidian-claude-sidebar-ide) | Automatic **IDE integration** — runs a local WebSocket MCP server using the same lock-file discovery protocol Claude Code's VS Code/Neovim extensions use. Claude sees your current file, selection, and open editors live (debounced 150 ms). Side-by-side diff modal for accept/reject of proposed edits. Also: TypeScript rewrite of the original, Sprites cloud-VM mobile mode. |
| 3 — Sessions | **this fork** ([`coletaylor788/obsidian-claude-sidebar-ide`](https://github.com/coletaylor788/obsidian-claude-sidebar-ide)) | **Session-bound tab groups** (each Claude tab keeps its own set of open notes; switching sessions swaps the main editor), **per-tab Claude conversation persistence** (each tab resumes its own conversation across reload via `claude --resume <id>`, capturing the id from `~/.claude/projects/`), and **hotkey-bindable Next/Previous Session commands**. |

## Features

Combined feature set across all three generations:

### Terminal in the sidebar (gen 1)

- xterm.js terminal embedded in the Obsidian sidebar
- Multi-backend: Claude Code, Codex CLI, Gemini CLI, OpenCode, Aider
- Multi-tab terminal support, YOLO mode (skip permissions) toggle
- Right-click on any folder → "Open Claude here" / "Open Claude here (YOLO)"
- Right-click on selected text → "Send selection to Claude"
- Resume last conversation (`--continue`)
- Chinese IME / CJK input support, Linux PTY permission fix, Windows ConPTY support via [pywinpty](https://github.com/andfoy/pywinpty)

### Automatic IDE integration (gen 2, Claude Code only)

When you run Claude Code in the sidebar, the plugin starts a WebSocket MCP server on `127.0.0.1` and writes a lock file to `~/.claude/ide/<port>.lock`. The Claude CLI discovers it on startup and connects, exactly like the VS Code extension does.

- **Live current-file + selection** — Claude knows what note you're viewing and what text you've highlighted, no copy/pasting paths
- **`selection_changed` push** — debounced 150 ms; updates as you navigate
- **Tool surface** — `getCurrentSelection`, `getLatestSelection`, `getOpenEditors`, `getWorkspaceFolders`, `openFile`, `openDiff`, `saveDocument`, `close_tab`
- **Diff review modal** — when Claude proposes an edit, you get a side-by-side diff with accept/reject buttons; result is sent back to Claude
- **Mobile (Sprites mode)** — provisions a cloud VM, runs Claude Code there, syncs your vault both ways

### Session-bound tab groups (gen 3, this fork)

Each Claude tab in the sidebar is its own session, identified by a stable UUID. Whatever notes you open in the main editor while a session is focused get auto-collected into that session's group. Switching to a different Claude tab swaps the main editor over to that session's notes; switching back restores them.

- **Stable session ids** — UUIDs persist via the leaf's view state and survive Obsidian restarts
- **Auto-collect** — no manual binding step; whichever Claude tab is the most recently focused is the active session, and notes flow to it
- **Split → new session** — splitting a Claude tab clones the sessionId; the plugin detects the collision, mints a fresh id, and snaps `activeSessionId` to it so the user's mental model ("the new tab is my new session") matches behavior
- **Persistent** — `pluginData.sessionGroups` survives restarts; sessions whose Claude tabs are closed have their groups pruned. The plugin also persists `pluginData.activeSessionId` so reload syncs main with the right session's group instead of falling back to whatever Obsidian had cached
- **Dormant-tab safe** — Obsidian lazy-instantiates non-visible tabs in a tab group, so on reload only the focused leaf has a live view. The plugin reads sessionIds from `leaf.getViewState()` as a fallback, so dormant tabs' groups don't get wrongly pruned
- **Initialization gate** — captures and swaps are suppressed until `initSessionGroups` finishes, so workspace-restore events can't corrupt saved groups
- **Tested** — pure helpers (`generateSessionId`, `pruneSessionGroups`, `debounce`) covered by `bun test`; `bun run check` runs typecheck → tests → build

Trade-off (worth knowing): splits and cursor positions inside the main editor area do not survive a session swap. Files reopen as plain tabs in arrival order. If you need split fidelity, a previous attempt used `getLayout`/`changeLayout` to preserve them but proved unreliable (partial restores due to leaf-id collisions); the current implementation captures only file paths because that approach has been stable.

See `src/session-groups.ts` for the pure helpers and the `// ─── Session Groups ───` block in `src/main.ts` for the wiring.

### Per-tab Claude conversation persistence (gen 3, this fork, Claude Code only)

Stock Claude Code resumes via `claude --continue`, which always picks the most-recently-active conversation in the cwd. With multiple Claude tabs running in the same vault, all tabs collapse onto the same chat after reload. This fork captures each tab's specific Claude session id and resumes by id, so each tab keeps its own conversation.

- **Capture** — after each Claude tab spawns, a 2-second poll (running for up to 10 minutes) watches `~/.claude/projects/<encoded-cwd>/` for the new `.jsonl` Claude writes when you send your first message. The filename IS the session id; the plugin stores it on the `TerminalView` and Obsidian persists it to `workspace.json` via `getState()`.
- **Resume** — on reload, `claude --resume <id>` is used per tab instead of `claude --continue`. If a tab has no captured id yet (brand new), it falls back to the old `--continue` behavior; the next conversation populates the id.
- **Race-safe** — the capture poll filters out files older than the tab's spawn time and refuses ids any other live tab already owns, so two tabs spawning in the same cwd can't both grab the same conversation. Init-time dedupe self-heals existing collisions on reload.
- **Path encoding** — Claude's project dir is named after the cwd with `/` and `.` mapped to `-`, on the *resolved* (real) path. The plugin replicates this exactly, so symlinked workspaces (e.g., a vault under `~/claude` that resolves to OneDrive) are handled correctly.

See `src/claude-session-capture.ts` for the pure helpers (12 unit tests) and the `startClaudeSessionCapture` method in `src/terminal-view.ts` for the poll wiring.

### Hotkey-bindable session navigation (gen 3, this fork)

Two new commands you can bind to any keyboard shortcut via Settings → Hotkeys:

- **Next Claude Session** — cycle forward through Claude tabs, wrapping at the end
- **Previous Claude Session** — cycle backward, wrapping at the start

Both fire the same path as a tab-header click, so the session-group main swap and xterm focus restore happen automatically. Useful for terminal-style shortcuts like `Cmd+Shift+→` / `Cmd+Shift+←`.

## Installation

### Via BRAT (recommended — auto-updates)

1. Install [BRAT](https://github.com/TfTHacker/obsidian42-brat) from Community Plugins.
2. In BRAT settings → **Add Beta plugin** → enter:

   ```
   coletaylor788/obsidian-claude-sidebar-ide
   ```

3. Enable **Claude Sidebar IDE** in Settings → Community Plugins.

### Manual

1. Download `main.js`, `manifest.json`, and `styles.css` from the [latest release](https://github.com/coletaylor788/obsidian-claude-sidebar-ide/releases/latest).
2. Create `.obsidian/plugins/claude-sidebar-ide/` inside your vault.
3. Drop the three files there.
4. Enable **Claude Sidebar IDE** in Settings → Community Plugins.

## Requirements

### Desktop (Local mode)

- macOS, Linux, or Windows
- Python 3
- At least one AI CLI installed: [Claude Code](https://claude.com/claude-code), Codex CLI, Gemini CLI, OpenCode, or Aider

Windows additionally needs [pywinpty](https://github.com/andfoy/pywinpty):

```bash
pip install pywinpty
```

Performance on Windows can be slower than macOS/Linux due to ConPTY overhead.

### Mobile (Sprites mode)

Run Claude Code on iOS or Android via [Sprites.dev](https://sprites.dev) cloud VMs:

1. Create an account at [sprites.dev](https://sprites.dev) and grab an API token.
2. In plugin settings, switch **Runtime Mode** to **Sprites.dev**.
3. Paste the token.
4. A cloud VM is provisioned automatically; your vault syncs up, changes sync back in real time.

No local CLI installation needed.

## Usage

- **Ribbon icon (bot)** — click to open or focus a Claude tab. Right-click for YOLO mode, folder targeting, or resume.
- **Folder context menu** — right-click any folder for "Open Claude here" or "Open Claude here (YOLO)".
- **Editor context menu** — right-click selected text for "Send selection to Claude".
- **Command palette** (`Cmd+P` / `Ctrl+P`):
  - Open Claude Code / New Claude Tab / Close Claude Tab
  - **Next Claude Session / Previous Claude Session** — cycle between Claude tabs (bind via Settings → Hotkeys for terminal-style `Cmd+Shift+→` / `Cmd+Shift+←`)
  - Toggle Focus: Editor ↔ Claude
  - Run Claude from this folder
  - Resume last conversation (`--continue`)
  - Send File Path to Claude / Send Selection to Claude
- **Shift+Enter** — multi-line input in the terminal.
- **Session groups** — each Claude tab is its own session. Open notes while one tab is focused; switch tabs to swap the editor over to a different session's notes. No commands or setup — just open tabs and switch.
- **Per-tab Claude conversations** — quit Obsidian and reopen; each tab resumes its own Claude conversation, not the most-recent one shared across all tabs.

## How It Works

### Terminal layer

The plugin embeds an [xterm.js](https://xtermjs.org/) terminal inside an Obsidian leaf and spawns the chosen AI CLI as a child process through a Python PTY bridge (`pty` on Unix, `pywinpty` on Windows). PTY helper scripts are base64-embedded into `main.js` at build time.

### IDE bridge (Claude Code)

When the active backend is Claude Code, a WebSocket MCP server starts on `127.0.0.1`:

1. Binds to a random port and generates an auth token.
2. Writes a lock file to `~/.claude/ide/<port>.lock` containing the port, token, and metadata.
3. Sets `CLAUDE_CODE_SSE_PORT` and `ENABLE_IDE_INTEGRATION=true` in the spawned shell environment.
4. Claude Code CLI scans `~/.claude/ide/`, picks up the lock, and connects over WebSocket.
5. The plugin pushes `selection_changed` notifications as you navigate; Claude pulls files/selection/diagnostics on demand and proposes edits via `openDiff`.

This is the same protocol the official VS Code extension and [`claudecode.nvim`](https://github.com/coder/claudecode.nvim) speak.

### Session groups

The plugin listens to Obsidian's `active-leaf-change` and `layout-change` events:

- When a Claude tab is focused (its `sessionId` differs from the current `activeSessionId`), the outgoing session's open files are captured to `pluginData.sessionGroups[outgoingId]`, and the incoming session's saved files are reopened in the main area via `app.workspace.openLinkText(path, '', 'tab')`. Existing leaves whose files aren't in the target list are detached.
- When a non-Claude leaf in the main area becomes active, a debounced (400 ms) snapshot captures the current main into the active session's group.
- When `layout-change` fires (splits, tab moves), the plugin walks Claude leaves to dedupe sessionIds — Obsidian's split duplicates a view's state including our id, so each split-cloned tab gets a fresh UUID and `activeSessionId` snaps to the new one.
- On plugin reload (Obsidian restart, BRAT update), `initSessionGroups` reads the persisted `activeSessionId` from `pluginData`, restores that session's main-area state explicitly, and only then unblocks the listener. Captures and swaps are gated behind a `sessionGroupsReady` flag so workspace-restore events can't corrupt saved groups.

### Claude conversation capture

For per-tab `claude --resume <id>` to work, the plugin needs to know each tab's specific Claude session id. Claude doesn't expose this through the CLI directly, so the plugin watches its on-disk artifact:

1. After a Claude tab spawns, the plugin computes `~/.claude/projects/<encoded-cwd>/` — `<encoded-cwd>` is `realpath(cwd)` with every `/` and `.` replaced by `-`. (`/Users/cotaylor/.claude` → `-Users-cotaylor--claude`; symlinked paths under OneDrive resolve to their real targets first.)
2. It snapshots the existing `.jsonl` files there as a "before" set, recording each filename (which IS the session id) and its mtime.
3. Every 2 seconds for up to 10 minutes, it rescans. A new file (or one that grew from empty) whose mtime is **after** this tab's spawn time AND that isn't already claimed by another live Claude tab becomes this tab's `claudeSessionId`.
4. The id is stored on the `TerminalView`; Obsidian persists it via the existing `getState()` plumbing.
5. On the next plugin reload, the shell command is built as `claude --resume <id>` instead of `claude --continue`.

If capture fails (no conversation in the 10-minute window, polling errored, etc.), the tab falls back to `--continue` behavior. New tabs that haven't yet had a conversation also use `--continue` for their first run.

## Development

```bash
bun install
bun run dev       # watch mode (esbuild --watch)
bun run build     # production build
bun run test      # bun test (pure helpers in src/*.test.ts)
bun run check     # typecheck → test → build
```

Tests live alongside the helpers they exercise: `src/session-groups.test.ts` (UUID/debounce/prune helpers) and `src/claude-session-capture.test.ts` (cwd encoding, project-dir listing, race-safe new-session detection).

CI runs `bun run check` on every tag push (`v*`); a successful run publishes `main.js`, `manifest.json`, and `styles.css` to a GitHub Release.

## License

MIT — see [LICENSE](LICENSE).

Copyright lineage:
- Original work © 2025 [Derek Larson](https://github.com/derek-larson14)
- IDE-fork additions © 2026 [Matthew Hall](https://github.com/MatthewHallCom)
- Session-groups additions © 2026 [Cole Taylor](https://github.com/coletaylor788)

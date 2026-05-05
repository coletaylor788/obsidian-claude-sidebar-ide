# Claude Sidebar IDE

Run Claude Code (and other AI coding CLIs) directly in your Obsidian sidebar — on desktop or mobile — with full IDE awareness of what you're editing **and** with each Claude session keeping its own group of open notes.

## Fork Lineage

Three generations, each adding one big capability on top of the previous:

| Generation | Repo | What it added |
|---|---|---|
| 1 — Original | [`derek-larson14/obsidian-claude-sidebar`](https://github.com/derek-larson14/obsidian-claude-sidebar) | Embedded an xterm.js terminal in the Obsidian sidebar so you could run Claude Code (and other AI CLIs) inside your vault. Manual "Send File / Send Selection" commands. Multi-backend (Claude Code, Codex, Gemini CLI, OpenCode, Aider). |
| 2 — IDE | [`MatthewHallCom/obsidian-claude-sidebar-ide`](https://github.com/MatthewHallCom/obsidian-claude-sidebar-ide) | Automatic **IDE integration** — runs a local WebSocket MCP server using the same lock-file discovery protocol Claude Code's VS Code/Neovim extensions use. Claude sees your current file, selection, and open editors live (debounced 150 ms). Side-by-side diff modal for accept/reject of proposed edits. Also: TypeScript rewrite of the original, Sprites cloud-VM mobile mode. |
| 3 — Sessions | **this fork** ([`coletaylor788/obsidian-claude-sidebar-ide`](https://github.com/coletaylor788/obsidian-claude-sidebar-ide)) | **Session-bound tab groups.** Each Claude session in the sidebar keeps its own set of open notes. Switching sessions swaps the main editor. |

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
- **Persistent** — `pluginData.sessionGroups` survives restarts; sessions whose Claude tabs are closed have their groups pruned
- **Tested** — pure helpers (`generateSessionId`, `pruneSessionGroups`, `debounce`) covered by `bun test`; `bun run check` runs typecheck → tests → build

Trade-off (worth knowing): splits and cursor positions inside the main editor area do not survive a session swap. Files reopen as plain tabs in arrival order. If you need split fidelity, a previous attempt used `getLayout`/`changeLayout` to preserve them but proved unreliable (partial restores due to leaf-id collisions); the current implementation captures only file paths because that approach has been stable.

See `src/session-groups.ts` for the pure helpers and the `// ─── Session Groups ───` block in `src/main.ts` for the wiring.

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
  - Toggle Focus: Editor ↔ Claude
  - Run Claude from this folder
  - Resume last conversation (`--continue`)
  - Send File Path to Claude / Send Selection to Claude
- **Shift+Enter** — multi-line input in the terminal.
- **Session groups** — each Claude tab is its own session. Open notes while one tab is focused; switch tabs to swap the editor over to a different session's notes. No commands or setup — just open tabs and switch.

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

## Development

```bash
bun install
bun run dev       # watch mode (esbuild --watch)
bun run build     # production build
bun run test      # bun test (pure helpers in src/session-groups.test.ts)
bun run check     # typecheck → test → build
```

CI runs `bun run check` on every tag push (`v*`); a successful run publishes `main.js`, `manifest.json`, and `styles.css` to a GitHub Release.

## License

MIT — see [LICENSE](LICENSE).

Copyright lineage:
- Original work © 2025 [Derek Larson](https://github.com/derek-larson14)
- IDE-fork additions © 2026 [Matthew Hall](https://github.com/MatthewHallCom)
- Session-groups additions © 2026 [Cole Taylor](https://github.com/coletaylor788)

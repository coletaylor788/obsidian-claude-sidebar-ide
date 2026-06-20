import type { Backend } from "./types";

/** Read Claude's per-conversation /rename title from disk. Lazy-requires the
 *  fs-backed helper so this stays safe to call on mobile (require throws there
 *  and we return null). */
function readClaudeTitle(agentSessionId: string, cwd: string): string | null {
  try {
    const cap = require("./claude-session-capture");
    const projectDir = cap.projectDirForCwd(cwd);
    return cap.readClaudeSessionTitle(`${projectDir}/${agentSessionId}.jsonl`);
  } catch {
    return null;
  }
}

export const CLI_BACKENDS: Record<string, Backend> = {
  claude: {
    label: "Claude Code",
    binary: "claude",
    pathHints: ["~/.local/bin"],
    yoloFlag: "--dangerously-skip-permissions",
    resumeFlag: "--continue",
    resumeIsSubcommand: false,
    resumeByIdFlag: "--resume",
    supportsIde: true,
    ideFlag: "--ide",
    sessionMode: "capture",
    preTrustCommand: (cwd) =>
      `claude config set -g trustedDirectories '${cwd}' 2>/dev/null; `,
    installsHooks: true,
    readSessionTitle: readClaudeTitle,
  },
  codex: {
    label: "Codex",
    binary: "codex",
    pathHints: [],
    yoloFlag: "--yolo",
    resumeFlag: "resume --last",
    resumeIsSubcommand: true,
    supportsIde: false,
    sessionMode: "none",
  },
  opencode: {
    label: "OpenCode",
    binary: "opencode",
    pathHints: ["/opt/homebrew/bin"],
    yoloFlag: null,
    resumeFlag: "--continue",
    resumeIsSubcommand: false,
    supportsIde: false,
    sessionMode: "none",
  },
  gemini: {
    label: "Gemini CLI",
    binary: "gemini",
    pathHints: [],
    yoloFlag: "--approval-mode=yolo",
    resumeFlag: "--resume",
    resumeIsSubcommand: false,
    supportsIde: false,
    sessionMode: "none",
  },
};

export type BackendKey = keyof typeof CLI_BACKENDS;

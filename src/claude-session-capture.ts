// Pure helpers for capturing Claude's per-conversation session id from disk.
//
// Claude stores each conversation as a JSONL file at:
//   ~/.claude/projects/<encoded-cwd>/<session-id>.jsonl
//
// On a fresh `claude` invocation, the file appears once the user sends the
// first message. We watch the projects dir for a new file whose mtime is
// after spawn time AND that contains at least one assistant turn, then
// extract the session id from its filename.
//
// Kept free of Obsidian API imports so the logic is unit-testable with bun test.

import * as fs from "fs";
import * as path from "path";

export interface ClaudeProjectFile {
  /** Absolute path to the .jsonl. */
  fullPath: string;
  /** Filename without extension — this IS the claude session id. */
  sessionId: string;
  /** mtime in ms since epoch. */
  mtimeMs: number;
  /** Number of bytes — used as a cheap "has content" proxy. */
  size: number;
}

/**
 * Replicate Claude's cwd-to-projects-dir encoding. Claude replaces every
 * non-alphanumeric character with `-`, then truncates to 200 chars and
 * appends a hash suffix if the result is longer.
 *
 *   /Users/cotaylor/git/AgentInbox      →  -Users-cotaylor-git-AgentInbox
 *   /Users/cotaylor/.claude             →  -Users-cotaylor--claude
 *   /Users/cole/git/puddles/docs/~/git  →  -Users-cole-git-puddles-docs---git
 *
 * NOTE: This function does NOT resolve symlinks — call realpath first if the
 * cwd may include symlinked path segments (Claude itself resolves real paths
 * before encoding, so the resulting dir would otherwise mismatch).
 */
const MAX_PROJECT_DIR_LEN = 200;

function projectDirHashSuffix(s: string): string {
  // djb2-style 32-bit hash, base36 — matches Claude's `rEH` impl.
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  }
  return Math.abs(h).toString(36);
}

export function encodeCwdForClaudeProjectDir(cwd: string): string {
  const normalized = cwd.replace(/\/+/g, "/").replace(/\/$/, "");
  const encoded = normalized.replace(/[^a-zA-Z0-9]/g, "-");
  if (encoded.length <= MAX_PROJECT_DIR_LEN) return encoded;
  return `${encoded.slice(0, MAX_PROJECT_DIR_LEN)}-${projectDirHashSuffix(normalized)}`;
}

/**
 * Resolve symlinks to the real path and NFC-normalize. Returns the input
 * (NFC-normalized) on failure. Matches Claude's pre-encoding step so the
 * produced dir name lines up with what Claude creates.
 */
export function resolveRealPath(cwd: string): string {
  try {
    return fs.realpathSync(cwd).normalize("NFC");
  } catch {
    return cwd.normalize("NFC");
  }
}

/**
 * Compute the absolute path to Claude's project dir for a given cwd.
 * Resolves symlinks AND applies the encoding.
 */
export function projectDirForCwd(cwd: string): string {
  const home = process.env.HOME || "";
  const real = resolveRealPath(cwd);
  return path.join(home, ".claude", "projects", encodeCwdForClaudeProjectDir(real));
}

/** Resolve `~` and absolute paths to a real fs path. */
export function expandHome(p: string): string {
  if (p.startsWith("~/") || p === "~") {
    const home = process.env.HOME || "";
    return p.replace(/^~/, home);
  }
  return p;
}

/**
 * List .jsonl files in the given Claude project dir. Returns an empty array
 * if the dir doesn't exist (e.g. claude has never been run from this cwd).
 */
export function listClaudeSessions(projectDir: string): ClaudeProjectFile[] {
  const out: ClaudeProjectFile[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(projectDir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
    const full = path.join(projectDir, entry.name);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(full);
    } catch {
      continue;
    }
    out.push({
      fullPath: full,
      sessionId: entry.name.replace(/\.jsonl$/, ""),
      mtimeMs: stat.mtimeMs,
      size: stat.size,
    });
  }
  return out;
}

/**
 * Read the latest custom title from a Claude session .jsonl. Each `/rename`
 * inside Claude appends a line of the form
 *   {"type": "custom-title", "customTitle": "<name>", "sessionId": "..."}
 * (and a paired "agent-name" line). The most-recent such line with a string
 * `customTitle` is the current title. Returns null if no title has been set
 * (file missing, no rename ever performed, or only the empty placeholder
 * `custom-title` lines that Claude writes at session start).
 */
export function readClaudeSessionTitle(filePath: string): string | null {
  let content: string;
  try {
    content = fs.readFileSync(filePath, "utf-8");
  } catch {
    return null;
  }
  let title: string | null = null;
  for (const line of content.split("\n")) {
    if (!line.includes('"customTitle"')) continue;
    try {
      const obj = JSON.parse(line) as { type?: string; customTitle?: unknown };
      if (obj.type === "custom-title" && typeof obj.customTitle === "string" && obj.customTitle.length > 0) {
        title = obj.customTitle;
      }
    } catch {
      // ignore malformed lines
    }
  }
  return title;
}

/**
 * Find the Claude session that this tab just spawned. Compares the current
 * directory listing against a snapshot taken before spawn; returns the newly-
 * created file (or modified — covers the case where claude reuses an empty
 * file slot, though that's rare).
 *
 * Returns null if no new/grown file is found.
 */
export function findNewClaudeSession(
  beforeSnapshot: ClaudeProjectFile[],
  current: ClaudeProjectFile[],
  minSize = 1,
  afterMtimeMs?: number,
  excludeIds?: ReadonlySet<string>,
): ClaudeProjectFile | null {
  const beforeBySessionId = new Map(
    beforeSnapshot.map((f) => [f.sessionId, f]),
  );
  // Newest first; filter by mtime threshold and cross-tab exclusions.
  const candidates = current
    .filter((f) => f.size >= minSize)
    .filter((f) => afterMtimeMs === undefined || f.mtimeMs >= afterMtimeMs)
    .filter((f) => !excludeIds || !excludeIds.has(f.sessionId))
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
  for (const c of candidates) {
    const prior = beforeBySessionId.get(c.sessionId);
    if (!prior) return c; // brand-new file
    if (c.size > prior.size) return c; // existed but grew (claude may pre-create)
  }
  return null;
}

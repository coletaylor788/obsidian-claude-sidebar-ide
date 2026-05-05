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
 * Replicate Claude's cwd-to-projects-dir encoding. Observed convention:
 *   /Users/cotaylor/git/AgentInbox  →  -Users-cotaylor-git-AgentInbox
 *   /Users/cotaylor/.claude         →  -Users-cotaylor--claude   (dots also map to `-`)
 * Replace every `/` and every `.` with `-`. A leading slash naturally
 * produces a leading dash.
 *
 * NOTE: This function does NOT resolve symlinks — call realpath first if the
 * cwd may include symlinked path segments (Claude itself resolves real paths
 * before encoding, so the resulting dir would otherwise mismatch).
 */
export function encodeCwdForClaudeProjectDir(cwd: string): string {
  const normalized = cwd.replace(/\/+/g, "/").replace(/\/$/, "");
  return normalized.replace(/[/.]/g, "-");
}

/**
 * Resolve symlinks to the real path. Returns the input unchanged on failure.
 * Used before encoding so the produced dir name matches what Claude creates.
 */
export function resolveRealPath(cwd: string): string {
  try {
    return fs.realpathSync(cwd);
  } catch {
    return cwd;
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
): ClaudeProjectFile | null {
  const beforeBySessionId = new Map(
    beforeSnapshot.map((f) => [f.sessionId, f]),
  );
  // Newest first.
  const candidates = current
    .filter((f) => f.size >= minSize)
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
  for (const c of candidates) {
    const prior = beforeBySessionId.get(c.sessionId);
    if (!prior) return c; // brand-new file
    if (c.size > prior.size) return c; // existed but grew (claude may pre-create)
  }
  return null;
}

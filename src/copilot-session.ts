// Pure + fs helpers for Copilot's per-conversation session metadata.
//
// Unlike Claude (which assigns the conversation id and writes a JSONL we have
// to scrape), the plugin MINTS the id and passes it via `copilot --session-id`.
// Copilot then stores session metadata at:
//   ~/.copilot/session-state/<session-id>/workspace.yaml
// whose `name:` field is the human title (auto-summarised, or set by /rename).
//
// The parsing helper is kept Obsidian-free so it can be unit-tested with bun.

import * as fs from "fs";
import * as path from "path";
import * as os from "os";

/** Absolute path to a Copilot session's state dir (~/.copilot/session-state/<id>). */
export function copilotSessionStateDir(sessionId: string): string {
  return path.join(os.homedir(), ".copilot", "session-state", sessionId);
}

/**
 * Extract the `name:` value from a Copilot `workspace.yaml`. Minimal line-based
 * parse (no YAML dependency) — the file is flat key/value. Returns null when the
 * key is absent or its value is empty.
 */
export function parseWorkspaceName(yaml: string): string | null {
  for (const line of yaml.split("\n")) {
    const m = /^name:[ \t]*(.*)$/.exec(line);
    if (!m) continue;
    const value = unquoteYamlScalar(m[1]);
    return value.length > 0 ? value : null;
  }
  return null;
}

/** Unwrap a YAML single/double-quoted scalar, handling the standard escapes. */
function unquoteYamlScalar(raw: string): string {
  const s = raw.trim();
  if (s.length >= 2 && s.startsWith("'") && s.endsWith("'")) {
    return s.slice(1, -1).replace(/''/g, "'");
  }
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) {
    return s.slice(1, -1).replace(/\\"/g, '"');
  }
  return s;
}

/**
 * Read the human title (`name`) for a Copilot session. Mobile-safe: returns
 * null if fs is unavailable or the file doesn't exist. The `cwd` argument is
 * unused — Copilot's session-state is keyed by id globally — but is kept to
 * satisfy the Backend.readSessionTitle signature.
 */
export function readCopilotSessionTitle(sessionId: string, _cwd: string): string | null {
  try {
    const file = path.join(copilotSessionStateDir(sessionId), "workspace.yaml");
    return parseWorkspaceName(fs.readFileSync(file, "utf-8"));
  } catch {
    return null;
  }
}

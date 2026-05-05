// Pure helpers for the session-groups feature.
// Kept free of Obsidian API imports so they can be unit-tested with `bun test`.
//
// Concept: each Claude sidebar tab ("session") is identified by a stable UUID.
// Notes opened in the main editor area auto-join that session's "group".
// Switching the focused Claude tab swaps the main-area layout to the new
// session's group while leaving the sidebars (and the Claude tabs themselves)
// untouched.

export interface SessionGroup {
  /** Vault-relative file paths in the order they appear in the main area. */
  files: string[];
  /** The path of the file that should be focused after restore (or null). */
  activeFile: string | null;
  lastUpdated: number;
}

export type SessionGroups = Record<string, SessionGroup>;

/** Generate a stable session id. Uses crypto.randomUUID(); falls back if unavailable. */
export function generateSessionId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (c?.randomUUID) return c.randomUUID();
  // Fallback: timestamp + random suffix. Not cryptographically strong but unique enough.
  return `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Drop session groups whose session no longer exists.
 * Returns a new object — does not mutate input.
 */
export function pruneSessionGroups(
  groups: SessionGroups | undefined,
  validIds: Iterable<string>,
): SessionGroups {
  if (!groups) return {};
  const valid = new Set(validIds);
  const out: SessionGroups = {};
  for (const [id, g] of Object.entries(groups)) {
    if (valid.has(id)) out[id] = g;
  }
  return out;
}

/** Trailing-edge debounce. */
export function debounce<A extends unknown[]>(
  fn: (...args: A) => void,
  ms: number,
): { (...args: A): void; cancel: () => void } {
  let t: ReturnType<typeof setTimeout> | null = null;
  const wrapped = (...args: A): void => {
    if (t !== null) clearTimeout(t);
    t = setTimeout(() => {
      t = null;
      fn(...args);
    }, ms);
  };
  wrapped.cancel = (): void => {
    if (t !== null) {
      clearTimeout(t);
      t = null;
    }
  };
  return wrapped;
}

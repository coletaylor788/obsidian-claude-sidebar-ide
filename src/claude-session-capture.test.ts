import { describe, expect, test } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  encodeCwdForClaudeProjectDir,
  expandHome,
  findNewClaudeSession,
  listClaudeSessions,
  type ClaudeProjectFile,
} from "./claude-session-capture";

describe("encodeCwdForClaudeProjectDir", () => {
  test("converts slashes to dashes, leading slash → leading dash", () => {
    expect(encodeCwdForClaudeProjectDir("/Users/cotaylor/git/AgentInbox"))
      .toBe("-Users-cotaylor-git-AgentInbox");
  });
  test("normalizes trailing slash and double slashes", () => {
    expect(encodeCwdForClaudeProjectDir("/Users/cole/")).toBe("-Users-cole");
    expect(encodeCwdForClaudeProjectDir("/Users//cole")).toBe("-Users-cole");
  });
  test("dots in path segments also encode to dashes (matches claude's actual layout)", () => {
    // /Users/cotaylor/.claude → -Users-cotaylor--claude (slash before .claude
    // becomes dash, and the dot itself becomes another dash → double dash)
    expect(encodeCwdForClaudeProjectDir("/Users/cotaylor/.claude"))
      .toBe("-Users-cotaylor--claude");
  });
  test("paths with dashes are preserved", () => {
    expect(encodeCwdForClaudeProjectDir("/Users/cotaylor/Library/CloudStorage/OneDrive-Microsoft/claude/context"))
      .toBe("-Users-cotaylor-Library-CloudStorage-OneDrive-Microsoft-claude-context");
  });
});

describe("expandHome", () => {
  test("replaces leading ~ with $HOME", () => {
    process.env.HOME = "/Users/test";
    expect(expandHome("~/foo")).toBe("/Users/test/foo");
    expect(expandHome("~")).toBe("/Users/test");
  });
  test("leaves non-tilde paths untouched", () => {
    expect(expandHome("/abs/path")).toBe("/abs/path");
    expect(expandHome("relative/path")).toBe("relative/path");
  });
});

describe("listClaudeSessions", () => {
  test("returns [] for a missing dir", () => {
    expect(listClaudeSessions("/no/such/dir")).toEqual([]);
  });

  test("lists .jsonl files with their sessionId, mtime, and size", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "claude-cap-"));
    try {
      const f1 = path.join(tmp, "abc-123.jsonl");
      const f2 = path.join(tmp, "def-456.jsonl");
      fs.writeFileSync(f1, "hello");
      fs.writeFileSync(f2, "world!!!!!!");
      // Non-jsonl should be skipped.
      fs.writeFileSync(path.join(tmp, "ignore.txt"), "x");
      const out = listClaudeSessions(tmp);
      const ids = out.map((f) => f.sessionId).sort();
      expect(ids).toEqual(["abc-123", "def-456"]);
      const byId = new Map(out.map((f) => [f.sessionId, f]));
      expect(byId.get("abc-123")?.size).toBe(5);
      expect(byId.get("def-456")?.size).toBe(11);
      expect(byId.get("abc-123")?.fullPath).toBe(f1);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("findNewClaudeSession", () => {
  const f = (sessionId: string, mtimeMs: number, size: number): ClaudeProjectFile => ({
    fullPath: `/x/${sessionId}.jsonl`,
    sessionId,
    mtimeMs,
    size,
  });

  test("returns the brand-new file not in the before-snapshot", () => {
    const before = [f("old-1", 100, 50), f("old-2", 200, 50)];
    const current = [f("old-1", 100, 50), f("old-2", 200, 50), f("new-1", 300, 10)];
    expect(findNewClaudeSession(before, current)?.sessionId).toBe("new-1");
  });

  test("returns the file that grew (existed pre-spawn but was empty)", () => {
    const before = [f("placeholder", 100, 0)];
    const current = [f("placeholder", 200, 100)];
    expect(findNewClaudeSession(before, current)?.sessionId).toBe("placeholder");
  });

  test("returns null when nothing new and nothing grew", () => {
    const before = [f("a", 100, 50)];
    const current = [f("a", 100, 50)];
    expect(findNewClaudeSession(before, current)).toBeNull();
  });

  test("ignores files below minSize threshold", () => {
    const before: ClaudeProjectFile[] = [];
    const current = [f("empty", 100, 0)];
    expect(findNewClaudeSession(before, current, 1)).toBeNull();
  });

  test("returns the newest when multiple new files appear", () => {
    const before: ClaudeProjectFile[] = [];
    const current = [f("older", 100, 50), f("newest", 300, 50), f("middle", 200, 50)];
    expect(findNewClaudeSession(before, current)?.sessionId).toBe("newest");
  });
});

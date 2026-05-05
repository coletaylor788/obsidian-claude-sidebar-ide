import { describe, expect, test } from "bun:test";
import {
  debounce,
  generateSessionId,
  pruneSessionGroups,
} from "./session-groups";

describe("generateSessionId", () => {
  test("returns a non-empty string", () => {
    const id = generateSessionId();
    expect(typeof id).toBe("string");
    expect(id.length).toBeGreaterThan(0);
  });

  test("generates unique ids on repeat calls", () => {
    const ids = new Set(Array.from({ length: 50 }, () => generateSessionId()));
    expect(ids.size).toBe(50);
  });
});

describe("pruneSessionGroups", () => {
  const stamp = (n: number) => ({ files: [], activeFile: null, lastUpdated: n });

  test("keeps groups whose ids are still valid", () => {
    const before = { a: stamp(1), b: stamp(2), c: stamp(3) };
    const after = pruneSessionGroups(before, ["a", "c"]);
    expect(Object.keys(after).sort()).toEqual(["a", "c"]);
    expect(after.a).toEqual(before.a);
    expect(after.c).toEqual(before.c);
  });

  test("returns {} when input is undefined", () => {
    expect(pruneSessionGroups(undefined, ["a"])).toEqual({});
  });

  test("returns a new object — does not mutate input", () => {
    const before = { a: stamp(1), b: stamp(2) };
    const after = pruneSessionGroups(before, ["a"]);
    expect(after).not.toBe(before);
    expect(before.b).toBeDefined(); // still present in original
  });
});

describe("debounce", () => {
  test("only fires once for rapid calls within the window", async () => {
    let calls = 0;
    const d = debounce(() => calls++, 30);
    d();
    d();
    d();
    expect(calls).toBe(0);
    await new Promise((r) => setTimeout(r, 60));
    expect(calls).toBe(1);
  });

  test("passes the latest arguments", async () => {
    const seen: number[] = [];
    const d = debounce((n: number) => seen.push(n), 20);
    d(1);
    d(2);
    d(3);
    await new Promise((r) => setTimeout(r, 50));
    expect(seen).toEqual([3]);
  });

  test("cancel() prevents the pending call", async () => {
    let calls = 0;
    const d = debounce(() => calls++, 20);
    d();
    d.cancel();
    await new Promise((r) => setTimeout(r, 50));
    expect(calls).toBe(0);
  });
});

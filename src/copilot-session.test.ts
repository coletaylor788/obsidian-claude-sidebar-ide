import { describe, expect, test } from "bun:test";
import { parseWorkspaceName } from "./copilot-session";

describe("parseWorkspaceName", () => {
  test("reads an unquoted name", () => {
    expect(parseWorkspaceName("id: x\nname: My Session\nuser_named: false\n")).toBe(
      "My Session",
    );
  });

  test("reads a single-quoted name containing a colon", () => {
    expect(parseWorkspaceName("name: 'Reply with exactly: OK'\n")).toBe(
      "Reply with exactly: OK",
    );
  });

  test("unescapes doubled single quotes", () => {
    expect(parseWorkspaceName("name: 'it''s fine'\n")).toBe("it's fine");
  });

  test("reads a double-quoted name", () => {
    expect(parseWorkspaceName('name: "Quoted Title"\n')).toBe("Quoted Title");
  });

  test("returns null when the name key is absent", () => {
    expect(parseWorkspaceName("id: x\ncwd: /tmp\n")).toBeNull();
  });

  test("returns null when the name value is empty", () => {
    expect(parseWorkspaceName("name: \nuser_named: false\n")).toBeNull();
  });

  test("returns the first name line and ignores later keys", () => {
    expect(parseWorkspaceName("name: First\nsummary: not a name\n")).toBe("First");
  });
});

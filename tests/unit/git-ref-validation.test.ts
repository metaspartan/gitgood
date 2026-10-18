import { describe, expect, test } from "bun:test";
import { GIT_REF_PATTERN, GIT_REV_PATTERN, SHA_PATTERN } from "../../src/lib/ids.ts";

describe("revision expressions", () => {
  const ACCEPT = [
    "HEAD",
    "HEAD~3",
    "HEAD^",
    "HEAD@{1}",
    "main",
    "main..other",
    "v1.2.3",
    "release-2024.09",
    "feature/nested-branch",
    "user.name/branch_name",
    "a",
    "0".repeat(40),
  ];

  const REJECT: ReadonlyArray<readonly [string, string]> = [
    ["--output=/tmp/pwned", "an option that writes a file"],
    ["--exec=sh", "an option that runs a command"],
    ["-main", "a leading dash"],
    ["-p", "a short option"],
    ["--all", "a valid option spelled entirely from legal characters"],
    ["main branch", "an embedded space"],
    ["main\n--output=/x", "an injected newline"],
    ["m\x00ain", "an embedded NUL"],
    ["tab\there", "an embedded tab"],
    ["", "empty"],
  ];

  test("accepts git revision syntax", () => {
    for (const value of ACCEPT) {
      expect({ value, ok: GIT_REV_PATTERN.test(value) }).toEqual({ value, ok: true });
    }
  });

  test("rejects anything git could read as an option or split out of argv", () => {
    for (const [value, why] of REJECT) {
      expect({ value, why, ok: GIT_REV_PATTERN.test(value) }).toEqual({ value, why, ok: false });
    }
  });

  test("a revision cannot begin with a dash, which is the exact exploit", () => {
    expect(GIT_REV_PATTERN.test("--output=/tmp/pwned")).toBe(false);
    expect(GIT_REV_PATTERN.test("-main")).toBe(false);
    expect(GIT_REV_PATTERN.test("main-output")).toBe(true);
  });
});

describe("ref names", () => {
  test("accepts ordinary branch and tag names", () => {
    for (const value of ["main", "feature/x", "v1.2.3", "release-2024.09"]) {
      expect(GIT_REF_PATTERN.test(value)).toBe(true);
    }
  });

  test("is stricter than the revision rule, as git is", () => {
    for (const value of ["HEAD~3", "main..other", "HEAD@{1}", ".hidden", "../etc/passwd"]) {
      expect({ value, ok: GIT_REF_PATTERN.test(value) }).toEqual({ value, ok: false });
    }
  });

  test("still refuses a leading dash", () => {
    expect(GIT_REF_PATTERN.test("-main")).toBe(false);
    expect(GIT_REF_PATTERN.test("--all")).toBe(false);
  });
});

describe("shas", () => {
  test("admits hex only", () => {
    expect(SHA_PATTERN.test("a".repeat(40))).toBe(true);
    expect(SHA_PATTERN.test("abc1234")).toBe(true);
    expect(SHA_PATTERN.test("--output=/tmp/x")).toBe(false);
    expect(SHA_PATTERN.test("a".repeat(65))).toBe(false);
    expect(SHA_PATTERN.test("ABCDEF123")).toBe(false);
    expect(SHA_PATTERN.test("abc123g")).toBe(false);
  });
});

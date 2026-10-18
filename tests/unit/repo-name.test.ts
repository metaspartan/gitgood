import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  MAX_NAME_LENGTH,
  REPO_NAME,
  RESERVED_NAMES,
  repoNameProblem,
  repoPathPreview,
} from "../../src/web/repo-name.ts";

describe("repository name rules", () => {
  test("the client pattern is identical to the server's", () => {
    const server = readFileSync(new URL("../../src/lib/ids.ts", import.meta.url), "utf8");
    const match = /export const REPO_NAME_PATTERN = (\/[^\n]*?\/[gimsuy]*);/.exec(server);
    expect(match).not.toBeNull();
    expect(match?.[1]).toBe(REPO_NAME.toString());
  });

  test("the length limit matches the pattern's", () => {
    expect(REPO_NAME.source).toContain(`{1,${MAX_NAME_LENGTH}}`);
  });

  test("ordinary names are accepted", () => {
    for (const name of ["my-project", "web.app", "under_score", "MixedCase", "a", "12345"]) {
      expect(repoNameProblem(name)).toBeNull();
    }
  });

  test("an empty name is not yet an error", () => {
    expect(repoNameProblem("")).toBeNull();
    expect(repoNameProblem("   ")).toBeNull();
  });

  test("characters the server refuses are refused here too", () => {
    for (const name of ["has space", "slash/name", "colon:name", "em—dash", "café", "plus+sign"]) {
      expect(repoNameProblem(name)).not.toBeNull();
    }
  });

  test("path traversal is refused with its own message", () => {
    expect(repoNameProblem(".")).toContain("reserved");
    expect(repoNameProblem("..")).toContain("reserved");
  });

  test("route prefixes are refused, case-insensitively", () => {
    expect(repoNameProblem("api")).toContain("reserved");
    expect(repoNameProblem("API")).toContain("reserved");
    expect(repoNameProblem("settings")).toContain("reserved");
    for (const name of RESERVED_NAMES) {
      expect(repoNameProblem(name)).not.toBeNull();
    }
  });

  test("an over-long name is refused before the pattern is consulted", () => {
    const long = "a".repeat(MAX_NAME_LENGTH + 1);
    expect(repoNameProblem(long)).toContain("at most");
  });

  test("surrounding whitespace is trimmed rather than rejected", () => {
    expect(repoNameProblem("  my-project  ")).toBeNull();
  });

  test("the path preview degrades gracefully", () => {
    expect(repoPathPreview("alice", "site")).toBe("alice/site");
    expect(repoPathPreview("alice", "")).toBe("alice/my-project");
    expect(repoPathPreview("", "site")).toBe("you/site");
  });
});

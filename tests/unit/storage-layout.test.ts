import { describe, expect, test } from "bun:test";
import { hashedRepositoryPath, repositoryPath } from "../../src/git/repo.ts";
import { repoDiskPath, type RepoRecord } from "../../src/data/repos.ts";

describe("repository storage layout", () => {
  test("different owners land in different fan-out directories", () => {
    const paths = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const path = hashedRepositoryPath(`owner${i}`, "repo");
      paths.add(path.replace(/^.*repositories[\\/]/, "").split(/[\\/]/).slice(0, 2).join("/"));
    }
    expect(paths.size).toBeGreaterThan(20);
  });

  test("the same repository always resolves to the same path", () => {
    const a = hashedRepositoryPath("Alice", "project");
    const b = hashedRepositoryPath("alice", "PROJECT");
    expect(a).toBe(b);
  });

  test("the path is independent of the owner's name", () => {
    const before = hashedRepositoryPath("alice", "project");
    const after = hashedRepositoryPath("alice-renamed", "project");
    expect(before).not.toBe(after);

    expect(repositoryPath("alice", "project")).not.toBe(repositoryPath("alice-renamed", "project"));
  });

  test("a legacy repository keeps resolving through the derived path", () => {
    const legacy = { owner_username: "alice", name: "old", disk_path: null } as unknown as RepoRecord;
    expect(repoDiskPath(legacy)).toBe(repositoryPath("alice", "old"));

    const hashed = {
      owner_username: "alice",
      name: "old",
      disk_path: "/srv/data/repositories/ab/cd/abcd.git",
    } as unknown as RepoRecord;
    expect(repoDiskPath(hashed)).toBe("/srv/data/repositories/ab/cd/abcd.git");
  });
});

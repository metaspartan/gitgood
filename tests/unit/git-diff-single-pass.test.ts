import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const dataDir = mkdtempSync(join(tmpdir(), "gg-diffparse-"));
process.env.GITGOOD_DATA_DIR = dataDir;
process.env.GITGOOD_REPO_ROOT = join(dataDir, "repos");
process.env.GITGOOD_LFS_ROOT = join(dataDir, "lfs");
const { changesBetween, initBareRepository } = await import("../../src/git/repo.ts");

function git(cwd: string, args: string[]): void {
  const result = spawnSync("git", args, { cwd, stdio: "pipe", encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr || result.stdout}`);
}

test("one diff pass reports every change shape git can emit", async () => {
  const dir = mkdtempSync(join(tmpdir(), "gg-diffshape-"));
  const work = join(dir, "work");
  const bare = join(dir, "bare");
  mkdirSync(work, { recursive: true });
  git(dir, ["init", "-q", "-b", "main", work]);
  git(work, ["config", "user.email", "t@example.test"]);
  git(work, ["config", "user.name", "T"]);

  writeFileSync(join(work, "modified.txt"), "one\ntwo\n");
  writeFileSync(join(work, "deleted.txt"), "gone\n");
  writeFileSync(join(work, "to-rename.txt"), "renamed content that stays similar enough\n");
  writeFileSync(join(work, "binary.bin"), Buffer.from([0, 1, 2, 3, 0, 9]));
  mkdirSync(join(work, "dir"), { recursive: true });
  writeFileSync(join(work, "dir", "nested.txt"), "nested\n");
  git(work, ["add", "-A"]);
  git(work, ["commit", "-q", "-m", "base"]);

  git(work, ["checkout", "-q", "-b", "feature"]);
  writeFileSync(join(work, "modified.txt"), "one\ntwo\nthree\n");
  writeFileSync(join(work, "added.txt"), "brand new\n");
  git(work, ["rm", "-q", "deleted.txt"]);
  git(work, ["mv", "to-rename.txt", "renamed.txt"]);
  writeFileSync(join(work, "binary.bin"), Buffer.from([0, 1, 2, 3, 0, 8]));
  git(work, ["add", "-A"]);
  git(work, ["commit", "-q", "-m", "change"]);

  await initBareRepository(bare, "main");
  git(bare, ["fetch", "-q", work, "main:refs/heads/main", "feature:refs/heads/feature"]);

  const changes = await changesBetween(bare, "refs/heads/main", "refs/heads/feature");
  const byPath = new Map(changes.map((change) => [change.path, change]));

  expect(byPath.get("modified.txt")).toEqual({
    path: "modified.txt", additions: 1, deletions: 0, binary: false, status: "modified",
  });
  expect(byPath.get("added.txt")).toEqual({
    path: "added.txt", additions: 1, deletions: 0, binary: false, status: "added",
  });
  expect(byPath.get("deleted.txt")).toEqual({
    path: "deleted.txt", additions: 0, deletions: 1, binary: false, status: "deleted",
  });
  expect(byPath.get("renamed.txt")).toEqual({
    path: "renamed.txt", additions: 0, deletions: 0, binary: false, status: "renamed",
  });
  expect(byPath.has("to-rename.txt")).toBe(false);
  expect(byPath.get("binary.bin")).toEqual({
    path: "binary.bin", additions: 0, deletions: 0, binary: true, status: "modified",
  });
  expect(changes.every((change) =>
    change.status === "added" || change.status === "modified" ||
    change.status === "deleted" || change.status === "renamed")).toBe(true);
  expect(changes).toHaveLength(5);

  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
}, 60_000);

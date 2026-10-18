import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const dataDir = mkdtempSync(join(tmpdir(), "gg-branches-"));
process.env.GITGOOD_DATA_DIR = dataDir;
process.env.GITGOOD_REPO_ROOT = join(dataDir, "repos");
process.env.GITGOOD_LFS_ROOT = join(dataDir, "lfs");
const { initBareRepository, refsAt, listBranches, headBranch } = await import("../../src/git/repo.ts");

function git(cwd: string, args: string[]): void {
  const result = spawnSync("git", args, { cwd, stdio: "pipe", encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr || result.stdout}`);
}

function seed(): { bare: string; work: string } {
  const base = mkdtempSync(join(tmpdir(), "gg-branchwork-"));
  const work = join(base, "work");
  const bare = join(base, "bare");
  mkdirSync(work, { recursive: true });
  git(base, ["init", "-q", "-b", "main", work]);
  git(work, ["config", "user.email", "t@example.test"]);
  git(work, ["config", "user.name", "T"]);
  writeFileSync(join(work, "a.txt"), "one\n");
  git(work, ["add", "-A"]);
  git(work, ["commit", "-q", "-m", "base"]);
  git(work, ["branch", "feature-a"]);
  git(work, ["branch", "feature-b"]);
  return { bare, work };
}

test("one pass reports every branch and which one is checked out", async () => {
  const { bare, work } = seed();
  await initBareRepository(bare, "main");
  git(bare, ["fetch", "-q", work, "main:refs/heads/main", "feature-a:refs/heads/feature-a", "feature-b:refs/heads/feature-b"]);

  const { branches, head } = await refsAt(bare);
  expect(branches.map((branch) => branch.name).sort()).toEqual(["feature-a", "feature-b", "main"]);
  expect(head).toBe("main");
  expect(head).toBe(await headBranch(bare));
  expect((await listBranches(bare)).map((branch) => branch.name).sort()).toEqual(
    branches.map((branch) => branch.name).sort(),
  );
  expect(branches.every((branch) => /^[0-9a-f]{40}$/.test(branch.sha))).toBe(true);
  expect(branches.every((branch) => branch.updatedAt > 0)).toBe(true);

  rmSync(join(bare, ".."), { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
}, 60_000);

test("a detached HEAD falls back rather than reporting no branch", async () => {
  const { bare, work } = seed();
  await initBareRepository(bare, "main");
  git(bare, ["fetch", "-q", work, "main:refs/heads/main"]);
  const sha = spawnSync("git", ["rev-parse", "main"], { cwd: bare, stdio: "pipe", encoding: "utf8" }).stdout.trim();
  git(bare, ["update-ref", "--no-deref", "HEAD", sha]);
  expect(spawnSync("git", ["symbolic-ref", "HEAD"], { cwd: bare, stdio: "pipe", encoding: "utf8" }).status).not.toBe(0);

  const { branches, head } = await refsAt(bare);
  expect(branches).toHaveLength(1);
  expect(head).toBe(await headBranch(bare));

  rmSync(join(bare, ".."), { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
}, 60_000);

test("a repository with no branches still answers", async () => {
  const base = mkdtempSync(join(tmpdir(), "gg-empty-"));
  const bare = join(base, "bare");
  await initBareRepository(bare, "main");
  const { branches, head } = await refsAt(bare);
  expect(branches).toEqual([]);
  expect(head).toBe(await headBranch(bare));

  rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
}, 60_000);

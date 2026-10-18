import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const dataDir = mkdtempSync(join(tmpdir(), "gg-refs-"));
process.env.GITGOOD_DATA_DIR = dataDir;
process.env.GITGOOD_REPO_ROOT = join(dataDir, "repos");
process.env.GITGOOD_LFS_ROOT = join(dataDir, "lfs");
const { initBareRepository, refsAt, listBranches, listTags, headBranch } = await import(
  "../../src/git/repo.ts"
);

function git(cwd: string, args: string[]): void {
  const result = spawnSync("git", args, { cwd, stdio: "pipe", encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr || result.stdout}`);
}

async function seed(): Promise<{ bare: string; base: string; work: string }> {
  const base = mkdtempSync(join(tmpdir(), "gg-refwork-"));
  const work = join(base, "work");
  const bare = join(base, "bare");
  mkdirSync(work, { recursive: true });
  git(base, ["init", "-q", "-b", "main", work]);
  git(work, ["config", "user.email", "t@example.test"]);
  git(work, ["config", "user.name", "T"]);
  writeFileSync(join(work, "a.txt"), "one\n");
  git(work, ["add", "-A"]);
  git(work, ["commit", "-q", "-m", "base"]);
  git(work, ["branch", "feature"]);
  await initBareRepository(bare, "main");
  return { bare, base, work };
}

test("branches and tags are told apart, and an annotated tag reports its commit", async () => {
  const { bare, base, work } = await seed();

  git(work, ["tag", "lightweight-v1"]);
  git(work, ["tag", "-a", "annotated-v1", "-m", "release one"]);
  const commitSha = spawnSync("git", ["rev-parse", "main"], { cwd: work, stdio: "pipe", encoding: "utf8" }).stdout.trim();
  const tagObjectSha = spawnSync("git", ["rev-parse", "annotated-v1"], { cwd: work, stdio: "pipe", encoding: "utf8" }).stdout.trim();
  expect(tagObjectSha).not.toBe(commitSha);
  git(bare, ["fetch", "-q", work, "main:refs/heads/main", "feature:refs/heads/feature", "--tags"]);

  const { branches, tags, head } = await refsAt(bare);

  expect(branches.map((b) => b.name).sort()).toEqual(["feature", "main"]);
  expect(tags.map((t) => t.name).sort()).toEqual(["annotated-v1", "lightweight-v1"]);
  expect(head).toBe("main");

  for (const tag of tags) {
    expect(tag.sha, `${tag.name} should resolve to a commit`).toBe(commitSha);
  }
  for (const branch of branches) {
    expect(branch.sha).toBe(commitSha);
    expect(branch.updatedAt).toBeGreaterThan(0);
  }

  expect((await listBranches(bare)).map((b) => b.name).sort()).toEqual(["feature", "main"]);
  expect((await listTags(bare)).map((t) => t.name).sort()).toEqual(["annotated-v1", "lightweight-v1"]);
  expect(head).toBe(await headBranch(bare));

  rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
}, 60_000);

test("a branch and a tag may share a name without colliding", async () => {
  const { bare, base, work } = await seed();
  git(work, ["branch", "shared-name"]);
  git(work, ["tag", "shared-name"]);
  git(bare, ["fetch", "-q", work, "main:refs/heads/main", "shared-name:refs/heads/shared-name", "--tags"]);

  const { branches, tags } = await refsAt(bare);
  expect(branches.map((b) => b.name)).toContain("shared-name");
  expect(tags.map((t) => t.name)).toContain("shared-name");
  expect(branches).toHaveLength(2);
  expect(tags).toHaveLength(1);

  rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
}, 60_000);

test("a repository with branches but no tags reports no tags", async () => {
  const { bare, base, work } = await seed();
  git(bare, ["fetch", "-q", work, "main:refs/heads/main", "feature:refs/heads/feature"]);

  const { branches, tags, head } = await refsAt(bare);
  expect(tags).toEqual([]);
  expect(branches).toHaveLength(2);
  expect(head).toBe("main");
  rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
}, 60_000);

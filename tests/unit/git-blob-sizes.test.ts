import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const dataDir = mkdtempSync(join(tmpdir(), "gg-blobsizes-"));
process.env.GITGOOD_DATA_DIR = dataDir;
process.env.GITGOOD_REPO_ROOT = join(dataDir, "repos");
process.env.GITGOOD_LFS_ROOT = join(dataDir, "lfs");
const { initBareRepository, blobSizes, blobAt } = await import("../../src/git/repo.ts");

function git(cwd: string, args: string[]): void {
  const result = spawnSync("git", args, { cwd, stdio: "pipe", encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr || result.stdout}`);
}

const CANDIDATES = [
  "README.md",
  "README",
  "README.rst",
  "README.txt",
  "readme.md",
  "Readme.md",
  "docs/README.md",
] as const;

async function seed(): Promise<string> {
  const base = mkdtempSync(join(tmpdir(), "gg-readme-"));
  const work = join(base, "work");
  const bare = join(base, "bare");
  mkdirSync(work, { recursive: true });
  git(base, ["init", "-q", "-b", "main", work]);
  git(work, ["config", "user.email", "t@example.test"]);
  git(work, ["config", "user.name", "T"]);
  writeFileSync(join(work, "a.txt"), "one\n");
  git(work, ["add", "-A"]);
  git(work, ["commit", "-q", "-m", "base"]);
  await initBareRepository(bare, "main");
  git(bare, ["fetch", "-q", work, "main:refs/heads/main"]);
  return bare;
}

test("one batch answers for every candidate, reporting only the blobs", async () => {
  const bare = await seed();
  writeFileSync(join(bare, "..", "work", "README.rst"), "docs\n");
  mkdirSync(join(bare, "..", "work", "docs"), { recursive: true });
  writeFileSync(join(bare, "..", "work", "docs", "README.md"), "nested\n");
  spawnSync("git", ["add", "-A"], { cwd: join(bare, "..", "work"), stdio: "pipe" });
  spawnSync("git", ["commit", "-q", "-m", "readmes"], { cwd: join(bare, "..", "work"), stdio: "pipe" });
  git(bare, ["fetch", "-q", join(bare, "..", "work"), "main:refs/heads/main"]);

  const sizes = await blobSizes(bare, "main", CANDIDATES);
  expect([...sizes.keys()].sort()).toEqual(["README.rst", "docs/README.md"]);
  expect(sizes.get("README.rst")).toBe("docs\n".length);
  expect(sizes.get("docs/README.md")).toBe("nested\n".length);
  expect(sizes.has("docs")).toBe(false);
  expect(sizes.has("README.md")).toBe(false);
  expect(sizes.has("Readme.md")).toBe(false);

  const readme = await blobAt(bare, "main", "README.rst");
  expect(readme?.size).toBe(sizes.get("README.rst"));

  rmSync(join(bare, ".."), { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
}, 60_000);

test("an empty file is reported as zero, not as missing", async () => {
  const bare = await seed();
  writeFileSync(join(bare, "..", "work", "README"), "");
  spawnSync("git", ["add", "-A"], { cwd: join(bare, "..", "work"), stdio: "pipe" });
  spawnSync("git", ["commit", "-q", "-m", "empty readme"], { cwd: join(bare, "..", "work"), stdio: "pipe" });
  git(bare, ["fetch", "-q", join(bare, "..", "work"), "main:refs/heads/main"]);

  const sizes = await blobSizes(bare, "main", CANDIDATES);
  expect(sizes.has("README")).toBe(true);
  expect(sizes.get("README")).toBe(0);

  rmSync(join(bare, ".."), { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
}, 60_000);

test("a repository with none of the candidates reports nothing found", async () => {
  const bare = await seed();
  expect((await blobSizes(bare, "main", CANDIDATES)).size).toBe(0);
  expect((await blobSizes(bare, "main", [])).size).toBe(0);
  rmSync(join(bare, ".."), { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
}, 60_000);

test("an unknown ref yields no sizes rather than throwing", async () => {
  const bare = await seed();
  const sizes = await blobSizes(bare, "no-such-branch", CANDIDATES);
  expect(sizes.size).toBe(0);
  rmSync(join(bare, ".."), { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
}, 60_000);

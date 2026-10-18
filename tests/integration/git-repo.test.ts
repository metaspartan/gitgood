import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as repo from "../../src/git/repo.ts";
import { git, gitVersion } from "../../src/git/run.ts";

const scratch = mkdtempSync(join(tmpdir(), "gg-git-test-"));
const bare = join(scratch, "demo.git");
const work = join(scratch, "work");
const identity = ["-c", "user.name=Test", "-c", "user.email=test@example.com"];

beforeAll(async () => {
  await repo.initBareRepository(bare, "main");
  mkdirSync(join(work, "src"), { recursive: true });
  await git(["init", "--quiet", "-b", "main", work], { cwd: work });
  writeFileSync(join(work, "src", "a.ts"), "export const a = 1;\n");
  writeFileSync(join(work, "README.md"), "# demo\n");
  await git(["add", "."], { cwd: work });
  await git([...identity, "commit", "-q", "-m", "initial commit"], { cwd: work });
  await git(["remote", "add", "origin", bare], { cwd: work });
  await git(["push", "-q", "origin", "main"], { cwd: work });
  await git(["tag", "v1.0.0"], { cwd: work });
  await git(["push", "-q", "origin", "v1.0.0"], { cwd: work });
});

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

describe("git run", () => {
  test("reports the installed git version", async () => {
    expect(await gitVersion()).toContain("git version");
  });

  test("surfaces failures as GitError with stderr", async () => {
    await expect(git(["rev-parse", "--verify", "nope"], { cwd: bare })).rejects.toThrow();
  });
});

describe("repository reads", () => {
  test("creates a bare repo with the requested default branch", async () => {
    expect(repo.repositoryExists(bare)).toBe(true);
    expect(await repo.headBranch(bare)).toBe("main");
  });

  test("lists branches and tags with shas", async () => {
    const branches = await repo.listBranches(bare);
    expect(branches.map((b) => b.name)).toContain("main");
    expect(branches[0]?.sha).toMatch(/^[0-9a-f]{40}$/);
    expect((await repo.listTags(bare)).map((t) => t.name)).toContain("v1.0.0");
  });

  test("resolves refs and returns null for unknown ones", async () => {
    expect(await repo.resolveRef(bare, "refs/heads/main")).toMatch(/^[0-9a-f]{40}$/);
    expect(await repo.resolveRef(bare, "refs/heads/missing")).toBeNull();
  });

  test("walks commits newest first", async () => {
    const commits = await repo.log(bare, "main");
    expect(commits[0]?.subject).toBe("initial commit");
    expect(commits[0]?.authorEmail).toBe("test@example.com");
  });

  test("lists trees with directories first", async () => {
    const entries = await repo.treeAt(bare, "main");
    expect(entries[0]?.type).toBe("tree");
    const src = await repo.treeAt(bare, "main", "src");
    expect(src.map((e) => e.name)).toEqual(["a.ts"]);
  });

  test("reads blob content and reports size", async () => {
    const blob = await repo.blobAt(bare, "main", "README.md");
    expect(blob).not.toBeNull();
    expect(new TextDecoder().decode(blob?.bytes)).toBe("# demo\n");
    expect(blob?.truncated).toBe(false);
    expect(await repo.blobAt(bare, "main", "missing.txt")).toBeNull();
  });

  test("detects binary content", () => {
    expect(repo.isBinary(new Uint8Array([0, 1, 2]))).toBe(true);
    expect(repo.isBinary(new TextEncoder().encode("plain text"))).toBe(false);
  });

  test("reports commit detail with per-file stats", async () => {
    const head = await repo.resolveRef(bare, "main");
    const detail = await repo.commitDetail(bare, head ?? "");
    expect(detail?.files.map((f) => f.path).sort()).toEqual(["README.md", "src/a.ts"]);
    expect(detail?.stats.additions).toBeGreaterThan(0);
  });

  test("truncates oversized blobs", async () => {
    const blob = await repo.blobAt(bare, "main", "README.md", 4);
    expect(blob?.bytes.byteLength).toBe(4);
    expect(blob?.truncated).toBe(true);
  });

  test("reports repository size", async () => {
    const size = await repo.repoSize(bare);
    expect(size.bytes).toBeGreaterThan(0);
  });

  test("snapshots refs", async () => {
    const snapshot = await repo.refSnapshot(bare);
    expect(snapshot.refs.has("refs/heads/main")).toBe(true);
    expect(snapshot.head).toBe("main");
  });
});

describe("writes and merges", () => {
  async function syncMain(): Promise<void> {
    await git(["fetch", "-q", "origin"], { cwd: work });
    await git(["reset", "--hard", "-q", "origin/main"], { cwd: work });
  }

  async function commitAndPush(branch: string, file: string, contents: string, message: string): Promise<void> {
    await git(["checkout", "-q", "-B", branch, "origin/main"], { cwd: work });
    writeFileSync(join(work, file), contents);
    await git(["add", "."], { cwd: work });
    await git([...identity, "commit", "-q", "-m", message], { cwd: work });
    const push = await git(["push", "-q", "-f", "origin", branch], { cwd: work });
    expect(push.exitCode).toBe(0);
  }

  test("creates, updates and deletes refs", async () => {
    const head = await repo.resolveRef(bare, "refs/heads/main");
    await repo.updateRef(bare, "refs/heads/temp", head ?? "");
    expect(await repo.resolveRef(bare, "refs/heads/temp")).toBe(head);
    expect(await repo.deleteRef(bare, "refs/heads/temp")).toBe(true);
    expect(await repo.resolveRef(bare, "refs/heads/temp")).toBeNull();
    expect(await repo.deleteRef(bare, "refs/heads/temp")).toBe(false);
  });

  test("fast-forwards when the target is an ancestor", async () => {
    await commitAndPush("fast", "fast.txt", "fast\n", "fast commit");
    await syncMain();

    const result = await repo.mergeRefs(bare, "refs/heads/main", "refs/heads/fast", "merge fast", {
      name: "Test",
      email: "test@example.com",
    });
    expect(result.fastForward).toBe(true);
    expect(await repo.resolveRef(bare, "refs/heads/main")).toBe(result.sha);
    expect((await repo.treeAt(bare, "main")).map((entry) => entry.name)).toContain("fast.txt");
  }, 20_000);

  test("creates a two-parent merge commit when histories diverge", async () => {
    await syncMain();
    await commitAndPush("feature", "feature.txt", "feature\n", "feature commit");
    await syncMain();
    await commitAndPush("main", "main.txt", "main\n", "main commit");

    const result = await repo.mergeRefs(bare, "refs/heads/main", "refs/heads/feature", "merge feature", {
      name: "Test",
      email: "test@example.com",
    });
    expect(result.fastForward).toBe(false);

    const detail = await repo.commitDetail(bare, result.sha);
    expect(detail?.parents).toHaveLength(2);
    expect(detail?.subject).toBe("merge feature");

    const names = (await repo.treeAt(bare, "main")).map((entry) => entry.name);
    expect(names).toContain("feature.txt");
    expect(names).toContain("main.txt");
  }, 20_000);

  test("reports conflicts instead of writing a broken merge", async () => {
    await syncMain();
    await commitAndPush("conflict", "README.md", "conflicting content\n", "conflicting change");
    await syncMain();
    await commitAndPush("main", "README.md", "main side change\n", "main side change");

    const before = await repo.resolveRef(bare, "refs/heads/main");
    await expect(
      repo.mergeRefs(bare, "refs/heads/main", "refs/heads/conflict", "conflict", {
        name: "Test",
        email: "test@example.com",
      }),
    ).rejects.toThrow(/conflict/i);
    expect(await repo.resolveRef(bare, "refs/heads/main")).toBe(before);
  }, 20_000);
});

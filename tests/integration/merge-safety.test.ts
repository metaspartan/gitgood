import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git } from "../../src/git/run.ts";
import { compareAndSwapRef, mergeRefs, resolveRef } from "../../src/git/repo.ts";

test("pinned merge refuses moved heads and compare-and-swap refuses a changed base", async () => {
  const dir = mkdtempSync(join(tmpdir(), "merge-safety-"));
  try {
    const run = (args: string[]) => git(args, { cwd: dir });
    await run(["init", "-q", "-b", "main"]); await run(["config", "user.name", "Test"]); await run(["config", "user.email", "test@example.test"]);
    writeFileSync(join(dir, "file"), "base"); await run(["add", "."]); await run(["commit", "-qm", "base"]);
    const base = (await resolveRef(dir, "main"))!;
    await run(["checkout", "-qb", "feature"]);
    writeFileSync(join(dir, "file"), "reviewed"); await run(["commit", "-qam", "reviewed"]);
    const reviewed = (await resolveRef(dir, "feature"))!;
    writeFileSync(join(dir, "file"), "unreviewed"); await run(["commit", "-qam", "unreviewed"]);
    await expect(mergeRefs(dir, "refs/heads/main", "refs/heads/feature", "merge", { name: "Test", email: "test@example.test" }, { pinnedHeadSha: reviewed })).rejects.toThrow();
    expect(await resolveRef(dir, "main")).toBe(base);
    expect(await compareAndSwapRef(dir, "refs/heads/main", reviewed, "0".repeat(40))).toBe(false);
    expect(await resolveRef(dir, "main")).toBe(base);
    expect(await compareAndSwapRef(dir, "refs/heads/main", reviewed, base, { ref: "refs/heads/feature", sha: reviewed })).toBe(false);
    expect(await resolveRef(dir, "main")).toBe(base);
    expect(await compareAndSwapRef(dir, "refs/heads/main", reviewed, base)).toBe(true);
    expect(await resolveRef(dir, "main")).toBe(reviewed);
    const head = (await resolveRef(dir, "feature"))!;
    const result = await mergeRefs(dir, "refs/heads/main", "refs/heads/feature", "merge", { name: "Test", email: "test@example.test" }, { pinnedHeadSha: head });
    expect(result.sha).toBe(head); expect(await resolveRef(dir, "main")).toBe(head);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

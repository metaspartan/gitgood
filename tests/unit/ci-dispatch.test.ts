import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { db, migrate, now } from "../../src/db/index.ts";
import { appendLog, failInterruptedRuns, markRunRunning, createRun, finishRun, getRun, listRunsForRepo, readLog, countPendingRuns } from "../../src/ci/store.ts";
import { parseWorkflow } from "../../src/ci/workflow.ts";
import {
  enqueueJobs,
  MAX_CONCURRENT,
  MAX_PENDING,
  resetSchedulerForTests,
  schedulerStats,
  setSchedulerWorkerForTests,
  whenSchedulerIdle,
  admitPush,
} from "../../src/ci/scheduler.ts";
import { maybeTriggerCi } from "../../src/ci/trigger.ts";
import type { RepoRecord } from "../../src/data/repos.ts";
import { repoDiskPath } from "../../src/data/repos.ts";

function ensureRepo(): RepoRecord {
  migrate();
  const stamp = now();
  const username = `cid-${stamp}-${Math.random().toString(36).slice(2, 8)}`;
  const user = db
    .prepare(
      `INSERT INTO users (username, email, display_name, password_hash, is_admin, avatar_hue, created_at)
       VALUES (?, ?, ?, 'x', 0, 0, ?)`,
    )
    .run(username, `${username}@example.com`, username, stamp);
  const repo = db
    .prepare(
      `INSERT INTO repos (owner_id, name, description, visibility, default_branch, lfs_enabled, archived, created_at, updated_at)
       VALUES (?, 'actions', '', 'public', 'main', 1, 0, ?, ?)`,
    )
    .run(Number(user.lastInsertRowid), stamp, stamp);
  const row = db.prepare(`SELECT * FROM repos WHERE id = ?`).get(Number(repo.lastInsertRowid)) as RepoRecord;
  return { ...row, owner_username: username };
}

function workflow(jobs: string[]) {
  return parseWorkflow(
    [
      "name: CI",
      "on: [push, workflow_dispatch]",
      "jobs:",
      ...jobs.flatMap((id) => [`  ${id}:`, "    runs-on: ubuntu-latest", "    steps:", "      - run: echo ok"]),
    ].join("\n"),
  );
}

const roots: string[] = [];
const previousMode = process.env.GITGOOD_CI_MODE;
beforeEach(() => resetSchedulerForTests());

afterEach(async () => {
  setSchedulerWorkerForTests(null);
  await whenSchedulerIdle().catch(() => undefined);
  resetSchedulerForTests();
  if (previousMode === undefined) delete process.env.GITGOOD_CI_MODE;
  else process.env.GITGOOD_CI_MODE = previousMode;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("shared CI scheduler", () => {
  test("persists queued ids before the worker starts and caps concurrency at 2", async () => {
    const repo = ensureRepo();
    const gates: Array<() => void> = [];
    let started = 0;
    setSchedulerWorkerForTests(
      () =>
        new Promise((resolve) => {
          started += 1;
          gates.push(resolve);
        }),
    );
    const wf = workflow(["a", "b", "c"]);
    const result = enqueueJobs(
      repo,
      "a".repeat(40),
      "main",
      wf.jobs.map((job) => ({ job, workflow: wf, event: "push" as const })),
      null,
    );
    expect(result.rejected).toBe(false);
    expect(result.accepted).toHaveLength(3);
    for (const row of result.accepted) {
      const stored = getRun(row.id);
      expect(stored?.status).toBe("queued");
      expect(stored?.sha).toBe("a".repeat(40));
    }
    await Bun.sleep(20);
    expect(started).toBe(MAX_CONCURRENT);
    expect(schedulerStats().active).toBe(2);
    expect(schedulerStats().queued).toBe(1);
    const release = gates.shift();
    release?.();
    await Bun.sleep(20);
    expect(started).toBe(3);
    while (gates.length) gates.shift()?.();
    await whenSchedulerIdle();
    expect(schedulerStats().finished).toBe(3);
    expect(schedulerStats().started).toBe(3);
  });

  test("one job at the concurrency limit starts immediately and a failure does not stall the queue", async () => {
    const repo = ensureRepo();
    let started = 0;
    setSchedulerWorkerForTests(async (item) => {
      started += 1;
      if (item.job.id === "bad") throw new Error("step failed");
    });
    const wf = workflow(["only"]);
    enqueueJobs(repo, "b".repeat(40), "main", [{ job: wf.jobs[0]!, workflow: wf, event: "push" }], null);
    await whenSchedulerIdle();
    expect(started).toBe(1);
    expect(schedulerStats().finished).toBe(1);
    const failing = workflow(["bad", "next"]);
    enqueueJobs(
      repo,
      "c".repeat(40),
      "main",
      failing.jobs.map((job) => ({ job, workflow: failing, event: "workflow_dispatch" as const })),
      null,
    );
    await whenSchedulerIdle();
    expect(started).toBe(3);
    expect(schedulerStats().finished).toBe(3);
    expect(schedulerStats().active).toBe(0);
  });

  test("admission above pending 20 is all-or-nothing and a rejected push is recorded", async () => {
    const repo = ensureRepo();
    setSchedulerWorkerForTests(() => new Promise(() => undefined));
    const filler = workflow(["hold"]);
    const room = MAX_PENDING - countPendingRuns();
    expect(room).toBeGreaterThan(0);
    const first = enqueueJobs(
      repo,
      "d".repeat(40),
      "main",
      Array.from({ length: room }, () => ({ job: filler.jobs[0]!, workflow: filler, event: "push" as const })),
      null,
    );
    expect(first.accepted).toHaveLength(room);
    expect(countPendingRuns()).toBe(MAX_PENDING);
    const before = listRunsForRepo(repo.id, 100).length;
    const overflow = workflow(["one", "two"]);
    const refused = enqueueJobs(
      repo,
      "e".repeat(40),
      "topic",
      overflow.jobs.map((job) => ({ job, workflow: overflow, event: "push" as const })),
      null,
    );
    expect(refused.rejected).toBe(true);
    expect(refused.accepted).toHaveLength(0);
    expect(listRunsForRepo(repo.id, 100).filter((row) => row.sha === "e".repeat(40))).toHaveLength(0);
    expect(listRunsForRepo(repo.id, 200).length).toBe(before);

    const root = mkdtempSync(join(tmpdir(), "gg-ci-q-"));
    roots.push(root);
    const seed = mkdtempSync(join(tmpdir(), "gg-ci-seed-"));
    roots.push(seed);
    const git = (args: string[], cwd: string) => {
      const result = Bun.spawnSync({
        cmd: ["git", ...args],
        cwd,
        stdout: "pipe",
        stderr: "pipe",
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: "t",
          GIT_AUTHOR_EMAIL: "t@example.com",
          GIT_COMMITTER_NAME: "t",
          GIT_COMMITTER_EMAIL: "t@example.com",
        },
      });
      expect(result.exitCode, result.stderr.toString()).toBe(0);
    };
    git(["init", "--bare", root], root);
    git(["init", "-b", "main"], seed);
    writeFileSync(
      join(seed, ".gitgood-ci.yml"),
      "name: CI\non: push\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo a\n  b:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo b\n",
    );
    git(["add", ".gitgood-ci.yml"], seed);
    git(["commit", "-m", "ci"], seed);
    git(["branch", "other"], seed);
    git(["remote", "add", "origin", root], seed);
    git(["push", "origin", "main", "other"], seed);
    const sha = Bun.spawnSync({ cmd: ["git", "rev-parse", "HEAD"], cwd: seed, stdout: "pipe" }).stdout.toString().trim();
    db.prepare(`UPDATE repos SET disk_path = ? WHERE id = ?`).run(root, repo.id);
    const stored = db.prepare(`SELECT * FROM repos WHERE id = ?`).get(repo.id) as RepoRecord;
    const withOwner = { ...stored, owner_username: repo.owner_username, disk_path: root };
    expect(repoDiskPath(withOwner)).toBe(root);
    const pushed = await admitPush(withOwner, "main", sha);
    expect(pushed.rejected).toBe(true);
    expect(pushed.accepted).toHaveLength(1);
    expect(pushed.accepted[0]?.job_id).toBe("rejected");
    expect(pushed.accepted[0]?.status).toBe("failure");
    const log = readLog(pushed.accepted[0]!.id, 0, 10);
    expect(log.map((line) => line.text).join("\n")).toContain("push rejected");
    const partial = listRunsForRepo(repo.id, 200).filter((row) => row.sha === sha && row.job_id !== "rejected");
    expect(partial).toHaveLength(0);
    resetSchedulerForTests();
    setSchedulerWorkerForTests(async () => undefined);
    for (const row of first.accepted) finishRun(row.id, "success", 0);
    await maybeTriggerCi(withOwner, [
      { ref: "refs/heads/main", after: sha },
      { ref: "refs/heads/other", after: sha },
      { ref: "refs/tags/v1", after: sha },
    ]);
    await whenSchedulerIdle();
    const ran = listRunsForRepo(repo.id, 50).filter((row) => row.sha === sha && row.job_id !== "rejected");
    const branches = new Set(ran.map((row) => row.ref_name));
    expect(branches.has("main")).toBe(true);
    expect(branches.has("other")).toBe(true);
    expect(ran.filter((row) => row.ref_name === "main")).toHaveLength(2);
    expect(ran.filter((row) => row.ref_name === "other")).toHaveLength(2);
  });

  test("parser keeps unsupported warnings and accepts workflow_dispatch without inputs", () => {
    const parsed = parseWorkflow(
      "name: CI\non:\n  push:\n  pull_request:\n  workflow_dispatch:\njobs:\n  build:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo hi\n",
    );
    expect(parsed.triggers.has("push")).toBe(true);
    expect(parsed.triggers.has("workflow_dispatch")).toBe(true);
    expect(parsed.triggers.has("pull_request")).toBe(false);
    expect(parsed.warnings.some((warning) => warning.includes("pull_request"))).toBe(true);
    expect(parsed.warnings.some((warning) => warning.includes('trigger "workflow_dispatch" is not implemented'))).toBe(false);
    const uses = parseWorkflow(
      "name: CI\non: workflow_dispatch\njobs:\n  build:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n",
    );
    expect(uses.warnings.some((warning) => warning.includes("uses:"))).toBe(true);
  });

  test("disabled mode does not start a queued manual job through the worker gate", async () => {
    process.env.GITGOOD_CI_MODE = "disabled";
    const repo = ensureRepo();
    let started = 0;
    setSchedulerWorkerForTests(async () => {
      started += 1;
    });
    const held = createRun({
      repo_id: repo.id,
      workflow_name: "CI",
      job_id: "build",
      ref_name: "main",
      sha: "f".repeat(40),
    });
    expect(getRun(held)?.status).toBe("queued");
    expect(started).toBe(0);
    finishRun(held, "failure", 1);
  });
});


test("restart recovery fails pending records exactly once and preserves completed jobs", () => {
  const repo = ensureRepo();
  const queued = createRun({ repo_id: repo.id, workflow_name: "restart", job_id: "one", ref_name: "main", sha: "a".repeat(40) });
  const running = createRun({ repo_id: repo.id, workflow_name: "restart", job_id: "two", ref_name: "main", sha: "a".repeat(40) });
  markRunRunning(running); appendLog(running, 0, "previous output");
  const completed = createRun({ repo_id: repo.id, workflow_name: "restart", job_id: "done", ref_name: "main", sha: "a".repeat(40) });
  finishRun(completed, "success", 0);
  const pendingBefore = countPendingRuns();
  expect(failInterruptedRuns()).toBe(pendingBefore);
  expect(getRun(queued)?.status).toBe("failure"); expect(getRun(running)?.status).toBe("failure");
  expect(readLog(running, 0, 10).map(x => x.seq)).toEqual([0, 1]);
  expect(failInterruptedRuns()).toBe(0);
  expect(getRun(completed)?.status).toBe("success");
});

test("workflow trigger inputs and branch filters cannot be silently ignored", () => {
  for (const event of ["push", "workflow_dispatch"]) {
    const source = `on:\n  ${event}:\n    inputs:\n      version: ignored\njobs:\n  job:\n    steps:\n      - run: echo ok`;
    expect(parseWorkflow(source).warnings.length).toBeGreaterThan(0);
  }
});


test("pending boundary accepts below and at limit, rejects one above with exact execution counts", async () => {
  for (const count of [MAX_PENDING - 1, MAX_PENDING, MAX_PENDING + 1]) {
    resetSchedulerForTests(); failInterruptedRuns();
    const repo = ensureRepo(); const wf = workflow(Array.from({ length: count }, (_, i) => `job${i}`));
    let started = 0; const gates: Array<() => void> = [];
    setSchedulerWorkerForTests(item => new Promise<void>(resolve => { started++; gates.push(() => { finishRun(item.runId, "success", 0); resolve(); }); }));
    const before = listRunsForRepo(repo.id, 100).length;
    const result = enqueueJobs(repo, "d".repeat(40), "main", wf.jobs.map(job => ({ job, workflow: wf, event: "workflow_dispatch" as const })), null);
    if (count > MAX_PENDING) {
      expect(result.rejected).toBe(true); expect(started).toBe(0); expect(listRunsForRepo(repo.id, 100).length).toBe(before);
    } else {
      expect(result.accepted).toHaveLength(count); expect(started).toBe(2);
      while (schedulerStats().pending) { gates.shift()?.(); await Bun.sleep(0); }
      expect(started).toBe(count); expect(schedulerStats().finished).toBe(count); expect(gates).toHaveLength(0);
    }
    expect(schedulerStats().active).toBe(0); expect(schedulerStats().queued).toBe(0);
  }
});


test("synchronous worker failure releases slots and wakes every idle waiter", async () => {
  failInterruptedRuns();
  const repo = ensureRepo(); const wf = workflow(["one", "two", "three"]);
  setSchedulerWorkerForTests(() => { throw new Error("synchronous failure"); });
  const result = enqueueJobs(repo, "f".repeat(40), "main", wf.jobs.map(job => ({ job, workflow: wf, event: "push" as const })), null);
  await Promise.all([whenSchedulerIdle(), whenSchedulerIdle()]);
  expect(schedulerStats()).toMatchObject({ active: 0, queued: 0, started: 3, finished: 3 });
  for (const row of result.accepted) expect(getRun(row.id)?.status).toBe("failure");
  expect(countPendingRuns()).toBe(0);
});

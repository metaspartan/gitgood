import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { childJobEnv, ciExecutionAllowed, ciRunnerStatus, resolveCiMode } from "../../src/ci/policy.ts";
import { createBoundedBuffer, runJob } from "../../src/ci/runner.ts";
import { parseWorkflow } from "../../src/ci/workflow.ts";
import { db, migrate, now } from "../../src/db/index.ts";
import { readLog } from "../../src/ci/store.ts";

function ensureRepo(): number {
  migrate();
  const stamp = now();
  const username = `ci-${stamp}-${Math.random().toString(36).slice(2, 8)}`;
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
  return Number(repo.lastInsertRowid);
}

const previousMode = process.env.GITGOOD_CI_MODE;

afterEach(() => {
  if (previousMode === undefined) delete process.env.GITGOOD_CI_MODE;
  else process.env.GITGOOD_CI_MODE = previousMode;
});

describe("CI mode policy", () => {
  test("absent production defaults to external runners and nonproduction to trusted-host", () => {
    expect(resolveCiMode({}, "production")).toBe("runner");
    expect(resolveCiMode({ GITGOOD_CI_MODE: "runner" }, "development")).toBe("runner");
    expect(resolveCiMode({}, "development")).toBe("trusted-host");
    expect(resolveCiMode({}, "test")).toBe("trusted-host");
  });

  test("explicit mode wins and unknown values stay disabled", () => {
    expect(resolveCiMode({ GITGOOD_CI_MODE: "trusted-host" }, "production")).toBe("trusted-host");
    expect(resolveCiMode({ GITGOOD_CI_MODE: "disabled" }, "development")).toBe("disabled");
    expect(resolveCiMode({ GITGOOD_CI_MODE: "sandbox" }, "development")).toBe("disabled");
    expect(ciExecutionAllowed({ GITGOOD_CI_MODE: "disabled" }, "development")).toBe(false);
    expect(ciExecutionAllowed({ GITGOOD_CI_MODE: "trusted-host" }, "production")).toBe(true);
  });

  test("status never claims isolation", () => {
    const disabled = ciRunnerStatus({ GITGOOD_CI_MODE: "disabled" }, "production");
    const trusted = ciRunnerStatus({ GITGOOD_CI_MODE: "trusted-host" }, "production");
    expect(disabled.enabled).toBe(false);
    expect(disabled.isolation).toBe("none");
    expect(disabled.notice.toLowerCase()).toContain("not a sandbox");
    expect(trusted.enabled).toBe(true);
    expect(trusted.isolation).toBe("none");
    expect(trusted.notice.toLowerCase()).toContain("no sandbox");
  });

  test("child env drops server secrets and points HOME at the scratch dir", () => {
    const env = childJobEnv("/tmp/ci-scratch", {
      PATH: "/usr/bin",
      HOME: "/home/server",
      USERPROFILE: "C:\\Users\\server",
      GITGOOD_SESSION_SECRET: "session-secret",
      DATABASE_URL: "sqlite:///secret",
      AWS_SECRET_ACCESS_KEY: "aws",
      NODE_ENV: "production",
    });
    expect(env.PATH).toBe("/usr/bin");
    expect(env.HOME).toBe("/tmp/ci-scratch");
    expect(env.USERPROFILE).toBe("/tmp/ci-scratch");
    expect(env.PWD).toBe("/tmp/ci-scratch");
    expect(env.GITGOOD_SESSION_SECRET).toBeUndefined();
    expect(env.DATABASE_URL).toBeUndefined();
    expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(env.NODE_ENV).toBeUndefined();
  });
});

describe("bounded step buffers", () => {
  test("keeps only the configured prefix and reports the drop", () => {
    const buffer = createBoundedBuffer(8);
    buffer.append("abcdef");
    buffer.append("ghijklmnop");
    expect(buffer.text().startsWith("abcdefgh")).toBe(true);
    expect(buffer.text()).toContain("8 bytes dropped");
    expect(buffer.text().length).toBeLessThan(80);
  });
});

describe("workflow trigger controls", () => {
  test("push is the only implemented trigger and unsupported features warn", () => {
    const plain = parseWorkflow("on: push\njobs:\n  build:\n    steps:\n      - run: echo ok\n");
    expect(plain.triggers.has("push")).toBe(true);
    expect(plain.warnings).toEqual([]);

    const mixed = parseWorkflow("on: [push, pull_request]\njobs:\n  build:\n    env:\n      TOKEN: secret\n    steps:\n      - run: echo ok\n");
    expect(mixed.triggers.has("push")).toBe(true);
    expect(mixed.triggers.has("pull_request")).toBe(false);
    expect(mixed.warnings.some((warning) => warning.includes("pull_request"))).toBe(true);
    expect(mixed.warnings.some((warning) => warning.includes("env:"))).toBe(true);

    const onlyPr = parseWorkflow("on: pull_request\njobs:\n  build:\n    steps:\n      - run: echo skipped\n");
    expect(onlyPr.triggers.has("push")).toBe(false);
    expect(onlyPr.warnings.length).toBeGreaterThan(0);
  });
});

describe("runner refuses unsafe execution", () => {
  test("disabled mode records failure without cloning", async () => {
    const repoId = ensureRepo();
    process.env.GITGOOD_CI_MODE = "disabled";
    const root = mkdtempSync(join(tmpdir(), "gg-ci-"));
    try {
      const summary = await runJob(
        repoId,
        { name: "CI", triggers: new Set(["push"]), jobs: [], warnings: [] },
        { id: "build", name: "build", runsOn: "host", steps: [{ name: "leak", run: "echo $GITGOOD_SESSION_SECRET" }] },
        "abcdef1234567890",
        "main",
        root,
      );
      expect(summary.status).toBe("failure");
      expect(summary.steps).toEqual([]);
      expect(existsSync(`${root}.ci-abcdef12-${summary.runId}`)).toBe(false);
      const lines = readLog(summary.runId, 0, 50).map((line) => line.text).join("\n");
      expect(lines).toContain("disabled");
      expect(lines.toLowerCase()).not.toContain("sandbox isolation is");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("unsupported warnings fail the run instead of executing steps", async () => {
    const repoId = ensureRepo();
    process.env.GITGOOD_CI_MODE = "trusted-host";
    const root = mkdtempSync(join(tmpdir(), "gg-ci-"));
    const marker = join(root, "ran");
    try {
      const summary = await runJob(
        repoId,
        {
          name: "CI",
          triggers: new Set(["push"]),
          jobs: [],
          warnings: ["job \"build\" uses \"matrix:\" which is not implemented"],
        },
        { id: "build", name: "build", runsOn: "host", steps: [{ name: "touch", run: `echo ran > "${marker}"` }] },
        "abcdef1234567890",
        "main",
        root,
      );
      expect(summary.status).toBe("failure");
      expect(existsSync(marker)).toBe(false);
      const lines = readLog(summary.runId, 0, 50).map((line) => line.text).join("\n");
      expect(lines).toContain("matrix:");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("trusted-host runs scrubbed env and removes the worktree", async () => {
    const repoId = ensureRepo();
    process.env.GITGOOD_CI_MODE = "trusted-host";
    process.env.GITGOOD_SESSION_SECRET = "super-secret-value";
    const root = mkdtempSync(join(tmpdir(), "gg-ci-bare-"));
    const init = Bun.spawnSync({ cmd: ["git", "init", "--bare", root], stdout: "pipe", stderr: "pipe" });
    expect(init.exitCode).toBe(0);
    const seed = mkdtempSync(join(tmpdir(), "gg-ci-seed-"));
    try {
      writeFileSync(join(seed, "README"), "hi\n");
      const run = (args: string[], cwd: string) => {
        const result = Bun.spawnSync({
          cmd: ["git", ...args],
          cwd,
          stdout: "pipe",
          stderr: "pipe",
          env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" },
        });
        expect(result.exitCode, result.stderr.toString()).toBe(0);
      };
      run(["init", "-b", "main"], seed);
      run(["add", "README"], seed);
      run(["commit", "-m", "init"], seed);
      run(["remote", "add", "origin", root], seed);
      run(["push", "origin", "main"], seed);
      const sha = Bun.spawnSync({ cmd: ["git", "rev-parse", "HEAD"], cwd: seed, stdout: "pipe", stderr: "pipe" }).stdout.toString().trim();
      const summary = await runJob(
        repoId,
        { name: "CI", triggers: new Set(["push"]), jobs: [], warnings: [] },
        { id: "build", name: "build", runsOn: "host", steps: [{ name: "env", run: "printf '%s' \"$GITGOOD_SESSION_SECRET\"" }] },
        sha,
        "main",
        root,
      );
      expect(summary.status).toBe("success");
      expect(existsSync(`${root}.ci-${sha.slice(0, 8)}-${summary.runId}`)).toBe(false);
      const lines = readLog(summary.runId, 0, 200).map((line) => line.text).join("\n");
      expect(lines).not.toContain("super-secret-value");
      expect(lines.toLowerCase()).toContain("no sandbox");
    } finally {
      delete process.env.GITGOOD_SESSION_SECRET;
      rmSync(root, { recursive: true, force: true });
      rmSync(seed, { recursive: true, force: true });
    }
  });
});

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "../../src/server.ts";
import { git } from "../../src/git/run.ts";
import { db } from "../../src/db/index.ts";

const scratch = mkdtempSync(join(tmpdir(), "gg-protect-"));
const server = createServer(0);
const BASE = `http://127.0.0.1:${server.port}`;
const run = Date.now().toString(36);
const identity = ["-c", "user.name=Protect", "-c", "user.email=protect@example.com"];

afterAll(async () => {
  await server.stop(true);
  rmSync(scratch, { recursive: true, force: true });
});

class Client {
  cookie = "";
  async request<T>(path: string, options: { method?: string; body?: unknown; token?: string } = {}): Promise<{ status: number; data: T }> {
    const headers: Record<string, string> = {};
    if (this.cookie) headers.cookie = this.cookie;
    if (options.token) headers.authorization = `Bearer ${options.token}`;
    if (options.body !== undefined) headers["content-type"] = "application/json";
    const response = await fetch(`${BASE}${path}`, {
      method: options.method ?? "GET",
      headers,
      ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
    });
    const setCookie = response.headers.get("set-cookie");
    if (setCookie) this.cookie = setCookie.split(";")[0] ?? "";
    const text = await response.text();
    let data: unknown = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = text;
      }
    }
    return { status: response.status, data: data as T };
  }
}

const owner = new Client();
const writer = new Client();
const username = `prot${run}`;
const other = `protw${run}`;
const repo = "guarded";
let readToken = "";

async function push(cwd: string, refspec: string, extra: string[] = []): Promise<{ code: number; stderr: string }> {
  const remote = `${BASE.replace("http://", `http://${username}:${encodeURIComponent("supersecret123")}@`)}/${username}/${repo}.git`;
  const result = await git(["push", ...extra, remote, refspec], { cwd, allowFailure: true, timeoutMs: 30_000 });
  return { code: result.exitCode, stderr: result.stderr };
}

async function tip(cwd: string, branch = "main"): Promise<string> {
  const result = await git(["rev-parse", branch], { cwd });
  return result.stdout.trim();
}

beforeAll(async () => {
  const signup = await owner.request("/api/auth/signup", {
    method: "POST",
    body: { username, email: `${username}@example.com`, password: "supersecret123" },
  });
  expect(signup.status).toBe(201);
  expect((await owner.request("/api/repos", { method: "POST", body: { name: repo, visibility: "public" } })).status).toBe(201);
  const token = await owner.request<{ token: string }>("/api/tokens", {
    method: "POST",
    body: { name: "read", scopes: ["read"] },
  });
  readToken = token.data.token;

  await writer.request("/api/auth/signup", {
    method: "POST",
    body: { username: other, email: `${other}@example.com`, password: "supersecret123" },
  });

  const work = join(scratch, "seed");
  await git(["init", "-q", "-b", "main", work]);
  await Bun.write(join(work, "README.md"), "seed\n");
  await git(["add", "."], { cwd: work });
  await git([...identity, "commit", "-q", "-m", "seed"], { cwd: work });
  const seeded = await push(work, "main");
  expect(seeded.code).toBe(0);
});

describe("branch protection API", () => {
  test("GET starts empty and reports who can manage", async () => {
    const listed = await owner.request<{ items: unknown[]; can_manage: boolean }>(
      `/api/repos/${username}/${repo}/branch-protection`,
    );
    expect(listed.status).toBe(200);
    expect(listed.data.items).toEqual([]);
    expect(listed.data.can_manage).toBe(true);

    const stranger = await writer.request<{ can_manage: boolean }>(
      `/api/repos/${username}/${repo}/branch-protection`,
    );
    expect(stranger.status).toBe(200);
    expect(stranger.data.can_manage).toBe(false);
  });

  test("PUT is strict and requires a policy admin with write", async () => {
    const extra = await owner.request(`/api/repos/${username}/${repo}/branch-protection`, {
      method: "PUT",
      body: { branch: "main", require_pull_request: true, admin_bypass: true },
    });
    expect(extra.status).toBe(400);

    const reader = await owner.request(`/api/repos/${username}/${repo}/branch-protection`, {
      method: "PUT",
      token: readToken,
      body: { branch: "main", require_pull_request: true },
    });
    expect(reader.status).toBe(403);

    const stranger = await writer.request(`/api/repos/${username}/${repo}/branch-protection`, {
      method: "PUT",
      body: { branch: "main", require_pull_request: true },
    });
    expect(stranger.status).toBe(403);

    const saved = await owner.request<{
      items: Array<{ branch: string; require_pull_request: boolean }>;
      can_manage: boolean;
    }>(`/api/repos/${username}/${repo}/branch-protection`, {
      method: "PUT",
      body: { branch: "main", require_pull_request: true },
    });
    expect(saved.status).toBe(200);
    expect(saved.data.can_manage).toBe(true);
    expect(saved.data.items).toEqual([{ branch: "main", require_pull_request: true }]);
  });

  test("refuses a 101st distinct rule", async () => {
    const overflow = `cap${run}`;
    expect((await owner.request("/api/repos", { method: "POST", body: { name: overflow } })).status).toBe(201);
    for (let i = 0; i < 100; i++) {
      const put = await owner.request(`/api/repos/${username}/${overflow}/branch-protection`, {
        method: "PUT",
        body: { branch: `b${i}`, require_pull_request: true },
      });
      expect(put.status).toBe(200);
    }
    const over = await owner.request(`/api/repos/${username}/${overflow}/branch-protection`, {
      method: "PUT",
      body: { branch: "b100", require_pull_request: true },
    });
    expect(over.status).toBe(400);
  });
});

describe("receive-pack enforcement", () => {
  const work = join(scratch, "push");

  beforeAll(async () => {
    await git(["clone", "-q", `${BASE}/${username}/${repo}.git`, work]);
    await git(["config", "user.name", "Protect"], { cwd: work });
    await git(["config", "user.email", "protect@example.com"], { cwd: work });
  });

  async function commitFile(name: string, body: string): Promise<void> {
    await Bun.write(join(work, name), body);
    await git(["add", name], { cwd: work });
    await git(["commit", "-q", "-m", name], { cwd: work });
  }

  test("rejects an ordinary push, a force push, a delete, and a create of the protected branch", async () => {
    const before = await tip(work);
    await commitFile("ordinary.txt", "nope\n");
    const ordinary = await push(work, "main");
    expect(ordinary.code).not.toBe(0);
    expect(ordinary.stderr).toContain("requires a pull request");
    await git(["reset", "--hard", "-q", before], { cwd: work });

    await commitFile("force.txt", "force\n");
    await git(["commit", "-q", "--amend", "-m", "rewritten"], { cwd: work });
    const forced = await push(work, "main", ["--force"]);
    expect(forced.code).not.toBe(0);
    expect(forced.stderr).toContain("requires a pull request");
    await git(["reset", "--hard", "-q", "origin/main"], { cwd: work });

    const deleted = await push(work, ":main");
    expect(deleted.code).not.toBe(0);
    expect(deleted.stderr).toContain("requires a pull request");

    await git(["checkout", "-q", "-B", "recreate", "origin/main"], { cwd: work });
    await git(["branch", "-D", "brand-new"], { cwd: work, allowFailure: true });
    await git(["checkout", "-q", "-b", "brand-new"], { cwd: work });
    await commitFile("brand.txt", "brand\n");
    const created = await push(work, "brand-new:main");
    expect(created.code).not.toBe(0);
    expect(created.stderr).toContain("requires a pull request");
    await git(["fetch", "-q", "origin"], { cwd: work });
    expect(await tip(work, "origin/main")).toBe(before);
  }, 60_000);

  test("a multi-ref push that includes the protected branch is rejected atomically", async () => {
    const before = await tip(work, "origin/main");
    await git(["checkout", "-q", "-B", "topic", "origin/main"], { cwd: work });
    await commitFile("topic.txt", "topic\n");
    const topic = await tip(work, "topic");
    await git(["checkout", "-q", "main"], { cwd: work });
    await git(["reset", "--hard", "-q", "origin/main"], { cwd: work });
    await commitFile("main.txt", "main\n");

    const both = await git(
      [
        "push",
        `${BASE.replace("http://", `http://${username}:${encodeURIComponent("supersecret123")}@`)}/${username}/${repo}.git`,
        "main",
        "topic",
      ],
      { cwd: work, allowFailure: true, timeoutMs: 30_000 },
    );
    expect(both.exitCode).not.toBe(0);
    expect(both.stderr).toContain("requires a pull request");

    const remoteMain = await git(["ls-remote", `${BASE}/${username}/${repo}.git`, "refs/heads/main", "refs/heads/topic"], {
      allowFailure: true,
    });
    expect(remoteMain.stdout).toContain(before);
    expect(remoteMain.stdout).not.toContain(topic);
    expect(remoteMain.stdout).not.toContain("refs/heads/topic");
  }, 60_000);

  test("an unprotected branch still accepts a push", async () => {
    await git(["checkout", "-q", "-B", "feature", "origin/main"], { cwd: work });
    await commitFile("feature.txt", "ok\n");
    const result = await push(work, "feature");
    expect(result.code).toBe(0);
  }, 60_000);

  test("disabling the rule allows the protected branch again", async () => {
    const off = await owner.request(`/api/repos/${username}/${repo}/branch-protection`, {
      method: "PUT",
      body: { branch: "main", require_pull_request: false },
    });
    expect(off.status).toBe(200);
    await git(["checkout", "-q", "main"], { cwd: work });
    await git(["reset", "--hard", "-q", "origin/main"], { cwd: work });
    await commitFile("after.txt", "allowed\n");
    const result = await push(work, "main");
    expect(result.code).toBe(0);

    const on = await owner.request(`/api/repos/${username}/${repo}/branch-protection`, {
      method: "PUT",
      body: { branch: "main", require_pull_request: true },
    });
    expect(on.status).toBe(200);
  }, 60_000);

  test("web contents writes and branch mutations are rejected, and a user hook file is untouched", async () => {
    const edit = await owner.request(`/api/repos/${username}/${repo}/contents`, {
      method: "PUT",
      body: { path: "web.txt", branch: "main", content: "web\n", encoding: "utf8" },
    });
    expect(edit.status).toBe(400);

    const created = await owner.request(`/api/repos/${username}/${repo}/branches`, {
      method: "POST",
      body: { name: "main", from: "feature" },
    });
    expect(created.status).toBe(400);

    await owner.request(`/api/repos/${username}/${repo}/branch-protection`, {
      method: "PUT",
      body: { branch: "feature", require_pull_request: true },
    });
    const removed = await owner.request(`/api/repos/${username}/${repo}/branches/feature`, { method: "DELETE" });
    expect(removed.status).toBe(400);

    const row = db.query("SELECT disk_path FROM repos WHERE name = ?").get(repo) as { disk_path: string | null };
    expect(row.disk_path).toBeTruthy();
    const hookFile = join(row.disk_path ?? "", "hooks", "pre-receive");
    let before = "";
    try {
      before = readFileSync(hookFile, "utf8");
    } catch {
      before = "";
    }
    await Bun.write(hookFile, "#!/bin/sh\nexit 0\n");
    await commitFile("again.txt", "again\n");
    await git(["checkout", "-q", "main"], { cwd: work });
    const rejected = await push(work, "main");
    expect(rejected.code).not.toBe(0);
    expect(readFileSync(hookFile, "utf8")).toBe("#!/bin/sh\nexit 0\n");
    if (before) await Bun.write(hookFile, before);
  });
});


test("protected branch merges through PR gate, direct file deletion is blocked, removal frees a rule", async () => {
  const prefix = `/api/repos/${username}/${repo}`;
  const branch = `review-${Date.now()}`;
  expect((await owner.request(`${prefix}/branches`, { method: "POST", body: { name: branch, from: "main" } })).status).toBe(201);
  expect((await owner.request(`${prefix}/contents`, { method: "PUT", body: { branch, path: "review.txt", content: "reviewed", encoding: "utf8" } })).status).toBe(201);
  expect((await owner.request(`${prefix}/contents`, { method: "DELETE", body: { branch: "main", path: "README.md" } })).status).toBe(400);
  const pr = await owner.request<{number:number}>(`${prefix}/pulls`, { method: "POST", body: {title:"Protected merge", head:branch, base:"main"} });
  expect(pr.status).toBe(201);
  expect((await owner.request(`${prefix}/pulls/${pr.data.number}/merge`, { method:"POST" })).status).toBe(200);
  const overflow = `/api/repos/${username}/cap${run}/branch-protection`;
  expect((await owner.request(overflow, { method:"PUT", body:{branch:"b0",require_pull_request:false} })).status).toBe(200);
  expect((await owner.request(overflow, { method:"PUT", body:{branch:"b100",require_pull_request:true} })).status).toBe(200);
});

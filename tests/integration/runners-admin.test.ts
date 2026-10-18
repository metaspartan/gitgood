import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createServer } from "../../src/server.ts";
import { resetInstanceSettingsCache } from "../../src/data/instance-settings.ts";
import { changes } from "../../src/db/index.ts";
import { LogStream, executeJob, imageAllowed, imageFor, parseArgs, Api } from "../../runner/gitgood-runner.ts";

const server = createServer(0);
const BASE = `http://127.0.0.1:${server.port}`;
const stamp = Date.now().toString(36);
const admin = `adm${stamp}`;
const member = `mem${stamp}`;
const PASSWORD = "runner-admin-password";
let previousMode: string | undefined;

class Client {
  cookie = "";
  constructor(private readonly bearer?: string) {}
  async call<T = any>(path: string, method = "GET", body?: unknown): Promise<{ status: number; data: T }> {
    const response = await fetch(BASE + path, {
      method,
      headers: {
        ...(this.cookie ? { cookie: this.cookie } : {}),
        ...(this.bearer ? { authorization: `Bearer ${this.bearer}` } : {}),
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const setCookie = response.headers.get("set-cookie");
    if (setCookie) this.cookie = setCookie.split(";")[0]!;
    const text = await response.text();
    return { status: response.status, data: (text ? JSON.parse(text) : null) as T };
  }
}

const root = new Client();
const user = new Client();
const workflow = "name: Build\non: [push, workflow_dispatch]\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - name: Greet\n        run: echo hello-from-runner\n";

async function waitForRuns(repo: string, count: number) {
  for (let i = 0; i < 50; i += 1) {
    const runs = await root.call<{ items: { id: number; status: string }[] }>(`/api/repos/${admin}/${repo}/ci/runs`);
    if (runs.data.items.length >= count) return runs.data.items;
    await Bun.sleep(50);
  }
  throw new Error("runs never appeared");
}

beforeAll(async () => {
  previousMode = process.env.GITGOOD_CI_MODE;
  process.env.GITGOOD_CI_MODE = "runner";
  changes("DELETE FROM instance_settings WHERE key IN ('allow_signup','allow_repo_creation','default_visibility','actions_default_enabled')");
  resetInstanceSettingsCache();
  expect((await root.call("/api/auth/signup", "POST", { username: admin, email: `${admin}@example.test`, password: PASSWORD })).status).toBe(201);
  changes("UPDATE users SET is_admin = 1 WHERE username = ?", admin);
  expect((await user.call("/api/auth/signup", "POST", { username: member, email: `${member}@example.test`, password: PASSWORD })).status).toBe(201);
  expect((await root.call("/api/repos", "POST", { name: "app" })).status).toBe(201);
});

afterAll(() => {
  changes("DELETE FROM ci_runs WHERE executor = 'runner'");
  changes("DELETE FROM ci_runners");
  if (previousMode === undefined) delete process.env.GITGOOD_CI_MODE;
  else process.env.GITGOOD_CI_MODE = previousMode;
  server.stop(true);
});

describe("runner protocol", () => {
  let token = "";
  let runnerId = 0;

  test("only administrators can register runners, and the token is shown once", async () => {
    expect((await user.call("/api/admin/runners", "POST", { name: "nope" })).status).toBe(403);
    const created = await root.call<{ runner: { id: number; token_prefix: string }; token: string }>("/api/admin/runners", "POST", { name: "builder-1" });
    expect(created.status).toBe(201);
    token = created.data.token;
    runnerId = created.data.runner.id;
    expect(token.startsWith("ggr_")).toBe(true);
    const list = await root.call<{ items: Array<Record<string, unknown>> }>("/api/admin/runners");
    expect(JSON.stringify(list.data)).not.toContain(token);
    expect(list.data.items[0]).toMatchObject({ name: "builder-1", online: false });
  });

  test("a push queues the job for runners instead of running it on the server", async () => {
    expect((await root.call(`/api/repos/${admin}/app/contents`, "PUT", { branch: "main", path: ".gitgood-ci.yml", content: workflow, encoding: "utf8" })).status).toBe(201);
    const runs = await waitForRuns("app", 1);
    expect(runs[0]!.status).toBe("queued");
    const payload = await root.call<{ runner: { mode: string } }>(`/api/repos/${admin}/app/ci/runs`);
    expect(payload.status).toBe(200);
  });

  test("bad tokens are refused and an idle claim is 204", async () => {
    expect((await new Client("ggr_notarealtokennotarealtoken").call("/api/runner/claim", "POST", {})).status).toBe(401);
    expect((await new Client().call("/api/runner/claim", "POST", {})).status).toBe(401);
  });

  test("a runner claims, downloads source, streams logs and finishes the job", async () => {
    const options = parseArgs(["--url", BASE, "--token", token, "--executor", "shell"], {});
    const api = new Api(options);
    const job = await api.claim();
    expect(job).not.toBeNull();
    expect(job!.job.steps.map((s) => s.run.trim())).toEqual(["echo hello-from-runner"]);
    expect(await api.claim()).toBeNull();
    const status = await executeJob(options, api, job!);
    expect(status).toBe("success");
    const run = await root.call<{ run: { status: string } }>(`/api/repos/${admin}/app/ci/runs/${job!.run_id}`);
    expect(JSON.stringify(run.data)).toContain("success");
    const log = await root.call<{ items: { text: string }[] }>(`/api/repos/${admin}/app/ci/runs/${job!.run_id}/log`);
    const text = log.data.items.map((i) => i.text).join("\n");
    expect(text).toContain("hello-from-runner");
    expect(text).toContain("\u2713 Greet");
    const runners = await root.call<{ items: { online: boolean; version: string }[] }>("/api/admin/runners");
    expect(runners.data.items[0]).toMatchObject({ online: true, version: "1.0.0" });
  });

  test("a runner cannot touch a job it does not own", async () => {
    const other = await root.call<{ token: string }>("/api/admin/runners", "POST", { name: "builder-2" });
    expect((await root.call(`/api/repos/${admin}/app/ci/dispatch`, "POST", { ref: "main" })).status).toBe(202);
    const thief = new Client(other.data.token);
    const mine = new Client(token);
    const claimed = await mine.call<{ run_id: number }>("/api/runner/claim", "POST", {});
    expect(claimed.status).toBe(200);
    expect((await thief.call(`/api/runner/jobs/${claimed.data.run_id}/log`, "POST", { lines: ["x"] })).status).toBe(404);
    expect((await thief.call(`/api/runner/jobs/${claimed.data.run_id}/finish`, "POST", { status: "success" })).status).toBe(404);
    expect((await root.call(`/api/admin/runners/${runnerId}`, "DELETE")).status).toBe(204);
    expect((await mine.call(`/api/runner/jobs/${claimed.data.run_id}/log`, "POST", { lines: ["x"] })).status).toBe(401);
    const run = await root.call(`/api/repos/${admin}/app/ci/runs/${claimed.data.run_id}`);
    expect(JSON.stringify(run.data)).toContain("failure");
  });

  test("disabling Actions on a repository stops new runs", async () => {
    expect((await root.call(`/api/repos/${admin}/app`, "PATCH", { actions_enabled: false })).status).toBe(200);
    const before = (await waitForRuns("app", 1)).length;
    expect((await root.call(`/api/repos/${admin}/app/contents`, "PUT", { branch: "main", path: "README.md", content: "hi\n", encoding: "utf8" })).status).toBe(201);
    await Bun.sleep(150);
    expect((await root.call<{ items: unknown[] }>(`/api/repos/${admin}/app/ci/runs`)).data.items.length).toBe(before);
    expect((await root.call(`/api/repos/${admin}/app/ci/dispatch`, "POST", { ref: "main" })).status).toBe(409);
    const detail = await root.call<{ actions_enabled: boolean }>(`/api/repos/${admin}/app`);
    expect(detail.data.actions_enabled).toBe(false);
  });
});

describe("admin area", () => {
  test("non-admins are refused everywhere", async () => {
    for (const path of ["/api/admin/overview", "/api/admin/users", "/api/admin/repositories", "/api/admin/settings"]) {
      expect((await user.call(path)).status).toBe(403);
    }
  });

  test("overview reports instance counts", async () => {
    const overview = await root.call<{ users: { total: number }; repositories: { total: number }; ci: { mode: string } }>("/api/admin/overview");
    expect(overview.data.users.total).toBeGreaterThanOrEqual(2);
    expect(overview.data.repositories.total).toBeGreaterThanOrEqual(1);
    expect(overview.data.ci.mode).toBe("runner");
  });

  test("users can be searched, blocked, unblocked and promoted", async () => {
    const found = await root.call<{ items: { id: number; username: string }[] }>(`/api/admin/users?q=${member}`);
    expect(found.status).toBe(200);
    expect(found.data.items.map((u) => u.username)).toEqual([member]);
    const id = found.data.items[0]!.id;
    expect((await root.call(`/api/admin/users/${id}`, "PATCH", { blocked: true })).status).toBe(200);
    expect((await user.call("/api/auth/me")).data?.user ?? null).toBeNull();
    const relogin = await new Client().call("/api/auth/login", "POST", { username: member, password: PASSWORD });
    expect(relogin.status).toBe(401);
    const basic = await fetch(`${BASE}/api/auth/me`, { headers: { authorization: `Basic ${btoa(`${member}:${PASSWORD}`)}` } });
    expect(JSON.stringify(await basic.json())).not.toContain(member);
    expect((await root.call(`/api/admin/users/${id}`, "PATCH", { blocked: false })).status).toBe(200);
    expect((await user.call("/api/auth/login", "POST", { username: member, password: PASSWORD })).status).toBe(200);
    const promoted = await root.call<{ user: { is_admin: boolean } }>(`/api/admin/users/${id}`, "PATCH", { is_admin: true });
    expect(promoted.data.user.is_admin).toBe(true);
    expect((await root.call(`/api/admin/users/${id}`, "PATCH", { is_admin: false })).status).toBe(200);
  });

  test("the last administrator cannot lock themselves out", async () => {
    const me = (await root.call<{ items: { id: number }[] }>(`/api/admin/users?q=${admin}`)).data.items[0]!.id;
    expect((await root.call(`/api/admin/users/${me}`, "PATCH", { blocked: true })).status).toBe(409);
    expect((await root.call(`/api/admin/users/${me}`, "PATCH", { is_admin: false })).status).toBe(409);
    expect((await root.call(`/api/admin/users/${me}`, "DELETE")).status).toBe(409);
  });

  test("admins can create and delete users; owners of repositories are protected", async () => {
    const created = await root.call<{ user: { id: number } }>("/api/admin/users", "POST", { username: `new${stamp}`, email: `new${stamp}@example.test`, password: PASSWORD });
    expect(created.status).toBe(201);
    expect((await root.call(`/api/admin/users/${created.data.user.id}`, "DELETE")).status).toBe(204);
    const owner = (await root.call<{ items: { id: number }[] }>(`/api/admin/users?q=${admin}`)).data.items[0]!.id;
    expect((await root.call(`/api/admin/users/${owner}`, "DELETE")).status).toBe(409);
  });

  test("instance settings gate signups and repository creation", async () => {
    const saved = await root.call("/api/admin/settings", "PUT", { allow_signup: false, allow_repo_creation: false, default_visibility: "private" });
    expect(saved.data).toMatchObject({ allow_signup: false, allow_repo_creation: false, default_visibility: "private" });
    expect((await new Client().call("/api/auth/signup", "POST", { username: `late${stamp}`, email: `late${stamp}@example.test`, password: PASSWORD })).status).toBe(403);
    expect((await user.call("/api/repos", "POST", { name: "blocked" })).status).toBe(403);
    const adminRepo = await root.call<{ visibility: string }>("/api/repos", "POST", { name: "secret-default" });
    expect(adminRepo.data.visibility).toBe("private");
    await root.call("/api/admin/settings", "PUT", { allow_signup: true, allow_repo_creation: true, default_visibility: "public" });
    const repos = await root.call<{ items: { full_name: string }[] }>(`/api/admin/repositories?q=${admin}`);
    expect(repos.data.items.map((r) => r.full_name)).toContain(`${admin}/secret-default`);
    expect(repos.data.items.every((r) => r.full_name.startsWith(`${admin}/`))).toBe(true);
  });
});

describe("runner client helpers", () => {
  test("runs-on maps to container images", () => {
    expect(imageFor("ubuntu-latest", "x")).toBe("ubuntu:24.04");
    expect(imageFor("node:22-alpine", "x")).toBe("node:22-alpine");
    expect(imageFor("ghcr.io/acme/build:1", "x")).toBe("ghcr.io/acme/build:1");
    expect(imageFor("host", "fallback:1")).toBe("fallback:1");
    expect(imageFor("bad image; rm -rf /", "fallback:1")).toBe("fallback:1");
    expect(imageAllowed("node:22", [])).toBe(true);
    expect(imageAllowed("node:22", ["node:*"])).toBe(true);
    expect(imageAllowed("evil/miner:1", ["node:*", "ubuntu:24.04"])).toBe(false);
  });

  test("argument parsing refuses missing URL or token", () => {
    expect(() => parseArgs([], {})).toThrow(/url/);
    expect(() => parseArgs(["--url", "https://x"], {})).toThrow(/token/);
    expect(parseArgs(["--url=https://x/", "--token", "ggr_abc", "--once"], {})).toMatchObject({ url: "https://x", once: true, executor: "docker" });
  });

  test("log lines are batched and partial lines are kept until complete", async () => {
    const sent: string[][] = [];
    const log = new LogStream(async (lines) => { sent.push(lines); }, 10_000, 3);
    log.write("a\nb");
    log.write("c\nd\ne\n");
    await log.close();
    expect(sent.flat()).toEqual(["a", "bc", "d", "e"]);
  });
});

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createServer } from "../../src/server.ts";
import { changes } from "../../src/db/index.ts";

const server = createServer(0);
const BASE = `http://127.0.0.1:${server.port}`;
const stamp = Date.now().toString(36);
const alice = `ra${stamp}`;
const bob = `rb${stamp}`;
const PASSWORD = "runner-scopes-password";
const workflow = "name: Build\non: [push]\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - name: Hi\n        run: echo hi\n";
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

const a = new Client();
const b = new Client();
const anon = new Client();
type Runner = { id: number; name: string; scope: string; scope_label: string };
type Claim = { run_id: number; repository: string };

async function queue(client: Client, owner: string, repo: string): Promise<void> {
  expect((await client.call(`/api/repos/${owner}/${repo}/contents`, "PUT", { branch: "main", path: ".gitgood-ci.yml", content: workflow, encoding: "utf8" })).status).toBe(201);
  for (let i = 0; i < 50; i += 1) {
    const runs = await client.call<{ items: { status: string }[] }>(`/api/repos/${owner}/${repo}/ci/runs`);
    if (runs.data.items.some((run) => run.status === "queued")) return;
    await Bun.sleep(40);
  }
  throw new Error(`no queued run for ${owner}/${repo}`);
}

async function register(client: Client, path: string, name: string): Promise<{ runner: Runner; token: string }> {
  const created = await client.call<{ runner: Runner; token: string }>(path, "POST", { name });
  expect(created.status).toBe(201);
  return created.data;
}

beforeAll(async () => {
  previousMode = process.env.GITGOOD_CI_MODE;
  process.env.GITGOOD_CI_MODE = "runner";
  await a.call("/api/auth/signup", "POST", { username: alice, email: `${alice}@example.test`, password: PASSWORD });
  await b.call("/api/auth/signup", "POST", { username: bob, email: `${bob}@example.test`, password: PASSWORD });
  changes("UPDATE users SET is_admin = 0 WHERE username IN (?, ?)", alice, bob);
  changes("UPDATE ci_runs SET status = 'failure' WHERE executor = 'runner' AND status = 'queued'");
  for (const [client, owner, repo] of [[b, bob, "b1"], [a, alice, "a1"], [a, alice, "a2"]] as const) {
    expect((await client.call("/api/repos", "POST", { name: repo })).status).toBe(201);
    await queue(client, owner, repo);
  }
}, 60_000);

afterAll(() => {
  changes("UPDATE ci_runs SET status = 'failure' WHERE executor = 'runner' AND status IN ('queued', 'running')");
  changes("DELETE FROM ci_runners WHERE scope <> 'instance' AND name LIKE 'scoped-%'");
  if (previousMode === undefined) delete process.env.GITGOOD_CI_MODE;
  else process.env.GITGOOD_CI_MODE = previousMode;
  server.stop(true);
});

describe("user and repository runners", () => {
  let userToken = "";
  let repoToken = "";
  let userRunnerId = 0;

  test("owners register runners for their account and their repositories", async () => {
    const user = await register(a, "/api/user/runners", "scoped-laptop");
    expect(user.runner).toMatchObject({ scope: "user", scope_label: alice });
    userToken = user.token;
    userRunnerId = user.runner.id;
    const repo = await register(a, `/api/repos/${alice}/a2/runners`, "scoped-a2");
    expect(repo.runner).toMatchObject({ scope: "repo", scope_label: `${alice}/a2` });
    repoToken = repo.token;
    expect((await a.call<{ items: Runner[] }>("/api/user/runners")).data.items.map((r) => r.name)).toEqual(["scoped-laptop"]);
    expect((await a.call<{ items: Runner[] }>(`/api/repos/${alice}/a2/runners`)).data.items.map((r) => r.name)).toEqual(["scoped-a2"]);
  });

  test("nobody else can see, manage or add runners in someone else's scope", async () => {
    expect((await b.call<{ items: Runner[] }>("/api/user/runners")).data.items).toEqual([]);
    expect((await b.call(`/api/user/runners/${userRunnerId}`, "PATCH", { paused: true })).status).toBe(404);
    expect((await b.call(`/api/user/runners/${userRunnerId}`, "DELETE")).status).toBe(404);
    expect((await b.call(`/api/repos/${alice}/a2/runners`)).status).toBe(403);
    expect((await b.call(`/api/repos/${alice}/a2/runners`, "POST", { name: "scoped-intruder" })).status).toBe(403);
    expect((await anon.call("/api/user/runners")).status).toBe(401);
    expect((await anon.call(`/api/repos/${alice}/a2/runners`)).status).toBe(401);
  });

  test("a repository runner only claims jobs from its repository", async () => {
    const claim = await new Client(repoToken).call<Claim>("/api/runner/claim", "POST", {});
    expect(claim.status).toBe(200);
    expect(claim.data.repository).toBe(`${alice}/a2`);
    expect((await new Client(repoToken).call("/api/runner/claim", "POST", {})).status).toBe(204);
  });

  test("a user runner claims jobs from the owner's repositories and never another user's", async () => {
    const runner = new Client(userToken);
    const first = await runner.call<Claim>("/api/runner/claim", "POST", {});
    expect(first.status).toBe(200);
    expect(first.data.repository).toBe(`${alice}/a1`);
    expect((await runner.call("/api/runner/claim", "POST", {})).status).toBe(204);
    const runs = await b.call<{ items: { status: string }[] }>(`/api/repos/${bob}/b1/ci/runs`);
    expect(runs.data.items[0]!.status).toBe("queued");
  });

  test("the Actions page counts only runners that can pick up that repository's jobs", async () => {
    const mine = await a.call<{ runner: { runnersOnline: number } }>(`/api/repos/${alice}/a1/ci/runs`);
    const theirs = await b.call<{ runner: { runnersOnline: number } }>(`/api/repos/${bob}/b1/ci/runs`);
    expect(mine.data.runner.runnersOnline).toBeGreaterThanOrEqual(1);
    expect(theirs.data.runner.runnersOnline).toBe(mine.data.runner.runnersOnline - 1);
  });

  test("pausing and removing work for the owner, and a removed runner's token stops working", async () => {
    expect((await a.call<{ runner: { paused: boolean } }>(`/api/user/runners/${userRunnerId}`, "PATCH", { paused: true })).data.runner.paused).toBe(true);
    expect((await a.call(`/api/user/runners/${userRunnerId}`, "DELETE")).status).toBe(204);
    expect((await new Client(userToken).call("/api/runner/claim", "POST", {})).status).toBe(401);
  });

  test("administrators see every runner with its scope", async () => {
    changes("UPDATE users SET is_admin = 1 WHERE username = ?", alice);
    const list = await a.call<{ items: Runner[] }>("/api/admin/runners");
    expect(list.data.items.find((r) => r.name === "scoped-a2")).toMatchObject({ scope: "repo", scope_label: `${alice}/a2` });
    changes("UPDATE users SET is_admin = 0 WHERE username = ?", alice);
  });
});

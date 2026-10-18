import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "../../src/server.ts";
import { git } from "../../src/git/run.ts";

const scratch = mkdtempSync(join(tmpdir(), "gg-http-test-"));
const server = createServer(0);
const BASE = `http://127.0.0.1:${server.port}`;
const run = Date.now().toString(36);
const identity = ["-c", "user.name=Http", "-c", "user.email=http@example.com"];

afterAll(async () => {
  await server.stop(true);
  rmSync(scratch, { recursive: true, force: true });
});

class Client {
  cookie = "";

  async request<T>(
    path: string,
    options: { method?: string; body?: unknown; token?: string } = {},
  ): Promise<{ status: number; data: T }> {
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

const user = new Client();
const username = `http${run}`;
const password = "supersecret123";
let token = "";

interface RepoJson {
  full_name: string;
  visibility: string;
  description: string;
  permissions?: { read: boolean; write: boolean };
}

beforeAll(async () => {
  const signup = await user.request<{ user: { username: string } }>("/api/auth/signup", {
    method: "POST",
    body: { username, email: `${username}@example.com`, password },
  });
  expect(signup.status).toBe(201);
  const created = await user.request<{ token: string }>("/api/tokens", { method: "POST", body: { name: "ci" } });
  token = created.data.token;
});

describe("web app", () => {
  test("serves a bundled SPA shell with absolute asset URLs", async () => {
    const response = await fetch(`${BASE}/`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    const html = await response.text();
    expect(html).toContain("GitGood");
    expect(html).toContain('src="/_assets/');
    expect(html).toContain('href="/_assets/');
    expect(html).not.toContain('src="./');
  });

  test("serves the bundled JavaScript with immutable caching", async () => {
    const shell = await (await fetch(`${BASE}/`)).text();
    const match = /src="\/_assets\/([^"]+)"/.exec(shell);
    expect(match).not.toBeNull();
    const response = await fetch(`${BASE}/_assets/${match?.[1]}`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("javascript");
    expect(response.headers.get("cache-control")).toContain("immutable");
    const etag = response.headers.get("etag");
    expect(etag).toBeTruthy();
    expect((await response.text()).length).toBeGreaterThan(1000);

    const revalidated = await fetch(`${BASE}/_assets/${match?.[1]}`, {
      headers: { "if-none-match": etag ?? "" },
    });
    expect(revalidated.status).toBe(304);
  });

  test("deep links return the same shell so client routing works", async () => {
    const response = await fetch(`${BASE}/${username}/some-repo/issues/42`);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("GitGood");
  });

  test("asset traversal attempts are rejected", async () => {
    const response = await fetch(`${BASE}/_assets/..%2F..%2Fpackage.json`);
    expect([200, 404]).toContain(response.status);
    if (response.status === 200) {
      expect(await response.text()).toContain("GitGood");
    }
  });
});

describe("system endpoints", () => {
  test("health reports the database as ok", async () => {
    const response = await user.request<{ status: string; database: string }>("/api/health");
    expect(response.status).toBe(200);
    expect(response.data.status).toBe("ok");
  });

  test("version reports the runtime and git", async () => {
    const response = await user.request<{ bun: string; git: string }>("/api/version");
    expect(response.data.bun).toBeTruthy();
    expect(response.data.git).toContain("git version");
  });

  test("metrics are exposed in prometheus format", async () => {
    const response = await fetch(`${BASE}/api/metrics`);
    expect(response.headers.get("content-type")).toContain("text/plain");
    expect(await response.text()).toContain("http_requests_total");
  });

  test("unknown endpoints return a structured 404", async () => {
    const response = await user.request<{ error: { code: string } }>("/api/nope");
    expect(response.status).toBe(404);
    expect(response.data.error.code).toBe("not_found");
  });
});

describe("authentication", () => {
  test("a wrong password is rejected", async () => {
    const response = await user.request("/api/auth/login", {
      method: "POST",
      body: { username, password: "wrong-password" },
    });
    expect(response.status).toBe(401);
  });

  test("a duplicate username is a conflict", async () => {
    const response = await user.request("/api/auth/signup", {
      method: "POST",
      body: { username, email: `other-${username}@example.com`, password },
    });
    expect(response.status).toBe(409);
  });

  test("me returns the authenticated user", async () => {
    const response = await user.request<{ user: { username: string } | null }>("/api/auth/me");
    expect(response.data.user?.username).toBe(username);
  });

  test("tokens cannot be listed without authentication", async () => {
    const anon = new Client();
    const response = await anon.request("/api/tokens");
    expect(response.status).toBe(401);
  });

  test("logout clears the session", async () => {
    const temp = new Client();
    await temp.request("/api/auth/login", { method: "POST", body: { username, password } });
    expect((await temp.request<{ user: unknown }>("/api/auth/me")).data.user).not.toBeNull();
    await temp.request("/api/auth/logout", { method: "POST", body: {} });
    expect((await temp.request<{ user: unknown }>("/api/auth/me")).data.user).toBeNull();
  });
});

describe("repository API", () => {
  test("creates a repository and reports permissions", async () => {
    const created = await user.request<RepoJson>("/api/repos", {
      method: "POST",
      body: { name: "web", description: "web repo" },
    });
    expect(created.status).toBe(201);

    const detail = await user.request<RepoJson>(`/api/repos/${username}/web`);
    expect(detail.data.permissions?.write).toBe(true);

    const anon = new Client();
    const anonDetail = await anon.request<RepoJson>(`/api/repos/${username}/web`);
    expect(anonDetail.data.permissions?.write).toBe(false);
  });

  test("rejects duplicate names and invalid names", async () => {
    expect(
      (await user.request("/api/repos", { method: "POST", body: { name: "web" } })).status,
    ).toBe(409);
    expect(
      (await user.request("/api/repos", { method: "POST", body: { name: "bad name!" } })).status,
    ).toBe(409);
  });

  test("validates the request body", async () => {
    const response = await user.request<{ error: { code: string } }>("/api/repos", {
      method: "POST",
      body: { name: "ok", unexpected: true },
    });
    expect(response.status).toBe(400);
    expect(response.data.error.code).toBe("bad_request");
  });

  test("updates and lists repositories", async () => {
    const updated = await user.request<RepoJson>(`/api/repos/${username}/web`, {
      method: "PATCH",
      body: { description: "updated", visibility: "private" },
    });
    expect(updated.data.description).toBe("updated");
    expect(updated.data.visibility).toBe("private");

    const list = await user.request<{ items: RepoJson[] }>("/api/repos");
    expect(list.data.items.some((repo) => repo.full_name === `${username}/web`)).toBe(true);
  });
});

describe("git smart HTTP", () => {
  const workRepo = join(scratch, "work");
  const cloneTarget = join(scratch, "clone");
  const authedUrl = (repo: string, password = token): string =>
    `${BASE.replace("http://", `http://${username}:${password}@`)}/${username}/${repo}.git`;

  test("pushes, clones and reads back content", async () => {
    await user.request("/api/repos", { method: "POST", body: { name: "git" } });

    mkdirSync(workRepo, { recursive: true });
    await git(["init", "-q", "-b", "main", workRepo], { cwd: workRepo });
    await git(["remote", "add", "origin", authedUrl("git")], { cwd: workRepo });
    writeFileSync(join(workRepo, "README.md"), "# over http\n");
    mkdirSync(join(workRepo, "lib"), { recursive: true });
    writeFileSync(join(workRepo, "lib", "index.ts"), "export const value = 1;\n");
    await git(["add", "."], { cwd: workRepo });
    await git([...identity, "commit", "-q", "-m", "commit over http"], { cwd: workRepo });

    const push = await git(["push", "-q", "origin", "main"], { cwd: workRepo });
    expect(push.exitCode).toBe(0);

    const clone = await git(["clone", "-q", `${BASE}/${username}/git.git`, cloneTarget], { cwd: scratch });
    expect(clone.exitCode).toBe(0);
    expect(readFileSync(join(cloneTarget, "lib", "index.ts"), "utf8")).toContain("value = 1");
  }, 60_000);

  test("exposes refs, commits, trees and blobs through the API", async () => {
    const branches = await user.request<{ items: Array<{ name: string }> }>(`/api/repos/${username}/git/branches`);
    expect(branches.data.items.map((b) => b.name)).toContain("main");

    const commits = await user.request<{ items: Array<{ message: string }> }>(`/api/repos/${username}/git/commits`);
    expect(commits.data.items[0]?.message).toBe("commit over http");

    const tree = await user.request<{ items: Array<{ name: string; type: string }> }>(
      `/api/repos/${username}/git/tree`,
    );
    expect(tree.data.items.some((entry) => entry.name === "lib" && entry.type === "tree")).toBe(true);

    const blob = await user.request<{ content: string }>(
      `/api/repos/${username}/git/blob?path=README.md&ref=main`,
    );
    expect(blob.data.content).toContain("over http");

    const nested = await user.request<{ items: Array<{ name: string }> }>(
      `/api/repos/${username}/git/tree?path=lib`,
    );
    expect(nested.data.items.map((entry) => entry.name)).toEqual(["index.ts"]);

    const raw = await fetch(`${BASE}/api/repos/${username}/git/raw?path=README.md`);
    expect(raw.headers.get("content-type")).toContain("text/plain");
    expect(await raw.text()).toContain("over http");
  });

  test("read-only tokens can fetch but not push", async () => {
    const readOnly = await user.request<{ token: string }>("/api/tokens", {
      method: "POST",
      body: { name: "readonly", scopes: ["read"] },
    });
    const readRemote = authedUrl("git", readOnly.data.token);

    const fetchOnly = await git(["ls-remote", readRemote], { cwd: scratch });
    expect(fetchOnly.exitCode).toBe(0);

    const pushAttempt = await git(["push", "-q", readRemote, "main", "--force"], {
      cwd: workRepo,
      allowFailure: true,
    });
    expect(pushAttempt.exitCode).not.toBe(0);
    expect(pushAttempt.stderr).toContain("403");
  });

  test("private repositories require authentication to fetch", async () => {
    await user.request("/api/repos", { method: "POST", body: { name: "private-repo", visibility: "private" } });
    const denied = await fetch(`${BASE}/${username}/private-repo.git/info/refs?service=git-upload-pack`);
    expect(denied.status).toBe(401);
    expect(denied.headers.get("www-authenticate")).toContain("Basic");

    const allowed = await fetch(`${BASE}/${username}/private-repo.git/info/refs?service=git-upload-pack`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(allowed.status).toBe(200);
  });

  test("missing repositories 404 instead of erroring", async () => {
    const response = await fetch(`${BASE}/${username}/does-not-exist.git/info/refs?service=git-upload-pack`);
    expect(response.status).toBe(404);
  });
});

describe("issues and pull requests", () => {
  test("issue lifecycle with comments and labels", async () => {
    const created = await user.request<{ number: number; state: string; labels: string[] }>(
      `/api/repos/${username}/git/issues`,
      { method: "POST", body: { title: "Bug report", body: "steps", labels: ["bug", "triage"] } },
    );
    expect(created.status).toBe(201);
    expect(created.data.number).toBe(1);
    expect(created.data.labels.sort()).toEqual(["bug", "triage"]);

    const comment = await user.request<{ id: number }>(`/api/repos/${username}/git/issues/1/comments`, {
      method: "POST",
      body: { body: "looking into it" },
    });
    expect(comment.status).toBe(201);

    const detail = await user.request<{ comment_count: number }>(`/api/repos/${username}/git/issues/1`);
    expect(detail.data.comment_count).toBe(1);

    const closed = await user.request<{ state: string; closed_at: number | null }>(
      `/api/repos/${username}/git/issues/1`,
      { method: "PATCH", body: { state: "closed" } },
    );
    expect(closed.data.state).toBe("closed");
    expect(closed.data.closed_at).toBeGreaterThan(0);

    const open = await user.request<{ total: number }>(`/api/repos/${username}/git/issues?state=open`);
    expect(open.data.total).toBe(0);
  });

  test("issues are numbered sequentially per repository", async () => {
    const second = await user.request<{ number: number }>(`/api/repos/${username}/git/issues`, {
      method: "POST",
      body: { title: "Second" },
    });
    expect(second.data.number).toBe(2);
  });

  test("pull requests merge through the API", async () => {
    const workRepo = join(scratch, "work");
    await git(["checkout", "-q", "-b", "feature"], { cwd: workRepo });
    writeFileSync(join(workRepo, "feature.md"), "feature\n");
    await git(["add", "."], { cwd: workRepo });
    await git([...identity, "commit", "-q", "-m", "feature work"], { cwd: workRepo });
    expect((await git(["push", "-q", "origin", "feature"], { cwd: workRepo })).exitCode).toBe(0);
    await git(["checkout", "-q", "main"], { cwd: workRepo });

    const pull = await user.request<{ number: number; state: string }>(`/api/repos/${username}/git/pulls`, {
      method: "POST",
      body: { title: "Add feature", head: "feature", base: "main" },
    });
    expect(pull.status).toBe(201);

    const files = await user.request<{ stats: { files_changed: number } }>(
      `/api/repos/${username}/git/pulls/${pull.data.number}/files`,
    );
    expect(files.data.stats.files_changed).toBeGreaterThan(0);

    const merged = await user.request<{ merged: boolean; sha: string }>(
      `/api/repos/${username}/git/pulls/${pull.data.number}/merge`,
      { method: "POST", body: {} },
    );
    expect(merged.data.merged).toBe(true);

    const tree = await user.request<{ items: Array<{ name: string }> }>(`/api/repos/${username}/git/tree`);
    expect(tree.data.items.map((entry) => entry.name)).toContain("feature.md");

    const again = await user.request(`/api/repos/${username}/git/pulls/${pull.data.number}/merge`, {
      method: "POST",
      body: {},
    });
    expect(again.status).toBe(409);
  });

  test("pull requests against unknown branches are rejected", async () => {
    const response = await user.request(`/api/repos/${username}/git/pulls`, {
      method: "POST",
      body: { title: "Nope", head: "ghost", base: "main" },
    });
    expect(response.status).toBe(422);
  });
});

describe("git lfs", () => {
  const content = `lfs-content-${run}`;
  const oid = new Bun.CryptoHasher("sha256").update(content).digest("hex");
  const lfsBase = `${BASE}/${username}/git.git/info/lfs`;

  test("upload, batch download and verify metadata", async () => {
    const batch = await user.request<{ objects: Array<{ actions?: { upload?: { href: string } } }> }>(
      `/${username}/git.git/info/lfs/objects/batch`,
      { method: "POST", body: { operation: "upload", transfers: ["basic"], objects: [{ oid, size: content.length }] } },
    );
    const href = batch.data.objects[0]?.actions?.upload?.href;
    expect(href).toBeTruthy();

    const upload = await fetch(href ?? "", {
      method: "PUT",
      headers: { authorization: `Bearer ${token}` },
      body: content,
    });
    expect(upload.status).toBe(200);

    const download = await user.request<{ objects: Array<{ actions?: { download?: { href: string } } }> }>(
      `/${username}/git.git/info/lfs/objects/batch`,
      { method: "POST", body: { operation: "download", transfers: ["basic"], objects: [{ oid, size: content.length }] } },
    );
    const downloadHref = download.data.objects[0]?.actions?.download?.href;
    expect(downloadHref).toBeTruthy();

    const fetched = await fetch(downloadHref ?? "", { headers: { authorization: `Bearer ${token}` } });
    expect(await fetched.text()).toBe(content);

    const verify = await fetch(`${lfsBase}/objects/verify`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/vnd.git-lfs+json" },
      body: JSON.stringify({ oid, size: content.length }),
    });
    expect(verify.status).toBe(200);
  });

  test("deduplicates identical objects", async () => {
    const count = async () => (await user.request<{ lfs: { objects: number } }>("/api/stats")).data.lfs.objects;
    const before = await count();
    const batch = await user.request<{ objects: Array<{ actions?: { upload?: { href: string } } }> }>(
      `/${username}/git.git/info/lfs/objects/batch`,
      { method: "POST", body: { operation: "upload", transfers: ["basic"], objects: [{ oid, size: content.length }] } },
    );
    const href = batch.data.objects[0]?.actions?.upload?.href;
    if (href) {
      const upload = await fetch(href, { method: "PUT", headers: { authorization: `Bearer ${token}` }, body: content });
      expect(upload.status).toBe(200);
    }
    expect(await count()).toBe(before);
  });

  test("rejects content whose hash does not match the oid", async () => {
    const response = await fetch(`${lfsBase}/objects/${"a".repeat(64)}`, {
      method: "PUT",
      headers: { authorization: `Bearer ${token}` },
      body: "not the declared content",
    });
    expect(response.status).toBe(422);
  });

  test("download requests for missing objects report a per-object error", async () => {
    const response = await user.request<{ objects: Array<{ error?: { code: number } }> }>(
      `/${username}/git.git/info/lfs/objects/batch`,
      {
        method: "POST",
        body: {
          operation: "download",
          transfers: ["basic"],
          objects: [{ oid: "b".repeat(64), size: 10 }],
        },
      },
    );
    expect(response.data.objects[0]?.error?.code).toBe(404);
  });

  test("locks can be created, listed and released", async () => {
    const created = await fetch(`${lfsBase}/locks`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/vnd.git-lfs+json" },
      body: JSON.stringify({ path: "assets/logo.psd" }),
    });
    expect(created.status).toBe(201);
    const lock = (await created.json()) as { lock: { id: string; path: string } };
    expect(lock.lock.path).toBe("assets/logo.psd");

    const listed = await user.request<{ locks: Array<{ path: string }> }>(`/${username}/git.git/info/lfs/locks`);
    expect(listed.data.locks).toHaveLength(1);

    const released = await fetch(`${lfsBase}/locks/${lock.lock.id}/unlock`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/vnd.git-lfs+json" },
      body: JSON.stringify({}),
    });
    expect(released.status).toBe(200);
    const after = await user.request<{ locks: unknown[] }>(`/${username}/git.git/info/lfs/locks`);
    expect(after.data.locks).toHaveLength(0);
  });

  test("non-owners cannot read from a private repository", async () => {
    const owner = new Client();
    const ownerName = `owner${run}`;
    await owner.request("/api/auth/signup", {
      method: "POST",
      body: { username: ownerName, email: `${ownerName}@example.com`, password },
    });
    const ownerToken = await owner.request<{ token: string }>("/api/tokens", {
      method: "POST",
      body: { name: "owner" },
    });
    await owner.request("/api/repos", { method: "POST", body: { name: "locked", visibility: "private" } });

    const stranger = new Client();
    const strangerName = `stranger${run}`;
    await stranger.request("/api/auth/signup", {
      method: "POST",
      body: { username: strangerName, email: `${strangerName}@example.com`, password },
    });
    const strangerToken = await stranger.request<{ token: string }>("/api/tokens", {
      method: "POST",
      body: { name: "stranger" },
    });

    const batchUrl = `${BASE}/${ownerName}/locked.git/info/lfs/objects/batch`;
    const denied = await fetch(batchUrl, {
      method: "POST",
      headers: { authorization: `Bearer ${strangerToken.data.token}`, "content-type": "application/vnd.git-lfs+json" },
      body: JSON.stringify({ operation: "download", transfers: ["basic"], objects: [{ oid, size: 1 }] }),
    });
    expect(denied.status).toBe(403);

    const allowed = await fetch(batchUrl, {
      method: "POST",
      headers: { authorization: `Bearer ${ownerToken.data.token}`, "content-type": "application/vnd.git-lfs+json" },
      body: JSON.stringify({ operation: "upload", transfers: ["basic"], objects: [{ oid, size: content.length }] }),
    });
    expect(allowed.status).toBe(200);
  });
});

describe("webhooks", () => {
  test("registration is validated and secrets are never returned", async () => {
    const created = await user.request<{ id: number; events: string[] }>(`/api/repos/${username}/git/webhooks`, {
      method: "POST",
      body: { url: "https://example.com/hook", secret: "top-secret", events: ["push", "issues"] },
    });
    expect(created.status).toBe(201);
    expect(JSON.stringify(created.data)).not.toContain("top-secret");
    expect(created.data.events).toContain("push");

    const invalid = await user.request(`/api/repos/${username}/git/webhooks`, {
      method: "POST",
      body: { url: "not-a-url" },
    });
    expect(invalid.status).toBe(400);
  });
});

describe("search", () => {
  test("finds repositories, issues and pull requests", async () => {
    const repos = await user.request<{ repos: unknown[] }>("/api/search?q=web");
    expect(repos.data.repos.length).toBeGreaterThan(0);

    const issues = await user.request<{ issues: Array<{ title: string }> }>("/api/search?q=Bug");
    expect(issues.data.issues.some((issue) => issue.title === "Bug report")).toBe(true);

    const empty = await user.request<{ repos: unknown[] }>("/api/search?q=");
    expect(empty.data.repos).toHaveLength(0);
  });
});

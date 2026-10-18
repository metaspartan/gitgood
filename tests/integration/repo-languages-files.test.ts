import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createServer } from "../../src/server.ts";
import { fileListSlotsUsed } from "../../src/data/git-reads.ts";

const server = createServer(0);
const BASE = `http://127.0.0.1:${server.port}`;
const run = Date.now().toString(36);
const owner = `rlf${run}`;
const outsider = `rlo${run}`;
const PASSWORD = "repo-layout-password";

afterAll(() => server.stop(true));

class Client {
  cookie = "";
  async call<T>(path: string, init: { method?: string; body?: unknown; headers?: Record<string, string> } = {}) {
    const response = await fetch(BASE + path, {
      method: init.method ?? "GET",
      headers: {
        ...(this.cookie ? { cookie: this.cookie } : {}),
        ...(init.body === undefined ? {} : { "content-type": "application/json" }),
        ...init.headers,
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });
    const setCookie = response.headers.get("set-cookie");
    if (setCookie) this.cookie = setCookie.split(";")[0]!;
    const text = await response.text();
    return { status: response.status, etag: response.headers.get("etag"), data: (text ? JSON.parse(text) : null) as T };
  }
}

const me = new Client();
const stranger = new Client();

async function put(repo: string, path: string, content: string) {
  const result = await me.call(`/api/repos/${owner}/${repo}/contents`, {
    method: "PUT",
    body: { path, branch: "main", content, encoding: "utf8" },
  });
  expect(result.status).toBe(201);
}

beforeAll(async () => {
  await me.call("/api/auth/signup", { method: "POST", body: { username: owner, email: `${owner}@example.test`, password: PASSWORD } });
  await stranger.call("/api/auth/signup", { method: "POST", body: { username: outsider, email: `${outsider}@example.test`, password: PASSWORD } });
  await me.call("/api/repos", { method: "POST", body: { name: "app" } });
  await me.call("/api/repos", { method: "POST", body: { name: "secret", visibility: "private" } });
  await put("app", "src/main.ts", "export const value = 1;\n".repeat(40));
  await put("app", "scripts/build.sh", "echo hi\n".repeat(10));
  await put("app", "docs/guide.md", "# Guide\n");
  await put("secret", "hidden.ts", "export {};\n");
});

describe("languages", () => {
  test("code is attributed by language, docs are not counted", async () => {
    const result = await me.call<{ items: { name: string; percent: number }[]; sha: string }>(`/api/repos/${owner}/app/languages`);
    expect(result.status).toBe(200);
    expect(result.data.items.map((i) => i.name)).toEqual(["TypeScript", "Shell"]);
    expect(result.data.items[0]!.percent).toBeGreaterThan(90);
    expect(result.data.sha).toMatch(/^[0-9a-f]{40}$/);
  });

  test("a revalidation with the commit's ETag is a 304", async () => {
    const first = await me.call(`/api/repos/${owner}/app/languages`);
    const again = await me.call(`/api/repos/${owner}/app/languages`, { headers: { "if-none-match": first.etag! } });
    expect(again.status).toBe(304);
  });
});

describe("file list", () => {
  test("every file is listed", async () => {
    const result = await me.call<{ paths: string[]; total: number; truncated: boolean }>(`/api/repos/${owner}/app/files`);
    expect(result.status).toBe(200);
    expect(result.data.paths.sort()).toEqual(["docs/guide.md", "scripts/build.sh", "src/main.ts"]);
    expect(result.data.total).toBe(3);
    expect(result.data.truncated).toBe(false);
  });

  test("a new commit changes the list and the ETag", async () => {
    const before = await me.call<{ paths: string[] }>(`/api/repos/${owner}/app/files`);
    await put("app", "src/extra.ts", "export {};\n");
    const after = await me.call<{ paths: string[] }>(`/api/repos/${owner}/app/files`);
    expect(after.data.paths).toContain("src/extra.ts");
    expect(after.etag).not.toBe(before.etag);
    const revalidated = await me.call(`/api/repos/${owner}/app/files`, { headers: { "if-none-match": after.etag! } });
    expect(revalidated.status).toBe(304);
  });

  test("the finder's cache never holds more than three lists", async () => {
    for (let i = 0; i < 5; i += 1) {
      await put("app", `src/n${i}.ts`, `export const n = ${i};\n`);
      await me.call(`/api/repos/${owner}/app/files`);
    }
    expect(fileListSlotsUsed()).toBeLessThanOrEqual(3);
  });
});

describe("private repositories", () => {
  test("outsiders and anonymous callers get the masked 404 for both endpoints", async () => {
    for (const path of ["languages", "files"]) {
      expect((await stranger.call(`/api/repos/${owner}/secret/${path}`)).status).toBe(404);
      expect((await new Client().call(`/api/repos/${owner}/secret/${path}`)).status).toBe(404);
    }
    expect((await me.call<{ paths: string[] }>(`/api/repos/${owner}/secret/files`)).data.paths).toEqual(["hidden.ts"]);
  });
});

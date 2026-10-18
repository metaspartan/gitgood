import { afterAll, beforeAll, expect, test } from "bun:test";
import { createServer } from "../../src/server.ts";
import { db, migrate } from "../../src/db/index.ts";

migrate();

const server = createServer(0);
const base = `http://127.0.0.1:${server.port}`;
const stamp = Date.now().toString(36);
const owner = `gone${stamp}`;
const missing = `vanished${stamp}`;

async function call(path: string, method = "GET", body?: unknown, cookie?: string) {
  const response = await fetch(base + path, {
    method,
    headers: {
      ...(cookie ? { cookie } : {}),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const setCookie = response.headers.get("set-cookie");
  return { status: response.status, data: await response.json().catch(() => ({})), setCookie };
}

beforeAll(async () => {
  const signup = await call("/api/auth/signup", "POST", {
    username: owner,
    email: `${owner}@example.test`,
    password: "missing-repo-password",
  });
  expect(signup.status).toBe(201);
  const path = `${process.cwd()}\\.gitgood-absent-${stamp}`;
  const inserted = db
    .query(
      "INSERT INTO repos (owner_id, name, description, visibility, default_branch, lfs_enabled, archived, created_at, updated_at, disk_path) VALUES ((SELECT id FROM users WHERE username = ?), ?, '', 'public', 'main', 0, 0, ?, ?, ?)",
    )
    .run(owner, missing, Date.now(), Date.now(), path);
  const exists = await Bun.file(path).exists();
  expect(exists).toBe(false);
  expect(Number(inserted.lastInsertRowid)).toBeGreaterThan(0);
});

afterAll(() => server.stop(true));

test("a repository with no directory on disk answers 503, not 500", async () => {
  const cookie = (await call(`/api/auth/login`, "POST", { username: owner, password: "missing-repo-password" })).setCookie;
  for (const path of [
    `/api/repos/${owner}/${missing}`,
    `/api/repos/${owner}/${missing}/tree?ref=main`,
    `/api/repos/${owner}/${missing}/branches`,
    `/api/repos/${owner}/${missing}/readme`,
  ]) {
    const response = await call(path, "GET", undefined, cookie ?? undefined);
    expect(response.status, `${path} should be 503`).toBe(503);
    expect(response.data.error?.code).toBe("unavailable");
  }
});

test("the response never carries the filesystem path", async () => {
  const cookie = (await call(`/api/auth/login`, "POST", { username: owner, password: "missing-repo-password" })).setCookie;
  const response = await call(`/api/repos/${owner}/${missing}/tree?ref=main`, "GET", undefined, cookie ?? undefined);
  const body = JSON.stringify(response.data);
  expect(body).not.toContain(".gitgood-absent-");
  expect(body.toLowerCase()).not.toContain("uv_spawn");
  expect(response.data.error?.message).toBe("Repository data is not present on this server");
});

test("an anonymous reader of a public repository with no data gets 503, not a path", async () => {
  const response = await call(`/api/repos/${owner}/${missing}/tree?ref=main`);
  expect(response.status).toBe(503);
  expect(response.data.error?.message).toBe("Repository data is not present on this server");
  expect(JSON.stringify(response.data)).not.toContain(".gitgood-absent-");
});

test("a private repository with no data masks as not found for a stranger", async () => {
  db.query("UPDATE repos SET visibility = 'private' WHERE name = ?").run(missing);
  const stranger = await call(`/api/repos/${owner}/${missing}/tree?ref=main`);
  expect(stranger.status).toBe(404);
  const cookie = (await call("/api/auth/login", "POST", { username: owner, password: "missing-repo-password" })).setCookie;
  const asOwner = await call(`/api/repos/${owner}/${missing}/tree?ref=main`, "GET", undefined, cookie ?? undefined);
  expect(asOwner.status).toBe(503);
  db.query("UPDATE repos SET visibility = 'public' WHERE name = ?").run(missing);
});

test("a healthy repository is unaffected and keeps working", async () => {
  const cookie = (await call(`/api/auth/login`, "POST", { username: owner, password: "missing-repo-password" })).setCookie;
  const created = await call("/api/repos", "POST", { name: `healthy${stamp}` }, cookie ?? undefined);
  expect(created.status).toBe(201);
  const read = await call(`/api/repos/${owner}/healthy${stamp}/tree?ref=main`, "GET", undefined, cookie ?? undefined);
  expect(read.status).toBe(200);
});

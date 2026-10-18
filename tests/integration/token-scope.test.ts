import { afterAll, beforeAll, expect, test } from "bun:test";
import { createServer } from "../../src/server.ts";

const server = createServer(0);
const base = `http://127.0.0.1:${server.port}`;
const stamp = Date.now().toString(36);
const user = `scoped${stamp}`;
let cookie = "";
let extraCookie = "";
const sessionCookie = () => cookie;

async function call(path: string, method = "GET", body?: unknown, auth: "session" | "bearer" | "none" = "session", bearer?: string) {
  const response = await fetch(base + path, {
    method,
    headers: {
      ...(auth === "session" ? { cookie: sessionCookie() } : auth === "bearer" ? { authorization: `Bearer ${bearer}` } : {}),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const setCookie = response.headers.get("set-cookie");
  if (setCookie) cookie = setCookie.split(";")[0]!;
  return { status: response.status, data: await response.json() };
}

const mint = (body: Record<string, unknown>) => call("/api/tokens", "POST", body);
const withToken = (token: string, path: string, method = "GET", body?: unknown) =>
  call(path, method, body, "bearer", token);

beforeAll(async () => {
  expect((await call("/api/auth/signup", "POST", { username: user, email: `${user}@example.test`, password: "scoped-token-password" })).status).toBe(201);
  for (const name of ["alpha", "beta"]) {
    expect((await call("/api/repos", "POST", { name, visibility: "private" })).status).toBe(201);
  }
});

afterAll(() => server.stop(true));

test("a pinned token reaches only its own repository, for reads and writes", async () => {
  const created = await mint({ name: "agent-alpha", scopes: ["read", "write"], repository: `${user}/alpha` });
  expect(created.status).toBe(201);
  expect(created.data.repo_id).not.toBeNull();
  expect(created.data.repository).toBe(`${user}/alpha`);
  const token = created.data.token as string;

  expect((await withToken(token, `/api/repos/${user}/alpha`)).status).toBe(200);
  expect((await withToken(token, `/api/repos/${user}/alpha/contents`, "PUT", { branch: "main", path: "a.txt", content: "a", encoding: "utf8" })).status).toBe(201);
  const read = await withToken(token, `/api/repos/${user}/beta`);
  expect(read.status).toBeGreaterThanOrEqual(400);
  const write = await withToken(token, `/api/repos/${user}/beta/contents`, "PUT", { branch: "main", path: "b.txt", content: "b", encoding: "utf8" });
  expect(write.status).toBeGreaterThanOrEqual(400);
  const beta = await call(`/api/repos/${user}/beta/tree?ref=main`);
  expect(JSON.stringify(beta.data)).not.toContain("b.txt");
  expect((await withToken(token, "/api/auth/me")).status).toBe(200);
});

test("pinned read-only tokens cannot write, and scoping does not survive a scope change", async () => {
  const readOnly = await mint({ name: "agent-readonly", scopes: ["read"], repository: `${user}/alpha` });
  expect(readOnly.status).toBe(201);
  const token = readOnly.data.token as string;
  expect((await withToken(token, `/api/repos/${user}/alpha`)).status).toBe(200);
  expect((await withToken(token, `/api/repos/${user}/alpha/contents`, "PUT", { branch: "main", path: "ro.txt", content: "x", encoding: "utf8" })).status).toBe(403);
  expect((await withToken(token, `/api/repos/${user}/beta`)).status).toBe(404);
});

test("an account-wide token keeps its previous reach, and its admin scope is refused when pinned", async () => {
  const wide = await mint({ name: "account-wide" });
  expect(wide.status).toBe(201);
  expect(wide.data.repo_id).toBeNull();
  expect(wide.data.repository).toBeNull();
  const token = wide.data.token as string;
  expect((await withToken(token, `/api/repos/${user}/alpha`)).status).toBe(200);
  expect((await withToken(token, `/api/repos/${user}/beta`)).status).toBe(200);

  expect((await mint({ name: "bad", scopes: ["read", "admin"], repository: `${user}/alpha` })).status).toBe(400);
  expect((await mint({ name: "bad2", scopes: ["write", "admin"] })).status).toBe(201);
  expect((await mint({ name: "bad3", scopes: ["write", "admin"] })).status).toBe(201);
});

test("a pinned token cannot administer the instance, even for an administrator", async () => {
  const { scalar } = await import("../../src/db/index.ts");
  scalar("UPDATE users SET is_admin = 1 WHERE username = ?", user);
  try {
    const created = await mint({ name: "admin-pinned", scopes: ["read", "write"], repository: `${user}/alpha` });
    expect(created.status).toBe(201);
    const token = created.data.token as string;
    expect((await withToken(token, `/api/repos/${user}/alpha`)).status).toBe(200);
    expect((await withToken(token, "/api/admin/runner")).status).toBe(403);
    expect((await withToken(token, "/api/admin/metrics")).status).toBe(403);
  } finally {
    scalar("UPDATE users SET is_admin = 0 WHERE username = ?", user);
  }
});

test("pinning validates the repository argument and requires existing write access", async () => {
  for (const repository of ["", "no-slash", "/leading", "trailing/", "a/b/c"]) {
    expect((await mint({ name: "invalid", repository })).status).toBe(400);
  }
  expect((await mint({ name: "invalid", repository: `${user}/missing` })).status).toBe(404);
  const other = `other${stamp}`;
  const signUp = await fetch(base + "/api/auth/signup", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: other, email: `${other}@example.test`, password: "scoped-token-password" }) });
  expect(signUp.status).toBe(201);
  await signUp.text();
  const login = await fetch(base + "/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: other, password: "scoped-token-password" }) });
  expect(login.status).toBe(200);
  extraCookie = (login.headers.get("set-cookie") ?? "").split(";")[0]!;
  await login.text();
  const cross = await fetch(base + "/api/tokens", { method: "POST", headers: { cookie: extraCookie, "content-type": "application/json" }, body: JSON.stringify({ name: "cross", repository: `${user}/alpha` }) });
  expect(cross.status).toBe(404);
  await cross.text();
});

test("revoking a pinned token removes all of its access", async () => {
  const created = await mint({ name: "temporary", repository: `${user}/alpha` });
  const token = created.data.token as string;
  expect((await withToken(token, `/api/repos/${user}/alpha`)).status).toBe(200);
  expect((await call(`/api/tokens/${created.data.id}`, "DELETE")).status).toBe(200);
  expect((await withToken(token, `/api/repos/${user}/alpha`)).status).toBe(404);
  expect((await withToken("ggh_not-a-real-token", `/api/repos/${user}/alpha`)).status).toBe(404);
  const me = await withToken(token, "/api/auth/me");
  expect(me.data.user ?? null).toBeNull();
  expect((await call(`/api/tokens/${created.data.id}`, "DELETE")).status).toBe(404);
});

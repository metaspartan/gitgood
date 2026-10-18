import { afterAll, beforeAll, expect, test } from "bun:test";
import { createServer } from "../../src/server.ts";

const server = createServer(0);
const base = `http://127.0.0.1:${server.port}`;
const stamp = Date.now().toString(36);
const owner = `own${stamp}`;
const writer = `wri${stamp}`;
const reader = `rea${stamp}`;
const outsider = `out${stamp}`;
const repoPath = `/api/repos/${owner}/project`;

const cookies = new Map<string, string>();
async function call(who: string, path: string, method = "GET", body?: unknown) {
  const headers: Record<string, string> = {};
  const cookie = cookies.get(who);
  if (cookie) headers.cookie = cookie;
  if (body !== undefined) headers["content-type"] = "application/json";
  const response = await fetch(base + path, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const setCookie = response.headers.get("set-cookie");
  if (setCookie) cookies.set(who, setCookie.split(";")[0]!);
  return { status: response.status, data: await response.json() };
}
const as = (who: string) => (path: string, method = "GET", body?: unknown) => call(who, path, method, body);

const o = as(owner), w = as(writer), r = as(reader), x = as(outsider);

beforeAll(async () => {
  for (const name of [owner, writer, reader, outsider]) {
    const signup = await call(name, "/api/auth/signup", "POST", {
      username: name,
      email: `${name}@example.test`,
      password: "collaborator-test-password",
    });
    expect(signup.status).toBe(201);
  }
  expect((await o("/api/repos", "POST", { name: "project", visibility: "private" })).status).toBe(201);
  expect((await o("/api/repos", "POST", { name: "public-project" })).status).toBe(201);
});

afterAll(() => server.stop(true));

test("a stranger can neither read nor enumerate a private repository", async () => {
  expect((await x(repoPath)).status).toBe(404);
  expect((await x(`${repoPath}/collaborators`)).status).toBe(404);
  const attempt = await x(`${repoPath}/collaborators`, "POST", { username: writer, permission: "write" });
  expect(attempt.status).toBe(404);
});

test("a read collaborator can clone and list but cannot write", async () => {
  expect((await o(`${repoPath}/collaborators`, "POST", { username: reader, permission: "read" })).status).toBe(201);
  expect((await r(repoPath)).status).toBe(200);
  expect((await r(`${repoPath}/tree?ref=main`)).status).toBe(200);
  expect((await r(`${repoPath}/collaborators`)).status).toBe(200);
  const write = await r(`${repoPath}/contents`, "PUT", { branch: "main", path: "nope.txt", content: "x", encoding: "utf8" });
  expect(write.status).toBeGreaterThanOrEqual(400);
  const tree = await o(`${repoPath}/tree?ref=main`);
  expect(JSON.stringify(tree.data)).not.toContain("nope.txt");
  expect((await r(`${repoPath}/pulls`, "POST", { title: "no", head: "main", base: "main" })).status).toBeGreaterThanOrEqual(400);
});

test("a write collaborator can push, create pull requests and sees write permission", async () => {
  expect((await o(`${repoPath}/collaborators`, "POST", { username: writer, permission: "write" })).status).toBe(201);
  expect((await w(repoPath)).status).toBe(200);
  expect((await w(repoPath)).data.permissions.write).toBe(true);
  const write = await w(`${repoPath}/contents`, "PUT", { branch: "main", path: "collab.txt", content: "from a collaborator", encoding: "utf8" });
  expect(write.status).toBe(201);
  expect((await o(`${repoPath}/tree?ref=main`)).data.items.some((entry: { name: string }) => entry.name === "collab.txt")).toBe(true);
  expect((await w(`${repoPath}/branches`, "POST", { name: "collab-branch", from: "main" })).status).toBe(201);
  expect((await w(`${repoPath}/contents`, "PUT", { branch: "collab-branch", path: "collab2.txt", content: "more", encoding: "utf8" })).status).toBe(201);
  const pull = await w(`${repoPath}/pulls`, "POST", { title: "Collaborator change", head: "collab-branch", base: "main" });
  expect(pull.status).toBe(201);
  expect((await w("/api/admin/metrics")).status).toBeGreaterThanOrEqual(400);
});

test("only the owner manages access, and a writer collaborator cannot widen their own", async () => {
  const attempt = await w(`${repoPath}/collaborators`, "POST", { username: outsider, permission: "write" });
  expect(attempt.status).toBe(403);
  expect((await w(`${repoPath}/collaborators`)).data.can_manage).toBe(false);
  expect((await o(`${repoPath}/collaborators`)).data.can_manage).toBe(true);
  const self = await o(`${repoPath}/collaborators`, "POST", { username: owner, permission: "read" });
  expect(self.status).toBe(400);
  expect((await x(`${repoPath}/collaborators`, "POST", { username: writer, permission: "write" })).status).toBe(404);
  expect((await o(`${repoPath}/collaborators`, "POST", { username: "ghostmissing", permission: "write" })).status).toBe(404);
  expect((await o(`${repoPath}/collaborators`, "POST", { username: writer, permission: "admin" })).status).toBe(400);
});

test("removing a collaborator revokes access immediately, including writes", async () => {
  expect((await o(`${repoPath}/collaborators/${writer}`, "DELETE")).status).toBe(200);
  expect((await w(repoPath)).status).toBe(404);
  const write = await w(`${repoPath}/contents`, "PUT", { branch: "main", path: "after.txt", content: "x", encoding: "utf8" });
  expect(write.status).toBeGreaterThanOrEqual(400);
  expect((await o(`${repoPath}/tree?ref=main`)).data.items.some((e: { name: string }) => e.name === "after.txt")).toBe(false);
  expect((await o(`${repoPath}/collaborators/${writer}`, "DELETE")).status).toBe(404);
});

test("collaborator grants do not leak across repositories", async () => {
  const other = `/api/repos/${owner}/public-project`;
  expect((await r(other)).status).toBe(200);
  expect((await r(`${other}/collaborators`)).data.items.some((c: { username: string }) => c.username === reader)).toBe(false);
  expect((await o(`${repoPath}/collaborators`, "POST", { username: writer, permission: "write" })).status).toBe(201);
  expect((await o(`${repoPath}/collaborators/${writer}`, "DELETE")).status).toBe(200);
  expect((await r(repoPath)).status).toBe(200);
});

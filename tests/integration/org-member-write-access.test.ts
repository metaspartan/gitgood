import { afterAll, beforeAll, expect, test } from "bun:test";
import { createServer } from "../../src/server.ts";

const server = createServer(0);
const base = `http://127.0.0.1:${server.port}`;
const stamp = Date.now().toString(36);
const founder = `fo${stamp}`;
const member = `om${stamp}`;
const admin = `oa${stamp}`;
const outsider = `oo${stamp}`;
const orgName = `acme${stamp}`;

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
  return { status: response.status, data: await response.json().catch(() => ({})) };
}
const as = (who: string) => (p: string, m = "GET", b?: unknown) => call(who, p, m, b);
const f = as(founder), m = as(member), a = as(admin), x = as(outsider);

const repoPath = `/api/repos/${orgName}/orgrepo`;

beforeAll(async () => {
  for (const name of [founder, member, admin, outsider]) {
    const signup = await fetch(base + "/api/auth/signup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: name, email: `${name}@example.test`, password: "org-member-password" }),
    });
    expect(signup.status).toBe(201);
    cookies.set(name, (signup.headers.get("set-cookie") ?? "").split(";")[0]!);
  }
  expect((await f("/api/orgs", "POST", { name: orgName })).status).toBe(201);
  expect((await f(`/api/orgs/${orgName}/members`, "POST", { username: member, role: "member" })).status).toBe(201);
  expect((await f(`/api/orgs/${orgName}/members`, "POST", { username: admin, role: "admin" })).status).toBe(201);
});

afterAll(() => server.stop(true));

test("a member may create an organisation repository but cannot write to it", async () => {
  const created = await m("/api/repos", "POST", { name: "member-made", organization: orgName, visibility: "private" });
  expect(created.status).toBe(201);
  expect((await m(`/api/repos/${orgName}/member-made`)).status).toBe(200);
  const write = await m(`/api/repos/${orgName}/member-made/contents`, "PUT", {
    branch: "main",
    path: "a.txt",
    content: "x",
    encoding: "utf8",
  });
  expect(write.status).toBeGreaterThanOrEqual(400);
});

test("an organisation admin can create a repository and write to it", async () => {
  const created = await a("/api/repos", "POST", { name: "orgrepo", organization: orgName, visibility: "private" });
  expect(created.status).toBe(201);
  const commit = await a(`${repoPath}/contents`, "PUT", {
    branch: "main",
    path: "README.md",
    content: "first commit from an org admin\n",
    encoding: "utf8",
  });
  expect(commit.status).toBe(201);
  const issue = await a(`${repoPath}/issues`, "POST", { title: "opened by an admin" });
  expect(issue.status).toBe(201);
});

test("a member still cannot write, which is the tested design", async () => {
  const write = await m(`${repoPath}/contents`, "PUT", { branch: "main", path: "member.txt", content: "x", encoding: "utf8" });
  expect(write.status).toBeGreaterThanOrEqual(400);
  const readme = await a(`${repoPath}/readme`);
  expect(readme.status).toBe(200);
  expect(String(readme.data.content)).not.toContain("member.txt");
});

test("a member can read the organisation's repository", async () => {
  expect((await m(repoPath)).status).toBe(200);
  expect((await m(`${repoPath}/issues?state=all`)).status).toBe(200);
});

test("a non-member can neither read nor write", async () => {
  expect((await x(repoPath)).status).toBe(404);
  const write = await x(`${repoPath}/contents`, "PUT", { branch: "main", path: "x.txt", content: "x", encoding: "utf8" });
  expect(write.status).toBeGreaterThanOrEqual(400);
  const readme = await a(`${repoPath}/readme`);
  expect(readme.status).toBe(200);
  expect(String(readme.data.content)).not.toContain("x.txt");
});

test("a write collaborator can push but cannot unlist or delete the repository", async () => {
  const repo = await f("/api/repos", "POST", { name: "collab-private", visibility: "private" });
  expect(repo.status).toBe(201);
  const path = `/api/repos/${founder}/collab-private`;
  expect((await f(`${path}/collaborators`, "POST", { username: member, permission: "write" })).status).toBe(201);

  expect((await m(`${path}/contents`, "PUT", { branch: "main", path: "ok.txt", content: "x", encoding: "utf8" })).status).toBe(201);
  for (const patch of [{ visibility: "public" }, { default_branch: "other" }, { lfs_enabled: true }]) {
    expect((await m(path, "PATCH", patch)).status, `${JSON.stringify(patch)} should be refused`).toBe(403);
  }
  expect((await m(path, "DELETE")).status).toBe(403);
  const still = await f(path);
  expect(still.status).toBe(200);
  expect(still.data.visibility).toBe("private");
  expect((await f(`${path}/readme`)).status).toBe(200);
});

test("the owner can still do all of it", async () => {
  const path = `/api/repos/${founder}/collab-private`;
  expect((await f(path, "PATCH", { description: "the owner may describe it" })).status).toBe(200);
  expect((await f(path, "DELETE")).status).toBe(200);
});

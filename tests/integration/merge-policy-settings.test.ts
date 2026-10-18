import { afterAll, beforeAll, expect, test } from "bun:test";
import { createServer } from "../../src/server.ts";

const server = createServer(0);
const base = `http://127.0.0.1:${server.port}`;
const stamp = Date.now().toString(36);
const owner = `mp${stamp}`;
const stranger = `ms${stamp}`;

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
const o = (p: string, m = "GET", b?: unknown) => call(owner, p, m, b);
const s = (p: string, m = "GET", b?: unknown) => call(stranger, p, m, b);
const none = (p: string, m = "GET", b?: unknown) => call("nobody", p, m, b);

beforeAll(async () => {
  for (const name of [owner, stranger]) {
    const signup = await fetch(base + "/api/auth/signup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: name, email: `${name}@example.test`, password: "merge-policy-password" }),
    });
    expect(signup.status).toBe(201);
    cookies.set(name, (signup.headers.get("set-cookie") ?? "").split(";")[0]!);
  }
  expect((await o("/api/repos", "POST", { name: "guarded" })).status).toBe(201);
  expect((await o("/api/repos", "POST", { name: "open-guard" })).status).toBe(201);
});

afterAll(() => server.stop(true));

test("a branch can be given merge requirements with no pull request in existence", async () => {
  expect((await o(`/api/repos/${owner}/guarded/pulls?state=all`)).data.items).toEqual([]);

  const list = await o(`/api/repos/${owner}/guarded/pull-merge-policies`);
  expect(list.status).toBe(200);
  expect(list.data.items).toEqual([]);
  expect(list.data.can_manage).toBe(true);

  const saved = await o(`/api/repos/${owner}/guarded/pull-merge-policy`, "PUT", {
    branch: "main",
    required_approvals: 2,
    require_checks: true,
  });
  expect(saved.status).toBe(200);
  expect(saved.data.required_approvals).toBe(2);
  expect(saved.data.require_checks).toBe(true);

  const after = await o(`/api/repos/${owner}/guarded/pull-merge-policies`);
  expect(after.data.items).toHaveLength(1);
  expect(after.data.items[0]).toEqual({
    branch: "main",
    required_approvals: 2,
    require_checks: true,
  });
});

test("a requirement can be removed, and removing an absent one is a 404", async () => {
  await o(`/api/repos/${owner}/guarded/pull-merge-policy`, "PUT", {
    branch: "release",
    required_approvals: 1,
    require_checks: false,
  });
  expect((await o(`/api/repos/${owner}/guarded/pull-merge-policies`)).data.items).toHaveLength(2);

  const removed = await o(`/api/repos/${owner}/guarded/pull-merge-policy?branch=release`, "DELETE");
  expect(removed.status).toBe(200);
  expect(removed.data.items.map((p: { branch: string }) => p.branch)).toEqual(["main"]);

  const again = await o(`/api/repos/${owner}/guarded/pull-merge-policy?branch=release`, "DELETE");
  expect(again.status).toBe(404);
});

test("can_manage is false for everyone who cannot actually change policy", async () => {
  const asStranger = await s(`/api/repos/${owner}/guarded/pull-merge-policies`);
  expect(asStranger.status).toBe(200);
  expect(asStranger.data.can_manage).toBe(false);
  expect(asStranger.data.items).toHaveLength(1);

  const anonymous = await none(`/api/repos/${owner}/open-guard/pull-merge-policies`);
  expect(anonymous.status).toBe(200);
  expect(anonymous.data.can_manage).toBe(false);
});

test("branch protection reports the same manage flag, and can be removed", async () => {
  const added = await o(`/api/repos/${owner}/open-guard/branch-protection`, "PUT", {
    branch: "main",
    require_pull_request: true,
  });
  expect(added.status).toBe(200);

  const asStranger = await s(`/api/repos/${owner}/open-guard/branch-protection`);
  expect(asStranger.data.can_manage).toBe(false);
  const refused = await s(`/api/repos/${owner}/open-guard/branch-protection`, "PUT", {
    branch: "main",
    require_pull_request: false,
  });
  expect(refused.status).toBeGreaterThanOrEqual(400);

  const removed = await o(`/api/repos/${owner}/open-guard/branch-protection/main`, "DELETE");
  expect(removed.status).toBe(200);
  expect(removed.data.items).toEqual([]);
  expect((await o(`/api/repos/${owner}/open-guard/branch-protection/main`, "DELETE")).status).toBe(404);
});

test("the policy endpoints refuse a malformed or dangerous branch name", async () => {
  for (const branch of ["--upload-pack=evil", "a..b", "with space", ""]) {
    const response = await o(`/api/repos/${owner}/guarded/pull-merge-policy`, "PUT", {
      branch,
      required_approvals: 1,
      require_checks: false,
    });
    expect(response.status, `"${branch}" should be rejected`).toBeGreaterThanOrEqual(400);
  }
  expect((await o(`/api/repos/${owner}/guarded/pull-merge-policy`, "PUT", {
    branch: "main",
    required_approvals: 9,
    require_checks: false,
  })).status).toBe(400);
});

test("requirements are visible on a private repository's policy list to a reader", async () => {
  expect((await o("/api/repos", "POST", { name: "secret-guard", visibility: "private" })).status).toBe(201);
  await o(`/api/repos/${owner}/secret-guard/pull-merge-policy`, "PUT", {
    branch: "main",
    required_approvals: 1,
    require_checks: false,
  });
  const asStranger = await s(`/api/repos/${owner}/secret-guard/pull-merge-policies`);
  expect(asStranger.status).toBe(404);
  expect(JSON.stringify(asStranger.data)).not.toContain("required_approvals");
});

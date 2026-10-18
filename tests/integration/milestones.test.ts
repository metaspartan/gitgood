import { afterAll, beforeAll, expect, test } from "bun:test";
import { createServer } from "../../src/server.ts";

const server = createServer(0);
const base = `http://127.0.0.1:${server.port}`;
const stamp = Date.now().toString(36);
const user = `ms${stamp}`;
const other = `mx${stamp}`;
let cookie = "";
let otherCookie = "";

async function call(
  path: string,
  method = "GET",
  body?: unknown,
  session: "main" | "other" | "none" = "main",
) {
  const jar = session === "other" ? otherCookie : cookie;
  const response = await fetch(base + path, {
    method,
    headers: {
      ...(session === "none" || !jar ? {} : { cookie: jar }),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const setCookie = response.headers.get("set-cookie");
  if (setCookie) {
    const value = setCookie.split(";")[0]!;
    if (session === "other") otherCookie = value;
    else cookie = value;
  }
  return { status: response.status, data: await response.json() };
}
const m = (path: string, method = "GET", body?: unknown) => call(path, method, body);
const asOther = (path: string, method = "GET", body?: unknown) => call(path, method, body, "other");
const asNone = (path: string, method = "GET", body?: unknown) => call(path, method, body, "none");

const repoPath = `/api/repos/${user}/project`;

beforeAll(async () => {
  const signup = await fetch(base + "/api/auth/signup", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: user, email: `${user}@example.test`, password: "milestone-test-password" }),
  });
  expect(signup.status).toBe(201);
  cookie = (signup.headers.get("set-cookie") ?? "").split(";")[0]!;
  expect((await m("/api/repos", "POST", { name: "project" })).status).toBe(201);
  expect((await m("/api/repos", "POST", { name: "second" })).status).toBe(201);
  expect((await m(`${repoPath}/contents`, "PUT", { branch: "main", path: "README.md", content: "seed\n", encoding: "utf8" })).status).toBe(201);

  const second = await fetch(base + "/api/auth/signup", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: other, email: `${other}@example.test`, password: "milestone-test-password" }),
  });
  expect(second.status).toBe(201);
  otherCookie = (second.headers.get("set-cookie") ?? "").split(";")[0]!;
});

afterAll(() => server.stop(true));

test("milestones take display numbers from a space shared with issues and pull requests", async () => {
  const issue = await m(`${repoPath}/issues`, "POST", { title: "first" });
  expect(issue.status).toBe(201);
  const milestone = await m(`${repoPath}/milestones`, "POST", { title: "2.0" });
  expect(milestone.status).toBe(201);
  expect(milestone.data.number).toBe(2);
  const second = await m(`${repoPath}/milestones`, "POST", { title: "2.1" });
  expect(second.data.number).toBe(3);
});

test("a milestone reports progress from the issues and pull requests filed against it", async () => {
  const created = await m(`${repoPath}/milestones`, "POST", {
    title: "release",
    description: "everything for the release",
    due_on: "2027-03-01",
  });
  expect(created.status).toBe(201);
  expect(created.data.due_on).toBe(Date.UTC(2027, 2, 1));
  expect(created.data.total_count).toBe(0);
  expect(created.data.completion_percent).toBe(0);

  const a = await m(`${repoPath}/issues`, "POST", { title: "a" });
  const b = await m(`${repoPath}/issues`, "POST", { title: "b" });
  expect((await m(`${repoPath}/issues/${a.data.number}/milestone`, "POST", { milestone_id: created.data.id })).status).toBe(200);
  expect((await m(`${repoPath}/issues/${b.data.number}/milestone`, "POST", { milestone_id: created.data.id })).status).toBe(200);

  const afterTwo = await m(`${repoPath}/milestones/${created.data.number}`);
  expect(afterTwo.data.open_issues).toBe(2);
  expect(afterTwo.data.open_count).toBe(2);
  expect(afterTwo.data.completion_percent).toBe(0);

  await m(`${repoPath}/issues/${a.data.number}`, "PATCH", { state: "closed" });
  const afterClose = await m(`${repoPath}/milestones/${created.data.number}`);
  expect(afterClose.data.closed_issues).toBe(1);
  expect(afterClose.data.open_issues).toBe(1);
  expect(afterClose.data.completion_percent).toBe(50);
});

test("a merged pull request counts as finished, an open one does not", async () => {
  const milestone = (await m(`${repoPath}/milestones`, "POST", { title: "pr work" })).data;
  const branch = await m(`${repoPath}/branches`, "POST", { name: "feature-work", from: "main" });
  expect(branch.status).toBe(201);
  expect((await m(`${repoPath}/contents`, "PUT", { branch: "feature-work", path: "f.txt", content: "x", encoding: "utf8" })).status).toBe(201);
  const pull = await m(`${repoPath}/pulls`, "POST", { title: "work", head: "feature-work", base: "main" });
  expect(pull.status).toBe(201);
  expect((await m(`${repoPath}/pulls/${pull.data.number}/milestone`, "POST", { milestone_id: milestone.id })).status).toBe(200);

  const open = await m(`${repoPath}/milestones/${milestone.number}`);
  expect(open.data.open_pulls).toBe(1);
  expect(open.data.completion_percent).toBe(0);

  expect((await m(`${repoPath}/pulls/${pull.data.number}/merge`, "POST", {})).status).toBe(200);

  const merged = await m(`${repoPath}/milestones/${milestone.number}`);
  expect(merged.data.merged_pulls).toBe(1);
  expect(merged.data.open_pulls).toBe(0);
  expect(merged.data.completion_percent).toBe(100);
});

test("a milestone can be closed, reopened and have its due date cleared", async () => {
  const created = (await m(`${repoPath}/milestones`, "POST", { title: "dated", due_on: "2027-01-15" })).data;
  const closed = await m(`${repoPath}/milestones/${created.number}`, "PATCH", { state: "closed" });
  expect(closed.status).toBe(200);
  expect(closed.data.state).toBe("closed");
  expect(closed.data.closed_at).not.toBeNull();

  const reopened = await m(`${repoPath}/milestones/${created.number}`, "PATCH", { state: "open" });
  expect(reopened.data.state).toBe("open");
  expect(reopened.data.closed_at).toBeNull();

  const untouched = await m(`${repoPath}/milestones/${created.number}`, "PATCH", { title: "renamed" });
  expect(untouched.data.due_on).toBe(created.due_on);
  const cleared = await m(`${repoPath}/milestones/${created.number}`, "PATCH", { due_on: null });
  expect(cleared.data.due_on).toBeNull();
});

test("a due date that does not exist is rejected rather than rolled over", async () => {
  for (const due of ["2027-02-31", "2027-13-01", "01-01-2027", "tomorrow", "2027-1-1"]) {
    const response = await m(`${repoPath}/milestones`, "POST", { title: "bad date", due_on: due });
    expect(response.status).toBe(400);
  }
  expect((await m(`${repoPath}/milestones`, "POST", { title: "leap", due_on: "2028-02-29" })).status).toBe(201);
  expect((await m(`${repoPath}/milestones`, "POST", { title: "no leap", due_on: "2027-02-29" })).status).toBe(400);
});

test("a reader can see milestones but cannot attach or change them", async () => {
  expect((await asOther(`${repoPath}/milestones`)).status).toBe(200);
  const mine = (await m(`${repoPath}/milestones`, "POST", { title: "shared" })).data;
  const issue = await m(`${repoPath}/issues`, "POST", { title: "needs a milestone" });

  const attach = await asOther(`${repoPath}/issues/${issue.data.number}/milestone`, "POST", { milestone_id: mine.id });
  expect(attach.status).toBeGreaterThanOrEqual(400);
  const create = await asOther(`${repoPath}/milestones`, "POST", { title: "not mine" });
  expect(create.status).toBeGreaterThanOrEqual(400);
  const close = await asOther(`${repoPath}/milestones/${mine.number}`, "PATCH", { state: "closed" });
  expect(close.status).toBeGreaterThanOrEqual(400);
  expect((await asNone(`${repoPath}/milestones`, "POST", { title: "anon" })).status).toBeGreaterThanOrEqual(400);
});

test("a milestone from another repository cannot be attached", async () => {
  const foreign = (await m(`/api/repos/${user}/second/milestones`, "POST", { title: "elsewhere" })).data;
  const issue = await m(`${repoPath}/issues`, "POST", { title: "needs a milestone" });

  const cross = await m(`${repoPath}/issues/${issue.data.number}/milestone`, "POST", { milestone_id: foreign.id });
  expect(cross.status).toBe(404);
  const detail = await m(`${repoPath}/issues/${issue.data.number}`);
  expect(detail.data.milestone_id).toBeNull();
});

test("a milestone with open work cannot be deleted, and detaching works", async () => {
  const milestone = (await m(`${repoPath}/milestones`, "POST", { title: "temporary" })).data;
  const issue = await m(`${repoPath}/issues`, "POST", { title: "held" });
  await m(`${repoPath}/issues/${issue.data.number}/milestone`, "POST", { milestone_id: milestone.id });

  expect((await m(`${repoPath}/milestones/${milestone.number}`, "DELETE")).status).toBeGreaterThanOrEqual(400);

  expect((await m(`${repoPath}/milestones/${milestone.number}/issues/${issue.data.number}`, "DELETE")).status).toBe(200);
  expect((await m(`${repoPath}/milestones/${milestone.number}`, "DELETE")).status).toBe(200);
  expect((await m(`${repoPath}/milestones/${milestone.number}`)).status).toBe(404);
  expect((await m(`${repoPath}/milestones/${milestone.number}/issues/${issue.data.number}`, "DELETE")).status).toBe(404);
});

test("the items endpoint lists issues and pull requests separately", async () => {
  const milestone = (await m(`${repoPath}/milestones`, "POST", { title: "listing" })).data;
  const issue = await m(`${repoPath}/issues`, "POST", { title: "listed issue" });
  await m(`${repoPath}/issues/${issue.data.number}/milestone`, "POST", { milestone_id: milestone.id });

  const items = await m(`${repoPath}/milestones/${milestone.number}/items`);
  expect(items.status).toBe(200);
  expect(items.data.total).toBe(1);
  expect(items.data.issues).toHaveLength(1);
  expect(items.data.pulls).toHaveLength(0);
  expect(items.data.issues[0].number).toBe(issue.data.number);
});

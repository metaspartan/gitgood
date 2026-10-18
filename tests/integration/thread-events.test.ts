import { afterAll, beforeAll, expect, test } from "bun:test";
import { createServer } from "../../src/server.ts";
import { db, migrate } from "../../src/db/index.ts";

migrate();

const server = createServer(0);
const base = `http://127.0.0.1:${server.port}`;
const stamp = Date.now().toString(36);
const owner = `te${stamp}`;
const helper = `th${stamp}`;
const stranger = `ts${stamp}`;

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

const open = `/api/repos/${owner}/open-repo`;
const secret = `/api/repos/${owner}/secret-repo`;
const events = (path: string) => `${path}/events`;

beforeAll(async () => {
  for (const name of [owner, helper, stranger]) {
    const signup = await fetch(base + "/api/auth/signup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: name, email: `${name}@example.test`, password: "events-test-password" }),
    });
    expect(signup.status).toBe(201);
    cookies.set(name, (signup.headers.get("set-cookie") ?? "").split(";")[0]!);
  }
  expect((await o("/api/repos", "POST", { name: "open-repo" })).status).toBe(201);
  expect((await o("/api/repos", "POST", { name: "secret-repo", visibility: "private" })).status).toBe(201);
});

afterAll(() => server.stop(true));

test("closing and reopening an issue records who and when", async () => {
  const issue = (await o(`${open}/issues`, "POST", { title: "needs closing" })).data;
  const path = `${open}/issues/${issue.number}`;

  expect((await o(path, "PATCH", { state: "closed" })).status).toBe(200);
  const afterClose = await o(events(path));
  expect(afterClose.status).toBe(200);
  expect(afterClose.data.items).toHaveLength(1);
  expect(afterClose.data.items[0].kind).toBe("closed");
  expect(afterClose.data.items[0].actor.username).toBe(owner);
  expect(afterClose.data.items[0].created_at).toBeGreaterThan(0);

  await o(path, "PATCH", { state: "open" });
  const afterReopen = await o(events(path));
  expect(afterReopen.data.items.map((e: { kind: string }) => e.kind)).toEqual(["closed", "reopened"]);
});

test("saving the state an issue is already in records nothing", async () => {
  const issue = (await o(`${open}/issues`, "POST", { title: "idempotent save" })).data;
  const path = `${open}/issues/${issue.number}`;
  await o(path, "PATCH", { state: "closed" });
  const before = (await o(events(path))).data.items.length;
  expect(before).toBe(1);

  for (let i = 0; i < 3; i += 1) {
    expect((await o(path, "PATCH", { state: "closed", title: `edited ${i}` })).status).toBe(200);
  }
  const after = await o(events(path));
  expect(after.data.items).toHaveLength(before);
  expect(after.data.items.every((e: { kind: string }) => e.kind === "closed")).toBe(true);
});

test("a label diff records additions and removals, not the whole set", async () => {
  const issue = (await o(`${open}/issues`, "POST", { title: "labelled" })).data;
  const path = `${open}/issues/${issue.number}`;

  await o(path, "PATCH", { labels: ["bug", "urgent"] });
  let timeline = (await o(events(path))).data.items;
  expect(timeline.map((e: { kind: string }) => e.kind).sort()).toEqual(["labeled", "labeled"]);
  expect(timeline.map((e: { detail: { label: string } }) => e.detail.label).sort()).toEqual(["bug", "urgent"]);

  await o(path, "PATCH", { labels: ["urgent", "bug"] });
  expect((await o(events(path))).data.items).toHaveLength(2);

  await o(path, "PATCH", { labels: ["urgent", "triage"] });
  timeline = (await o(events(path))).data.items;
  expect(timeline).toHaveLength(4);
  expect(timeline.slice(2).map((e: { kind: string; detail: { label: string } }) => `${e.kind}:${e.detail.label}`).sort())
    .toEqual(["labeled:triage", "unlabeled:bug"]);
});

test("assignment changes are recorded, and re-assigning the same person is not", async () => {
  const issue = (await o(`${open}/issues`, "POST", { title: "assigned" })).data;
  const path = `${open}/issues/${issue.number}`;
  const collaborators = `${open}/collaborators`;
  expect((await o(collaborators, "POST", { username: helper, permission: "write" })).status).toBe(201);

  expect((await o(`${path}/assignees`, "POST", { add: [helper] })).status).toBe(200);
  let timeline = (await o(events(path))).data.items;
  expect(timeline).toHaveLength(1);
  expect(timeline[0].kind).toBe("assigned");
  expect(timeline[0].detail.assignee).toBe(helper);
  expect(timeline[0].actor.username).toBe(owner);

  await o(`${path}/assignees`, "POST", { add: [helper] });
  expect((await o(events(path))).data.items).toHaveLength(1);

  await o(`${path}/assignees`, "POST", { remove: [helper] });
  timeline = (await o(events(path))).data.items;
  expect(timeline.map((e: { kind: string }) => e.kind)).toEqual(["assigned", "unassigned"]);
});

test("a milestone move records the title, in both directions", async () => {
  const milestone = (await o(`${open}/milestones`, "POST", { title: "v2.0" })).data;
  const issue = (await o(`${open}/issues`, "POST", { title: "milestoned" })).data;
  const path = `${open}/issues/${issue.number}`;

  await o(`${path}/milestone`, "POST", { milestone_id: milestone.id });
  let timeline = (await o(events(path))).data.items;
  expect(timeline).toHaveLength(1);
  expect(timeline[0].kind).toBe("milestone_changed");
  expect(timeline[0].detail.to).toBe("v2.0");
  expect(timeline[0].detail.from).toBeNull();

  await o(`${path}/milestone`, "POST", { milestone_id: milestone.id });
  expect((await o(events(path))).data.items).toHaveLength(1);

  await o(`${path}/milestone`, "POST", { milestone_id: null });
  timeline = (await o(events(path))).data.items;
  expect(timeline[1].detail.from).toBe("v2.0");
  expect(timeline[1].detail.to).toBeNull();
});

test("a comment is a timeline entry, addressable by its id", async () => {
  const issue = (await o(`${open}/issues`, "POST", { title: "discussed" })).data;
  const path = `${open}/issues/${issue.number}`;
  const comment = (await o(`${path}/comments`, "POST", { body: "I looked at this" })).data;
  const timeline = (await o(events(path))).data.items;
  expect(timeline).toHaveLength(1);
  expect(timeline[0].kind).toBe("commented");
  expect(timeline[0].detail.comment_id).toBe(comment.id);
});

test("history survives the account that made it being deleted", async () => {
  const name = `doomed${stamp}`;
  const signup = await fetch(base + "/api/auth/signup", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: name, email: `${name}@example.test`, password: "events-test-password" }),
  });
  expect(signup.status).toBe(201);
  const cookie = (signup.headers.get("set-cookie") ?? "").split(";")[0]!;
  expect(cookie).toContain("=");
  const callAs = (path: string, method = "GET", body?: unknown) =>
    fetch(base + path, {
      method,
      headers: { cookie, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }).then((r) => r.json());

  expect((await o(`${open}/collaborators`, "POST", { username: name, permission: "write" })).status).toBe(201);
  const opened = (await o(`${open}/issues`, "POST", { title: "opened by the owner" })).data;

  const path = `${open}/issues/${opened.number}`;
  const closed = await callAs(path, "PATCH", { state: "closed" });
  expect(closed.state).toBe("closed");

  const before = await o(events(path));
  expect(before.status).toBe(200);
  expect(before.data.items[0].actor.username).toBe(name);

  const row = db.query("SELECT id FROM users WHERE username = ?").get(name) as { id: number };
  db.query("DELETE FROM users WHERE id = ?").run(row.id);

  const after = await o(events(path));
  expect(after.status).toBe(200);
  expect(after.data.items).toHaveLength(1);
  expect(after.data.items[0].kind).toBe("closed");
  expect(after.data.items[0].actor).toEqual({
    id: null,
    username: name,
    display_name: null,
  });
  expect((await o(path)).data.state).toBe("closed");
});

test("a private repository's timeline is not readable by a stranger", async () => {
  const issue = (await o(`${secret}/issues`, "POST", { title: "private work" })).data;
  await o(`${secret}/issues/${issue.number}`, "PATCH", { state: "closed" });

  expect((await o(events(`${secret}/issues/${issue.number}`))).status).toBe(200);
  expect((await s(events(`${secret}/issues/${issue.number}`))).status).toBe(404);
});

test("the timeline is paged, and the count matches the rows", async () => {
  const issue = (await o(`${open}/issues`, "POST", { title: "busy" })).data;
  const path = `${open}/issues/${issue.number}`;
  for (let i = 0; i < 4; i += 1) await o(path, "PATCH", { labels: [`label-${i}`] });

  const page1 = await o(`${events(path)}?per_page=3&page=1`);
  expect(page1.data.items).toHaveLength(3);
  expect(page1.data.total).toBe(7);
  expect(page1.data.page).toBe(1);
  expect(page1.data.per_page).toBe(3);

  const page3 = await o(`${events(path)}?per_page=3&page=3`);
  expect(page3.data.items).toHaveLength(1);
  const first = new Set(page1.data.items.map((e: { id: number }) => e.id));
  expect(page3.data.items.every((e: { id: number }) => !first.has(e.id))).toBe(true);

  expect((await o(`${events(path)}?per_page=3&page=99`)).data.items).toEqual([]);
});

test("events are scoped to their own thread and repository", async () => {
  const a = (await o(`${open}/issues`, "POST", { title: "thread a" })).data;
  const b = (await o(`${open}/issues`, "POST", { title: "thread b" })).data;
  await o(`${open}/issues/${a.number}`, "PATCH", { state: "closed" });

  expect((await o(events(`${open}/issues/${a.number}`))).data.items).toHaveLength(1);
  expect((await o(events(`${open}/issues/${b.number}`))).data.items).toHaveLength(0);
});

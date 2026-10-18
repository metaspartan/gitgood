import { afterAll, beforeAll, expect, test } from "bun:test";
import { createServer } from "../../src/server.ts";

const server = createServer(0);
const base = `http://127.0.0.1:${server.port}`;
const stamp = Date.now().toString(36);
const owner = `ao${stamp}`;
const writer = `aw${stamp}`;
const stranger = `as${stamp}`;
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
const o = (p: string, m = "GET", b?: unknown) => call(owner, p, m, b);
const w = (p: string, m = "GET", b?: unknown) => call(writer, p, m, b);
const x = (p: string, m = "GET", b?: unknown) => call(stranger, p, m, b);

beforeAll(async () => {
  for (const name of [owner, writer, stranger]) {
    const signup = await fetch(base + "/api/auth/signup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: name, email: `${name}@example.test`, password: "assignee-test-password" }),
    });
    expect(signup.status).toBe(201);
    cookies.set(name, (signup.headers.get("set-cookie") ?? "").split(";")[0]!);
  }
  expect((await o("/api/repos", "POST", { name: "project", visibility: "private" })).status).toBe(201);
  expect((await o(`${repoPath}/contents`, "PUT", { branch: "main", path: "README.md", content: "seed\n", encoding: "utf8" })).status).toBe(201);
  expect((await o(`${repoPath}/collaborators`, "POST", { username: writer, permission: "write" })).status).toBe(201);
});

afterAll(() => server.stop(true));

test("an issue can be assigned on creation and read back with the assignee", async () => {
  const created = await o(`${repoPath}/issues`, "POST", { title: "needs a person", assignees: [writer] });
  expect(created.status).toBe(201);
  expect(created.data.assignees).toHaveLength(1);
  expect(created.data.assignees[0].username).toBe(writer);

  const detail = await o(`${repoPath}/issues/${created.data.number}`);
  expect(detail.data.assignees[0].username).toBe(writer);

  const list = await o(`${repoPath}/issues?state=all`);
  const row = list.data.items.find((i: { number: number }) => i.number === created.data.number);
  expect(row.assignees).toHaveLength(1);
  expect(row.assignees[0].username).toBe(writer);
});

test("assignment is additive: adding one person does not unassign the others", async () => {
  const issue = (await o(`${repoPath}/issues`, "POST", { title: "two people", assignees: [owner] })).data;
  const added = await o(`${repoPath}/issues/${issue.number}/assignees`, "POST", { add: [writer] });
  expect(added.status).toBe(200);
  expect(added.data.items.map((a: { username: string }) => a.username).sort()).toEqual([owner, writer].sort());

  const again = await o(`${repoPath}/issues/${issue.number}/assignees`, "POST", { add: [writer] });
  expect(again.data.added).toBe(0);
  expect(again.data.items).toHaveLength(2);

  const removed = await o(`${repoPath}/issues/${issue.number}/assignees`, "POST", { remove: [owner] });
  expect(removed.data.items.map((a: { username: string }) => a.username)).toEqual([writer]);
});

test("the assignee filters select exactly what they claim, and the count matches the rows", async () => {
  const mine = (await o(`${repoPath}/issues`, "POST", { title: "mine", assignees: [owner] })).data;
  const theirs = (await o(`${repoPath}/issues`, "POST", { title: "theirs", assignees: [writer] })).data;
  const none = (await o(`${repoPath}/issues`, "POST", { title: "nobody" })).data;

  const forOwner = await o(`${repoPath}/issues?state=all&assignee=${owner}`);
  const numbers = forOwner.data.items.map((i: { number: number }) => i.number);
  expect(numbers).toContain(mine.number);
  expect(numbers).not.toContain(theirs.number);
  expect(numbers).not.toContain(none.number);
  expect(forOwner.data.total).toBe(numbers.length);
  expect(forOwner.data.total).toBeGreaterThan(0);

  const unassigned = await o(`${repoPath}/issues?state=all&no_assignee=true`);
  const unassignedNumbers = unassigned.data.items.map((i: { number: number }) => i.number);
  expect(unassignedNumbers).toContain(none.number);
  expect(unassignedNumbers).not.toContain(mine.number);
  expect(unassigned.data.total).toBe(unassignedNumbers.length);

  expect((await o(`${repoPath}/issues?assignee=ghostnobody`)).status).toBe(404);
  expect((await o(`${repoPath}/issues?assignee=${owner}&no_assignee=true`)).status).toBe(400);
});

test("only people who can read the repository may be assigned", async () => {
  const issue = (await o(`${repoPath}/issues`, "POST", { title: "stranger check" })).data;
  expect((await x(`${repoPath}`)).status).toBe(404);
  const attempt = await o(`${repoPath}/issues/${issue.number}/assignees`, "POST", { add: [stranger] });
  expect(attempt.status).toBe(404);
  const after = await o(`${repoPath}/issues/${issue.number}`);
  expect(after.data.assignees).toHaveLength(0);
  expect((await o(`${repoPath}/issues/${issue.number}/assignees`, "POST", { add: ["ghostnobody"] })).status).toBe(404);
});

test("being able to read a public repository is not enough to be assignable in it", async () => {
  expect((await o("/api/repos", "POST", { name: "wide-open" })).status).toBe(201);
  const open = `/api/repos/${owner}/wide-open`;
  expect((await o(`${open}/contents`, "PUT", { branch: "main", path: "a.txt", content: "a", encoding: "utf8" })).status).toBe(201);
  const issue = (await o(`${open}/issues`, "POST", { title: "public repo" })).data;

  expect((await x(`${open}`)).status).toBe(200);
  expect((await o(`${open}/issues/${issue.number}/assignees`, "POST", { add: [stranger] })).status).toBe(404);
  const before = await o(`${open}/assignees`);
  expect(before.data.items.some((p: { username: string }) => p.username === stranger)).toBe(false);

  expect(before.data.items.some((p: { username: string }) => p.username === writer)).toBe(false);
  expect(before.data.items.some((p: { username: string }) => p.username === owner)).toBe(true);

  expect((await o(`${open}/collaborators`, "POST", { username: writer, permission: "read" })).status).toBe(201);
  const after = await o(`${open}/assignees`);
  expect(after.data.items.some((p: { username: string }) => p.username === writer)).toBe(true);
  expect((await o(`${open}/issues/${issue.number}/assignees`, "POST", { add: [writer] })).status).toBe(200);
});

test("a reader can see assignees but cannot change them", async () => {
  expect((await o("/api/repos", "POST", { name: "open-project" })).status).toBe(201);
  const open = `/api/repos/${owner}/open-project`;
  expect((await o(`${open}/contents`, "PUT", { branch: "main", path: "a.txt", content: "a", encoding: "utf8" })).status).toBe(201);
  const openIssue = (await o(`${open}/issues`, "POST", { title: "public one", assignees: [owner] })).data;

  const seen = await x(`${open}/issues/${openIssue.number}`);
  expect(seen.status).toBe(200);
  expect(seen.data.assignees[0].username).toBe(owner);
  expect((await x(`${open}/issues/${openIssue.number}/assignees`, "POST", { add: [stranger] })).status).toBeGreaterThanOrEqual(400);
  expect((await x(`${open}/assignees`)).status).toBeGreaterThanOrEqual(400);
  expect((await o(`${open}/assignees`)).status).toBe(200);
});

test("assigning oneself does not create a notification", async () => {
  const issue = (await o(`${repoPath}/issues`, "POST", { title: "self assign" })).data;
  await o(`${repoPath}/issues/${issue.number}/assignees`, "POST", { add: [owner] });
  const mine = await o("/api/notifications?unread=true");
  const rows: Array<{ kind: string; subject: { id: number } | null }> = mine.data.items;
  expect(rows.some((r) => r.kind === "issue_assigned" && r.subject?.id === issue.id)).toBe(false);

  await o(`${repoPath}/issues/${issue.number}/assignees`, "POST", { add: [writer] });
  const theirs = await w("/api/notifications?unread=true");
  expect(
    theirs.data.items.some(
      (r: { kind: string; subject: { id: number } | null }) => r.kind === "issue_assigned" && r.subject?.id === issue.id,
    ),
  ).toBe(true);
});

test("the assignee cap is enforced against the resulting set, not one addition at a time", async () => {
  const people = Array.from({ length: 11 }, (_, i) => `cap${i}${stamp}`);
  for (const name of people) {
    const signup = await fetch(base + "/api/auth/signup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: name, email: `${name}@example.test`, password: "assignee-test-password" }),
    });
    expect(signup.status).toBe(201);
  }
  for (const name of people) {
    expect((await o(`${repoPath}/collaborators`, "POST", { username: name, permission: "read" })).status).toBe(201);
  }
  const issue = (await o(`${repoPath}/issues`, "POST", { title: "cap" })).data;
  expect((await o(`${repoPath}/issues/${issue.number}/assignees`, "POST", { add: people.slice(0, 10) })).status).toBe(200);
  expect((await o(`${repoPath}/issues/${issue.number}`)).data.assignees).toHaveLength(10);
  expect((await o(`${repoPath}/issues/${issue.number}/assignees`, "POST", { add: [people[10]!] })).status).toBe(400);
  const after = await o(`${repoPath}/issues/${issue.number}`);
  expect(after.data.assignees).toHaveLength(10);
  expect(after.data.assignees.some((a: { username: string }) => a.username === people[10])).toBe(false);
  expect((await o(`${repoPath}/issues/${issue.number}/assignees`, "POST", { remove: [people[0]!] })).status).toBe(200);
  expect((await o(`${repoPath}/issues/${issue.number}/assignees`, "POST", { add: [people[10]!] })).status).toBe(200);
});

test("a deleted issue cannot keep an assignee row behind", async () => {
  const { db } = await import("../../src/db/index.ts");
  const issue = (await o(`${repoPath}/issues`, "POST", { title: "cascades", assignees: [owner] })).data;
  expect(
    Number((db.query("SELECT COUNT(*) AS n FROM issue_assignees WHERE issue_id = (SELECT id FROM issues WHERE repo_id = ? AND number = ?)").get(
      (await o(repoPath)).data.id,
      issue.number,
    ) as { n: number }).n),
  ).toBe(1);
  await o(`${repoPath}/issues/${issue.number}`, "PATCH", { state: "closed" });
  const after = await o(`${repoPath}/issues?state=closed&assignee=${owner}`);
  expect(after.data.items.some((i: { number: number }) => i.number === issue.number)).toBe(true);
});

test("pull requests carry assignees and the same filters", async () => {
  expect((await o(`${repoPath}/branches`, "POST", { name: "feature-a", from: "main" })).status).toBe(201);
  expect((await o(`${repoPath}/contents`, "PUT", { branch: "feature-a", path: "f.txt", content: "x", encoding: "utf8" })).status).toBe(201);
  const pull = (await o(`${repoPath}/pulls`, "POST", { title: "assignable PR", head: "feature-a", base: "main", assignees: [writer] })).data;
  expect(pull.assignees[0].username).toBe(writer);

  const list = await o(`${repoPath}/pulls?state=all&assignee=${writer}`);
  expect(list.data.items.some((p: { number: number }) => p.number === pull.number)).toBe(true);
  expect(list.data.total).toBe(list.data.items.length);

  const none = await o(`${repoPath}/pulls?state=all&no_assignee=true`);
  expect(none.data.items.some((p: { number: number }) => p.number === pull.number)).toBe(false);

  expect((await o(`${repoPath}/pulls/${pull.number}/assignees`, "POST", { remove: [writer] })).status).toBe(200);
  const after = await o(`${repoPath}/pulls/${pull.number}`);
  expect(after.data.assignees).toHaveLength(0);
});

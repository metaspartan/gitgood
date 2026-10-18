import { afterAll, beforeAll, expect, test } from "bun:test";
import { createServer } from "../../src/server.ts";
import { db, migrate } from "../../src/db/index.ts";
import { normalizeTopic, MAX_TOPIC_LENGTH, MAX_TOPICS_PER_REPO } from "../../src/data/topics.ts";

migrate();

const server = createServer(0);
const base = `http://127.0.0.1:${server.port}`;
const stamp = Date.now().toString(36);
const owner = `to${stamp}`;
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
const x = (p: string, m = "GET", b?: unknown) => call(stranger, p, m, b);

const open = `/api/repos/${owner}/open-repo`;
const secret = `/api/repos/${owner}/secret-repo`;

beforeAll(async () => {
  for (const name of [owner, stranger]) {
    const signup = await fetch(base + "/api/auth/signup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: name, email: `${name}@example.test`, password: "topics-test-password" }),
    });
    expect(signup.status).toBe(201);
    cookies.set(name, (signup.headers.get("set-cookie") ?? "").split(";")[0]!);
  }
  expect((await o("/api/repos", "POST", { name: "open-repo" })).status).toBe(201);
  expect((await o("/api/repos", "POST", { name: "secret-repo", visibility: "private" })).status).toBe(201);
});

afterAll(() => server.stop(true));

test("topics are normalised on write, so one spelling means one row", async () => {
  const saved = await o(`${open}/topics`, "PUT", { names: ["Backend", "web-api", "  database  "] });
  expect(saved.status).toBe(200);
  expect(saved.data.topics).toEqual(["backend", "database", "web-api"]);
  expect(saved.data.topics_csv).toBe("backend,database,web-api");
  expect(saved.data.max_topics).toBe(MAX_TOPICS_PER_REPO);

  await o(`${open}/topics`, "PUT", { names: ["WEB-API", "Database", "backend"] });
  const readBack = await o(`${open}/topics`);
  expect(readBack.data.topics).toEqual(["backend", "database", "web-api"]);

  const rows = db.query("SELECT name, repo_count FROM topics WHERE name IN ('backend','web-api','database') ORDER BY name").all() as Array<{ name: string; repo_count: number }>;
  expect(rows).toEqual([
    { name: "backend", repo_count: 1 },
    { name: "database", repo_count: 1 },
    { name: "web-api", repo_count: 1 },
  ]);
});

test("the invalid forms a person actually types are each explained", () => {
  expect(() => normalizeTopic("")).toThrow(/empty/i);
  expect(() => normalizeTopic("a".repeat(MAX_TOPIC_LENGTH + 1))).toThrow(new RegExp(`${MAX_TOPIC_LENGTH}`));
  expect(() => normalizeTopic("web api")).toThrow(/hyphens/i);
  expect(() => normalizeTopic("web_api")).toThrow(/hyphens/i);
  expect(() => normalizeTopic("-leading")).toThrow(/hyphen/i);
  expect(() => normalizeTopic("trailing-")).toThrow(/hyphen/i);
  expect(() => normalizeTopic("emoji🎉")).toThrow(/letters, digits/i);
  expect(normalizeTopic("a")).toBe("a");
  expect(normalizeTopic("0")).toBe("0");
  expect(normalizeTopic("a".repeat(MAX_TOPIC_LENGTH))).toHaveLength(MAX_TOPIC_LENGTH);
  expect(normalizeTopic("web-api")).toBe("web-api");
  expect(normalizeTopic("  MiXeD-Case  ")).toBe("mixed-case");
});

test("the per-repository cap is enforced against the resulting set", async () => {
  const many = Array.from({ length: MAX_TOPICS_PER_REPO + 1 }, (_, i) => `topic-${i}`);
  const refused = await o(`${open}/topics`, "PUT", { names: many });
  expect(refused.status).toBe(400);
  expect((await o(`${open}/topics`)).data.topics).toEqual(["backend", "database", "web-api"]);

  expect((await o(`${open}/topics`, "PUT", { names: many.slice(0, MAX_TOPICS_PER_REPO) })).status).toBe(200);
  expect((await o(`${open}/topics`)).data.topics).toHaveLength(MAX_TOPICS_PER_REPO);
});

test("clearing sends an empty list, and the count follows it down", async () => {
  await o(`${open}/topics`, "PUT", { names: ["backend"] });
  const before = db.query("SELECT repo_count AS n FROM topics WHERE name = 'backend'").get() as { n: number };
  expect(before.n).toBe(1);
  const cleared = await o(`${open}/topics`, "PUT", { names_csv: "" });
  expect(cleared.status).toBe(200);
  expect(cleared.data.topics).toEqual([]);
  expect(cleared.data.topics_csv).toBe("");
  const after = db.query("SELECT repo_count AS n FROM topics WHERE name = 'backend'").get() as { n: number };
  expect(after.n).toBe(0);
});

test("two repositories sharing a topic keep one count, and removing one decrements it", async () => {
  expect((await o(`${secret}/topics`, "PUT", { names: ["backend", "internal-only"] })).status).toBe(200);
  let row = db.query("SELECT repo_count AS n FROM topics WHERE name = 'backend'").get() as { n: number };
  expect(row.n).toBe(1);

  await o(`${open}/topics`, "PUT", { names: ["backend"] });
  row = db.query("SELECT repo_count AS n FROM topics WHERE name = 'backend'").get() as { n: number };
  expect(row.n).toBe(2);

  await o(`${open}/topics`, "PUT", { names: ["backend"] });
  row = db.query("SELECT repo_count AS n FROM topics WHERE name = 'backend'").get() as { n: number };
  expect(row.n).toBe(2);

  await o(`${open}/topics`, "PUT", { names: [] });
  row = db.query("SELECT repo_count AS n FROM topics WHERE name = 'backend'").get() as { n: number };
  expect(row.n).toBe(1);

  await o(`${secret}/topics`, "PUT", { names: [] });
  await o(`${secret}/topics`, "PUT", { names: [] });
  row = db.query("SELECT repo_count AS n FROM topics WHERE name = 'backend'").get() as { n: number };
  expect(row.n).toBe(0);
});

test("the topic listing applies read access inside the query, so pages stay full", async () => {
  await o(`${open}/topics`, "PUT", { names: ["discoverable"] });
  await o(`${secret}/topics`, "PUT", { names: ["discoverable"] });

  const asOwner = await o("/api/topics/discoverable/repos");
  expect(asOwner.status).toBe(200);
  expect(asOwner.data.items).toHaveLength(2);
  expect(asOwner.data.total).toBe(2);

  const asStranger = await x("/api/topics/discoverable/repos");
  expect(asStranger.status).toBe(200);
  expect(asStranger.data.items).toHaveLength(1);
  expect(asStranger.data.total).toBe(1);
  expect(asStranger.data.items[0].name).toBe("open-repo");

  const unused = await o("/api/topics/nothing-uses-this/repos");
  expect(unused.status).toBe(200);
  expect(unused.data.items).toEqual([]);
  expect(unused.data.total).toBe(0);
});

test("the popular list only offers topics somebody is using", async () => {
  const popular = await o("/api/topics?limit=50");
  expect(popular.status).toBe(200);
  const names: string[] = popular.data.items.map((row: { name: string }) => row.name);
  expect(names).toContain("discoverable");
  expect(names).not.toContain("backend");
  for (const row of popular.data.items as Array<{ name: string; repo_count: number }>) {
    const actual = db.query("SELECT COUNT(*) AS n FROM repo_topics rt JOIN topics t ON t.id = rt.topic_id WHERE t.name = ?").get(row.name) as { n: number };
    expect(actual.n, `${row.name} count`).toBe(row.repo_count);
  }
});

test("a topic name is validated in the path too, not only on write", async () => {
  expect((await o("/api/topics/web%20api/repos")).status).toBe(400);
  expect((await o("/api/topics/ok-topic/repos")).status).toBe(200);
});

test("writing topics needs write access, and reading a private repository's topics does not leak", async () => {
  expect((await o(`${secret}/topics`)).status).toBe(200);
  expect((await x(`${secret}/topics`)).status).toBe(404);
  const attempt = await x(`${open}/topics`, "PUT", { names: ["hijacked"] });
  expect(attempt.status).toBeGreaterThanOrEqual(400);
  expect((await o(`${open}/topics`)).data.topics).not.toContain("hijacked");
});

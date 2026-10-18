import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createServer } from "../../src/server.ts";
import { notify } from "../../src/data/notifications.ts";
import { findRepo } from "../../src/data/repos.ts";
import { findUserByUsername } from "../../src/auth/service.ts";

const server = createServer(0);
const BASE = `http://127.0.0.1:${server.port}`;
const stamp = Date.now().toString(36);
const owner = `sw${stamp}`;
const fan = `sf${stamp}`;
const PASSWORD = "social-watch-password";

class Client {
  cookie = "";
  async call<T = any>(path: string, method = "GET", body?: unknown): Promise<{ status: number; data: T }> {
    const response = await fetch(BASE + path, {
      method,
      headers: { ...(this.cookie ? { cookie: this.cookie } : {}), ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const setCookie = response.headers.get("set-cookie");
    if (setCookie) this.cookie = setCookie.split(";")[0]!;
    const text = await response.text();
    return { status: response.status, data: (text ? JSON.parse(text) : null) as T };
  }
}

const me = new Client();
const other = new Client();

beforeAll(async () => {
  await me.call("/api/auth/signup", "POST", { username: owner, email: `${owner}@example.test`, password: PASSWORD });
  await other.call("/api/auth/signup", "POST", { username: fan, email: `${fan}@example.test`, password: PASSWORD });
  expect((await me.call("/api/repos", "POST", { name: "proj" })).status).toBe(201);
});
afterAll(() => server.stop(true));

describe("watch levels, counts and audience lists", () => {
  const path = () => `/api/repos/${owner}/proj`;

  test("the social state reports counts for anonymous visitors", async () => {
    const state = await new Client().call(`${path()}/watch`);
    expect(state.data).toMatchObject({ watching: false, watch_level: "participating", starring: false, stars: 0, watchers: 0, forks: 0 });
  });

  test("all activity, ignore and participating round-trip and move the watcher count", async () => {
    const all = await other.call(`${path()}/watch`, "PUT", { level: "all" });
    expect(all.data).toMatchObject({ watching: true, watch_level: "all", watchers: 1 });
    const list = await me.call<{ items: { username: string }[] }>(`${path()}/watchers`);
    expect(list.data.items.map((i) => i.username)).toEqual([fan]);
    const ignore = await other.call(`${path()}/watch`, "PUT", { level: "ignore" });
    expect(ignore.data).toMatchObject({ watching: false, watch_level: "ignore", watchers: 0 });
    const back = await other.call(`${path()}/watch`, "DELETE");
    expect(back.data).toMatchObject({ watch_level: "participating", watchers: 0 });
  });

  test("a bodiless PUT keeps the old behaviour of watching all activity", async () => {
    const res = await fetch(`${BASE}${path()}/watch`, { method: "PUT", headers: { cookie: other.cookie } });
    expect((await res.json()).watch_level).toBe("all");
    await other.call(`${path()}/watch`, "DELETE");
  });

  test("an unknown level is rejected and anonymous callers cannot watch", async () => {
    expect((await other.call(`${path()}/watch`, "PUT", { level: "loud" })).status).toBe(400);
    expect((await new Client().call(`${path()}/watch`, "PUT", { level: "all" })).status).toBeGreaterThanOrEqual(400);
  });

  test("ignoring a repository suppresses its notifications, including mentions", async () => {
    const repo = findRepo(owner, "proj")!;
    const fanId = findUserByUsername(fan)!.id;
    expect(notify({ userId: fanId, kind: "issue_commented", repoId: repo.id, dedupeKey: `m1-${stamp}` })).toBeGreaterThan(0);
    await other.call(`${path()}/watch`, "PUT", { level: "ignore" });
    expect(notify({ userId: fanId, kind: "issue_commented", repoId: repo.id, dedupeKey: `m2-${stamp}` })).toBe(0);
    await other.call(`${path()}/watch`, "DELETE");
    expect(notify({ userId: fanId, kind: "issue_commented", repoId: repo.id, dedupeKey: `m3-${stamp}` })).toBeGreaterThan(0);
  });

  test("forks are counted in the social state", async () => {
    expect((await other.call(`${path()}/forks`, "POST", {})).status).toBe(201);
    expect((await me.call(`${path()}/watch`)).data.forks).toBe(1);
  });
});

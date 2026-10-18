import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createServer } from "../../src/server.ts";
import { changes } from "../../src/db/index.ts";
import { findUserByUsername } from "../../src/auth/service.ts";

const server = createServer(0);
const BASE = `http://127.0.0.1:${server.port}`;
const stamp = Date.now().toString(36);
const alice = `pa${stamp}`;
const bob = `pb${stamp}`;
const PASSWORD = "profile-stars-password";

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

const a = new Client();
const b = new Client();
const anon = new Client();

beforeAll(async () => {
  await a.call("/api/auth/signup", "POST", { username: alice, email: `${alice}@example.test`, password: PASSWORD });
  await b.call("/api/auth/signup", "POST", { username: bob, email: `${bob}@example.test`, password: PASSWORD });
  expect((await a.call("/api/repos", "POST", { name: "open" })).status).toBe(201);
  expect((await a.call("/api/repos", "POST", { name: "hidden", visibility: "private" })).status).toBe(201);
  expect((await a.call(`/api/repos/${alice}/open/star`, "PUT", {})).status).toBe(200);
  expect((await a.call(`/api/repos/${alice}/hidden/star`, "PUT", {})).status).toBe(200);
});
afterAll(() => server.stop(true));

describe("profile stars and counts", () => {
  test("the owner sees both starred repositories, newest first", async () => {
    const starred = await a.call<{ items: { full_name: string }[] }>(`/api/users/${alice}/starred`);
    expect(starred.data.items.map((r) => r.full_name)).toEqual([`${alice}/hidden`, `${alice}/open`]);
    const profile = await a.call<{ repo_count: number; star_count: number }>(`/api/users/${alice}`);
    expect(profile.data).toMatchObject({ repo_count: 2, star_count: 2 });
  });

  test("other people and anonymous visitors never learn about private stars or repositories", async () => {
    for (const viewer of [b, anon]) {
      const starred = await viewer.call<{ items: { full_name: string }[] }>(`/api/users/${alice}/starred`);
      expect(starred.data.items.map((r) => r.full_name)).toEqual([`${alice}/open`]);
      const profile = await viewer.call<{ repo_count: number; star_count: number }>(`/api/users/${alice}`);
      expect(profile.data).toMatchObject({ repo_count: 1, star_count: 1 });
    }
  });

  test("stars made in the same millisecond still list newest first", async () => {
    changes("UPDATE stars SET created_at = 1 WHERE user_id = ?", findUserByUsername(alice)!.id);
    const starred = await a.call<{ items: { full_name: string }[] }>(`/api/users/${alice}/starred`);
    expect(starred.data.items.map((r) => r.full_name)).toEqual([`${alice}/hidden`, `${alice}/open`]);
  });

  test("an unknown user is a 404", async () => {
    expect((await anon.call(`/api/users/nobody-${stamp}/starred`)).status).toBe(404);
  });
});

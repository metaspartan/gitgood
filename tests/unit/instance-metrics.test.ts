import { expect, test } from "bun:test";
import { Router, type RouteContext } from "../../src/api/router.ts";
import { registerBackupRoutes } from "../../src/api/routes/backups.ts";
import { collectInstanceMetrics } from "../../src/data/instance-metrics.ts";
import { db, migrate } from "../../src/db/index.ts";

migrate();

test("instance metrics report live counters and reject every non-admin caller", async () => {
  const before = collectInstanceMetrics();
  const suffix = crypto.randomUUID().slice(0, 8);
  const username = `metrics${suffix}`;
  db.query("INSERT INTO users(username,email,password_hash,display_name,is_admin,created_at) VALUES(?,?,?,?,1,?)")
    .run(username, `${username}@example.test`, "test", "Metrics Admin", Date.now());
  const userId = (db.query("SELECT id FROM users WHERE username = ?").get(username) as { id: number }).id;
  db.query("INSERT INTO repos(owner_id,name,created_at,updated_at) VALUES(?,?,?,?)")
    .run(userId, `metrics${suffix}`, Date.now(), Date.now());

  const router = new Router();
  registerBackupRoutes(router);
  const request = new Request("http://localhost/api/admin/metrics");
  const admin = { kind: "user", userId: 1, username: "admin", isAdmin: true, via: "session", scopes: ["admin"] };

  const response = await router.match("GET", "/api/admin/metrics")!.handler({
    request, url: new URL(request.url), params: {}, ip: "127.0.0.1", auth: admin,
  } as RouteContext);
  expect(response.headers.get("cache-control")).toBe("no-store");
  const body = await response.json();

  const expected = collectInstanceMetrics();
  expect(Object.keys(body).sort()).toEqual(Object.keys(expected).sort());
  for (const [key, value] of Object.entries(body)) {
    expect(typeof value).toBe("number");
    expect(Number.isSafeInteger(value)).toBe(true);
    expect(value as number).toBeGreaterThanOrEqual(0);
    expect(value as number).toBe(expected[key as keyof typeof expected]);
  }
  expect(body.users).toBe(before.users + 1);
  expect(body.admins).toBe(before.admins + 1);
  expect(body.repos).toBe(before.repos + 1);
  expect(body.archivedRepos).toBe(before.archivedRepos);
  expect(body.lfsBytes).toBe(before.lfsBytes);

  for (const auth of [
    { kind: "anonymous" },
    { kind: "user", userId: 2, username: "someone", isAdmin: false, via: "session", scopes: ["read"] },
    { kind: "user", userId: 1, username: "admin", isAdmin: true, via: "token", scopes: ["admin"] },
  ]) {
    await expect(Promise.resolve().then(() => router.match("GET", "/api/admin/metrics")!.handler({
      request, url: new URL(request.url), params: {}, ip: "127.0.0.1", auth,
    } as RouteContext))).rejects.toThrow();
  }
});

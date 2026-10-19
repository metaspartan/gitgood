import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createServer } from "../../src/server.ts";
import { changes } from "../../src/db/index.ts";
import { findUserByUsername } from "../../src/auth/service.ts";

const server = createServer(0);
const BASE = `http://127.0.0.1:${server.port}`;
const stamp = Date.now().toString(36);
const admin = `sa${stamp}`;
const member = `sm${stamp}`;
const PASSWORD = "sessions-audit-password";

class Client {
  cookie = "";
  constructor(private readonly agent = "test-agent") {}
  async call<T = any>(path: string, method = "GET", body?: unknown): Promise<{ status: number; data: T }> {
    const response = await fetch(BASE + path, {
      method,
      headers: {
        "user-agent": this.agent,
        ...(this.cookie ? { cookie: this.cookie } : {}),
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const setCookie = response.headers.get("set-cookie");
    if (setCookie) this.cookie = setCookie.split(";")[0]!;
    const text = await response.text();
    return { status: response.status, data: (text ? JSON.parse(text) : null) as T };
  }
  login(username: string) {
    return this.call("/api/auth/login", "POST", { username, password: PASSWORD });
  }
}

const root = new Client("root-browser");
const laptop = new Client("Mozilla/5.0 (Laptop)");
const phone = new Client("Mozilla/5.0 (Phone)");

beforeAll(async () => {
  await root.call("/api/auth/signup", "POST", { username: admin, email: `${admin}@example.test`, password: PASSWORD });
  changes("UPDATE users SET is_admin = 1 WHERE username = ?", admin);
  const signup = new Client("signup-browser");
  await signup.call("/api/auth/signup", "POST", { username: member, email: `${member}@example.test`, password: PASSWORD });
  await signup.call("/api/auth/logout", "POST", {});
  expect((await laptop.login(member)).status).toBe(200);
  expect((await phone.login(member)).status).toBe(200);
});
afterAll(() => server.stop(true));

type Session = { id: string; current: boolean; user_agent: string | null; ip: string | null };

describe("account sessions", () => {
  test("each device sees every active session, its own marked current, without exposing session secrets", async () => {
    const list = await laptop.call<{ items: Session[] }>("/api/account/sessions");
    expect(list.status).toBe(200);
    expect(list.data.items.length).toBe(2);
    expect(list.data.items.filter((s) => s.current).map((s) => s.user_agent)).toEqual(["Mozilla/5.0 (Laptop)"]);
    expect(list.data.items.map((s) => s.user_agent).sort()).toEqual(["Mozilla/5.0 (Laptop)", "Mozilla/5.0 (Phone)"]);
    const secret = laptop.cookie.split("=")[1]!;
    expect(JSON.stringify(list.data)).not.toContain(secret);
    for (const s of list.data.items) expect(s.id).toMatch(/^[0-9a-f]{20}$/);
  });

  test("revoking one session signs that device out and leaves the others", async () => {
    const list = await laptop.call<{ items: Session[] }>("/api/account/sessions");
    const phoneSession = list.data.items.find((s) => !s.current)!;
    expect((await laptop.call(`/api/account/sessions/${phoneSession.id}`, "DELETE")).status).toBe(204);
    expect((await phone.call<{ user: unknown }>("/api/auth/me")).data.user).toBeNull();
    expect((await laptop.call<{ user: { username: string } }>("/api/auth/me")).data.user.username).toBe(member);
  });

  test("another user's session id, or a malformed id, is a 404", async () => {
    const mine = await root.call<{ items: Session[] }>("/api/account/sessions");
    expect((await laptop.call(`/api/account/sessions/${mine.data.items[0]!.id}`, "DELETE")).status).toBe(404);
    expect((await laptop.call("/api/account/sessions/not-an-id", "DELETE")).status).toBe(404);
    expect((await root.call<{ user: { username: string } }>("/api/auth/me")).data.user.username).toBe(admin);
  });

  test("sign out everywhere else keeps only the current session", async () => {
    await phone.login(member);
    const tablet = new Client("Tablet");
    await tablet.login(member);
    const result = await laptop.call<{ revoked: number }>("/api/account/sessions/revoke-others", "POST", {});
    expect(result.data.revoked).toBe(2);
    expect((await tablet.call<{ user: unknown }>("/api/auth/me")).data.user).toBeNull();
    const after = await laptop.call<{ items: Session[] }>("/api/account/sessions");
    expect(after.data.items.map((s) => s.current)).toEqual([true]);
  });

  test("anonymous callers cannot list sessions", async () => {
    expect((await new Client().call("/api/account/sessions")).status).toBe(401);
  });
});

describe("admin user management and audit log", () => {
  const memberId = () => findUserByUsername(member)!.id;

  test("the user list reports two-factor status and active session count", async () => {
    const list = await root.call<{ items: { username: string; two_factor: boolean; session_count: number }[] }>(`/api/admin/users?q=${member}`);
    expect(list.data.items[0]).toMatchObject({ username: member, two_factor: false, session_count: 1 });
  });

  test("an administrator can sign a user out everywhere", async () => {
    expect((await root.call(`/api/admin/users/${memberId()}`, "PATCH", { sign_out: true })).status).toBe(200);
    expect((await laptop.call<{ user: unknown }>("/api/auth/me")).data.user).toBeNull();
  });

  test("an administrator can reset another user's two-factor, but not their own", async () => {
    changes("UPDATE users SET totp_secret = 'JBSWY3DPEHPK3PXP', totp_confirmed_at = 1 WHERE id = ?", memberId());
    const before = await root.call<{ items: { two_factor: boolean }[] }>(`/api/admin/users?q=${member}`);
    expect(before.data.items[0]!.two_factor).toBe(true);
    expect((await root.call(`/api/admin/users/${memberId()}`, "PATCH", { reset_two_factor: true })).status).toBe(200);
    const after = await root.call<{ items: { two_factor: boolean }[] }>(`/api/admin/users?q=${member}`);
    expect(after.data.items[0]!.two_factor).toBe(false);
    const selfId = findUserByUsername(admin)!.id;
    expect((await root.call(`/api/admin/users/${selfId}`, "PATCH", { reset_two_factor: true })).status).toBe(409);
  });

  test("administrative actions are recorded with actor, target and address, newest first, and are searchable", async () => {
    await root.call("/api/admin/settings", "PUT", { allow_signup: true });
    const log = await root.call<{ items: { actor_username: string; action: string; target: string; ip: string }[]; total: number }>("/api/admin/audit");
    expect(log.status).toBe(200);
    const actions = log.data.items.map((entry) => entry.action);
    expect(actions[0]).toBe("settings.update");
    expect(actions).toContain("user.sign_out");
    expect(actions).toContain("user.two_factor_reset");
    expect(log.data.items.find((e) => e.action === "user.sign_out")).toMatchObject({ actor_username: admin, target: member });
    expect(log.data.items[0]!.ip).not.toBe("");
    const filtered = await root.call<{ items: { action: string }[] }>("/api/admin/audit?q=two_factor");
    expect(filtered.data.items.map((e) => e.action)).toEqual(["user.two_factor_reset"]);
  });

  test("non-administrators cannot read the audit log", async () => {
    const other = new Client();
    await other.login(member);
    expect((await other.call("/api/admin/audit")).status).toBe(403);
    expect((await new Client().call("/api/admin/audit")).status).toBe(401);
  });
});

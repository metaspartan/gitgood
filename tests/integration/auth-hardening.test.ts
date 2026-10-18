import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createServer } from "../../src/server.ts";
import { changes } from "../../src/db/index.ts";
import { findUserByUsername } from "../../src/auth/service.ts";
import { generateTotpSecret, totpAt } from "../../src/auth/totp.ts";
import { resetLoginThrottle } from "../../src/auth/login-throttle.ts";
import { authRateLimiter } from "../../src/lib/rate-limit.ts";
import { createWebhook, dispatchWebhooks, listDeliveries } from "../../src/data/webhooks.ts";
import { findRepo } from "../../src/data/repos.ts";

const server = createServer(0);
const BASE = `http://127.0.0.1:${server.port}`;
const stamp = Date.now().toString(36);
const mfaUser = `am${stamp}`;
const plainUser = `ap${stamp}`;
const PASSWORD = "auth-hardening-password";
const basic = (user: string, password = PASSWORD) => `Basic ${Buffer.from(`${user}:${password}`).toString("base64")}`;
let secret = "";
let token = "";

async function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  return fetch(BASE + path, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
}
async function me(headers: Record<string, string>) {
  return ((await (await fetch(`${BASE}/api/auth/me`, { headers })).json()) as { user: { username: string } | null }).user;
}

beforeAll(async () => {
  for (const name of [mfaUser, plainUser]) await post("/api/auth/signup", { username: name, email: `${name}@example.test`, password: PASSWORD });
  const id = findUserByUsername(mfaUser)!.id;
  secret = generateTotpSecret(mfaUser).secret;
  changes("UPDATE users SET totp_secret = ?, totp_confirmed_at = ? WHERE id = ?", secret, Date.now(), id);
  const signin = await post("/api/auth/login", { username: plainUser, password: PASSWORD });
  const cookie = signin.headers.get("set-cookie")!.split(";")[0]!;
  token = ((await (await post("/api/tokens", { name: "ci", scopes: ["read", "write"] }, { cookie })).json()) as { token: string }).token;
});
afterAll(() => server.stop(true));

describe("password authentication outside the login form", () => {
  test("Basic auth with a password works for an account without two-factor, and tokens always work", async () => {
    resetLoginThrottle();
    expect((await me({ authorization: basic(plainUser) }))?.username).toBe(plainUser);
    expect((await me({ authorization: `Bearer ${token}` }))?.username).toBe(plainUser);
  });

  test("Basic auth with only a password cannot bypass two-factor", async () => {
    resetLoginThrottle();
    expect(await me({ authorization: basic(mfaUser) })).toBeNull();
  });

  test("repeated wrong Basic passwords lock the account, so guessing through any endpoint is throttled", async () => {
    resetLoginThrottle();
    for (let i = 0; i < 12; i += 1) await me({ authorization: basic(plainUser, `wrong-${i}`) });
    expect(await me({ authorization: basic(plainUser) })).toBeNull();
    resetLoginThrottle();
    expect((await me({ authorization: basic(plainUser) }))?.username).toBe(plainUser);
  });
});

describe("two-factor code guessing", () => {
  test("wrong codes accumulate even though the password is right each time", async () => {
    resetLoginThrottle();
    authRateLimiter.reset();
    const statuses: number[] = [];
    for (let i = 0; i < 12; i += 1) {
      const login = await post("/api/auth/login", { username: mfaUser, password: PASSWORD });
      statuses.push(login.status);
      const attempt = await post("/api/auth/login/mfa", { username: mfaUser, password: PASSWORD, code: "000000" === totpAt(secret, Math.floor(Date.now() / 1000)) ? "111111" : "000000" });
      statuses.push(attempt.status);
    }
    expect(statuses).toContain(429);
    const valid = await post("/api/auth/login/mfa", { username: mfaUser, password: PASSWORD, code: totpAt(secret, Math.floor(Date.now() / 1000)) });
    expect(valid.status).toBe(429);
    resetLoginThrottle();
  });
});

describe("webhook redirects", () => {
  test("a webhook that redirects is not followed", async () => {
    let followed = 0;
    const internal = Bun.serve({ port: 0, fetch: () => { followed += 1; return new Response("internal"); } });
    const redirector = Bun.serve({ port: 0, fetch: () => Response.redirect(`http://127.0.0.1:${internal.port}/meta`, 302) });
    const previous = process.env.GITGOOD_WEBHOOK_ALLOW_PRIVATE;
    process.env.GITGOOD_WEBHOOK_ALLOW_PRIVATE = "1";
    try {
      await post("/api/repos", { name: "hooked" }, { authorization: basic(plainUser) });
      const repo = findRepo(plainUser, "hooked")!;
      const hook = createWebhook(repo.id, `http://127.0.0.1:${redirector.port}/hook`, "s3cret", ["push"]);
      dispatchWebhooks(repo.id, { event: "push", payload: { ref: "refs/heads/main" } } as never);
      for (let i = 0; i < 40 && listDeliveries(hook.id).length === 0; i += 1) await Bun.sleep(50);
      const [delivery] = listDeliveries(hook.id);
      expect(delivery).toBeDefined();
      expect(followed).toBe(0);
      expect(JSON.stringify(delivery)).toContain("redirect_not_followed");
    } finally {
      if (previous === undefined) delete process.env.GITGOOD_WEBHOOK_ALLOW_PRIVATE;
      else process.env.GITGOOD_WEBHOOK_ALLOW_PRIVATE = previous;
      internal.stop(true);
      redirector.stop(true);
    }
  });
});

describe("push quota checks run after authorisation", () => {
  test("an anonymous push to a private over-quota repository learns nothing about it", async () => {
    await post("/api/repos", { name: "full", visibility: "private" }, { authorization: basic(plainUser) });
    changes("UPDATE repos SET quota_bytes = 1 WHERE name = 'full' AND owner_id = ?", findUserByUsername(plainUser)!.id);
    const response = await fetch(`${BASE}/${plainUser}/full.git/git-receive-pack`, {
      method: "POST",
      headers: { "content-type": "application/x-git-receive-pack-request", "content-length": "4" },
      body: "0000",
    });
    const text = await response.text();
    expect(response.status).toBe(401);
    expect(text).not.toContain("storage limit");
  });
});

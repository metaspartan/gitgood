import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { createServer } from "../../src/server.ts";
import { resetLoginThrottle } from "../../src/auth/login-throttle.ts";
import { authRateLimiter } from "../../src/lib/rate-limit.ts";

const server = createServer(0);
const base = `http://127.0.0.1:${server.port}`;
const stamp = Date.now().toString(36);
const owner = `lt${stamp}`;
const bystander = `lb${stamp}`;
const stranger = `ls${stamp}`;
const PASSWORD = "throttle-test-password";

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
  return { status: response.status, data: await response.json().catch(() => ({})), headers: response.headers };
}

const login = (who: string, password: string) => call(who, "/api/auth/login", "POST", { username: who, password });
const loginAs = (username: string, password: string) =>
  call("attacker", "/api/auth/login", "POST", { username, password });

beforeAll(async () => {
  for (const name of [owner, bystander, stranger]) {
    const signup = await call(name, "/api/auth/signup", "POST", {
      username: name,
      email: `${name}@example.test`,
      password: PASSWORD,
    });
    expect(signup.status).toBe(201);
  }
});

afterAll(() => server.stop(true));
afterEach(() => {
  resetLoginThrottle();
  authRateLimiter.reset();
});

test("repeated failures against one account are throttled even though the IP never changes", async () => {
  let firstThrottle: { status: number; retryAfter?: number } | null = null;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const response = await loginAs(owner, `wrong-${attempt}`);
    if (response.status === 429) {
      firstThrottle = {
        status: response.status,
        retryAfter: (response.data.error as { details?: { retry_after_seconds?: number } } | undefined)?.details
          ?.retry_after_seconds,
      };
      break;
    }
    expect(response.status).toBe(401);
  }

  expect(firstThrottle, "one account should reach a throttle").not.toBeNull();
  expect(firstThrottle!.status).toBe(429);
  expect(firstThrottle!.retryAfter).toBeGreaterThan(0);
  const again = await loginAs(owner, "wrong-again");
  expect(again.status).toBe(429);
  expect(Number(again.headers.get("retry-after"))).toBeGreaterThan(0);
});

test("the correct password is refused while the backoff is in force, then works once it elapses", async () => {
  for (let attempt = 0; attempt < 8; attempt += 1) await loginAs(owner, `wrong-${attempt}`);
  expect((await loginAs(owner, PASSWORD)).status).toBe(429);

  await new Promise((resolve) => setTimeout(resolve, 0));
  expect((await loginAs(owner, PASSWORD)).status).toBe(429);
});

test("a real owner's successful sign-in clears the penalty, so a fumbled password is not punished", async () => {
  for (let attempt = 0; attempt < 3; attempt += 1) await loginAs(owner, `typo-${attempt}`);
  expect((await login(owner, PASSWORD)).status).toBe(200);
  for (let attempt = 0; attempt < 3; attempt += 1) await loginAs(owner, `typo-again-${attempt}`);
  expect((await loginAs(owner, "still-wrong")).status).toBe(401);
});

test("throttling one account does not affect another", async () => {
  for (let attempt = 0; attempt < 10; attempt += 1) await loginAs(owner, `wrong-${attempt}`);
  expect((await loginAs(owner, PASSWORD)).status).toBe(429);
  authRateLimiter.reset();
  expect((await login(bystander, PASSWORD)).status).toBe(200);
});

test("a username that does not exist is throttled identically, so this cannot enumerate accounts", async () => {
  for (let attempt = 0; attempt < 10; attempt += 1) await loginAs("definitely-not-a-real-account", `x-${attempt}`);
  const ghost = await loginAs("definitely-not-a-real-account", "x-again");
  expect(ghost.status).toBe(429);

  resetLoginThrottle();
  authRateLimiter.reset();
  const real = await loginAs(owner, "wrong");
  const fake = await loginAs("definitely-not-a-real-account", "wrong");
  expect(real.status).toBe(401);
  expect(fake.status).toBe(401);
  expect((real.data.error as { message: string }).message).toBe((fake.data.error as { message: string }).message);
});

test("case variants of a username share one budget", async () => {
  for (let attempt = 0; attempt < 6; attempt += 1) await loginAs(owner.toUpperCase(), `wrong-${attempt}`);
  expect((await loginAs(owner.toLowerCase(), "wrong")).status).toBe(429);
});

test("the throttle is not a lockout: it never refuses indefinitely", async () => {
  let sawThrottle = false;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const response = await loginAs(owner, `wrong-${attempt}`);
    if (response.status === 429) {
      sawThrottle = true;
      const wait = (response.data.error as { details?: { retry_after_seconds?: number } }).details
        ?.retry_after_seconds ?? 0;
      expect(wait).toBeGreaterThan(0);
      expect(wait).toBeLessThanOrEqual(15 * 60);
    }
  }
  expect(sawThrottle).toBe(true);
});

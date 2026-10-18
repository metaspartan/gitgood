import { afterEach, expect, test } from "bun:test";
import {
  checkLoginThrottle,
  recordLoginFailure,
  recordLoginSuccess,
  resetLoginThrottle,
  retryAfterSeconds,
  throttleKey,
  trackedAccounts,
  THROTTLE_LIMITS,
} from "../../src/auth/login-throttle.ts";

afterEach(() => resetLoginThrottle());

test("the first few mistakes are not punished", () => {
  for (let attempt = 1; attempt <= THROTTLE_LIMITS.FREE_ATTEMPTS; attempt += 1) {
    const state = recordLoginFailure("alice");
    expect(state.consecutiveFailures).toBe(attempt);
  }
  expect(checkLoginThrottle("alice").blocked).toBe(false);
});

test("the delay doubles with each consecutive failure, then holds at the cap", () => {
  const seen: number[] = [];
  for (let attempt = 0; attempt < 18; attempt += 1) seen.push(recordLoginFailure("alice").retryAfterMs);

  expect(seen.slice(0, THROTTLE_LIMITS.FREE_ATTEMPTS).every((ms) => ms === 0)).toBe(true);
  expect(seen[THROTTLE_LIMITS.FREE_ATTEMPTS]).toBe(1000);
  expect(seen[THROTTLE_LIMITS.FREE_ATTEMPTS + 1]).toBe(2000);
  expect(seen[THROTTLE_LIMITS.FREE_ATTEMPTS + 2]).toBe(4000);
  for (let i = 1; i < seen.length; i += 1) expect(seen[i]).toBeGreaterThanOrEqual(seen[i - 1]!);

  expect(seen.at(-1)).toBe(THROTTLE_LIMITS.MAX_DELAY_MS);
  const firstCapped = seen.findIndex((ms) => ms === THROTTLE_LIMITS.MAX_DELAY_MS);
  expect(firstCapped).toBeGreaterThan(0);
  expect(seen.slice(firstCapped).every((ms) => ms === THROTTLE_LIMITS.MAX_DELAY_MS)).toBe(true);
});

test("one account is throttled no matter how many addresses the attempts come from", () => {
  for (let source = 0; source < 200; source += 1) {
    recordLoginFailure("victim");
  }
  const state = checkLoginThrottle("victim");
  expect(state.blocked).toBe(true);
  expect(state.retryAfterMs).toBeGreaterThan(0);
  expect(state.consecutiveFailures).toBe(200);
});

test("throttling one account leaves every other account alone", () => {
  for (let attempt = 0; attempt < 12; attempt += 1) recordLoginFailure("victim");
  expect(checkLoginThrottle("victim").blocked).toBe(true);
  expect(checkLoginThrottle("bystander").blocked).toBe(false);
  expect(checkLoginThrottle("").blocked).toBe(false);
});

test("case and surrounding whitespace share one budget", () => {
  expect(throttleKey("  AlIcE  ")).toBe("alice");
  for (let attempt = 0; attempt < 8; attempt += 1) recordLoginFailure("Alice");
  expect(checkLoginThrottle("alice").blocked).toBe(true);
  expect(checkLoginThrottle("  ALICE ").blocked).toBe(true);
});

test("a successful password clears the streak", () => {
  for (let attempt = 0; attempt < 8; attempt += 1) recordLoginFailure("alice");
  expect(checkLoginThrottle("alice").blocked).toBe(true);
  recordLoginSuccess("alice");
  expect(checkLoginThrottle("alice").blocked).toBe(false);
  expect(checkLoginThrottle("alice").consecutiveFailures).toBe(0);
  expect(recordLoginFailure("alice").consecutiveFailures).toBe(1);
});

test("the wait elapses, and the delay is released exactly when it says", () => {
  const start = 1_800_000_000_000;
  for (let attempt = 0; attempt < 8; attempt += 1) recordLoginFailure("alice", start);
  const blocked = checkLoginThrottle("alice", start);
  expect(blocked.blocked).toBe(true);

  expect(checkLoginThrottle("alice", start + blocked.retryAfterMs - 1).blocked).toBe(true);
  expect(checkLoginThrottle("alice", start + blocked.retryAfterMs).blocked).toBe(false);
});

test("an old streak decays rather than accumulating forever", () => {
  const start = 1_800_000_000_000;
  for (let attempt = 0; attempt < 10; attempt += 1) recordLoginFailure("alice", start);
  expect(checkLoginThrottle("alice", start).blocked).toBe(true);

  const muchLater = start + 7 * 24 * 60 * 60 * 1000;
  expect(checkLoginThrottle("alice", muchLater).blocked).toBe(false);
  expect(recordLoginFailure("alice", muchLater).consecutiveFailures).toBe(1);
});

test("the streak survives the wait, so spacing attempts does not reset it", () => {
  let now = 1_800_000_000_000;
  for (let round = 0; round < 5; round += 1) {
    const blocked = checkLoginThrottle("alice", now);
    if (blocked.blocked) now += blocked.retryAfterMs;
    recordLoginFailure("alice", now);
  }
  expect(checkLoginThrottle("alice", now).consecutiveFailures).toBe(5);
  expect(checkLoginThrottle("alice", now).retryAfterMs).toBeGreaterThan(0);
});

test("retryAfterSeconds never reports a wait of zero", () => {
  expect(retryAfterSeconds(0)).toBe(1);
  expect(retryAfterSeconds(1)).toBe(1);
  expect(retryAfterSeconds(1000)).toBe(1);
  expect(retryAfterSeconds(1001)).toBe(2);
  expect(retryAfterSeconds(THROTTLE_LIMITS.MAX_DELAY_MS)).toBe(Math.ceil(THROTTLE_LIMITS.MAX_DELAY_MS / 1000));
});

test("the tracked set is bounded, so a spray of random usernames cannot exhaust memory", () => {
  const NAMES = 5_000;
  const PER_NAME = 6;
  for (let i = 0; i < NAMES; i += 1) {
    for (let attempt = 0; attempt < PER_NAME; attempt += 1) recordLoginFailure(`spray-${i}`);
  }
  expect(trackedAccounts()).toBeLessThanOrEqual(20_000);

  const survivors = trackedAccounts();
  expect(survivors).toBeGreaterThan(0);
  let throttled = 0;
  for (let i = 0; i < NAMES && throttled < 1; i += 1) {
    if (checkLoginThrottle(`spray-${i}`).blocked) throttled += 1;
  }
  expect(throttled, "evicting old entries must not leave every account unthrottled").toBe(1);
});

test("a stale entry is preferred for eviction over a live one", () => {
  const now = 1_800_000_000_000;
  for (let i = 0; i < 12; i += 1) recordLoginFailure("long-lived", now);
  expect(checkLoginThrottle("long-lived", now).blocked).toBe(true);

  for (let i = 0; i < 20_100; i += 1) recordLoginFailure(`filler-${i}`, now);
  const muchLater = now + 7 * 24 * 60 * 60 * 1000;
  recordLoginFailure("trigger", muchLater);
  expect(checkLoginThrottle("long-lived", muchLater).blocked).toBe(false);
});

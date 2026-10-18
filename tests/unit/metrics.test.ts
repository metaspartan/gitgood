import { describe, expect, test } from "bun:test";
import { RateLimiter } from "../../src/lib/rate-limit.ts";
import { increment, observe, snapshot } from "../../src/lib/metrics.ts";
import { generateAccessToken, hueFor, sha256Hex, slugify } from "../../src/lib/ids.ts";

describe("rate limiter", () => {
  test("allows up to capacity then rejects", () => {
    const limiter = new RateLimiter(3, 60_000);
    expect(limiter.check("a")).toBe(true);
    expect(limiter.check("a")).toBe(true);
    expect(limiter.check("a")).toBe(true);
    expect(limiter.check("a")).toBe(false);
  });

  test("tracks keys independently", () => {
    const limiter = new RateLimiter(1, 60_000);
    expect(limiter.check("a")).toBe(true);
    expect(limiter.check("b")).toBe(true);
    expect(limiter.check("a")).toBe(false);
  });

  test("supports weighted costs", () => {
    const limiter = new RateLimiter(10, 60_000);
    expect(limiter.check("a", 8)).toBe(true);
    expect(limiter.check("a", 3)).toBe(false);
    expect(limiter.check("a", 2)).toBe(true);
  });
});

describe("metrics", () => {
  test("counters accumulate and latencies summarise", () => {
    increment("test_counter_total");
    increment("test_counter_total", 2);
    for (let i = 1; i <= 100; i++) observe("test_latency_ms", i);
    const summary = snapshot("test_latency_ms");
    expect(summary.count).toBe(100);
    expect(summary.min).toBe(1);
    expect(summary.max).toBe(100);
    expect(summary.p50).toBeGreaterThan(40);
    expect(summary.p50).toBeLessThan(60);
    expect(summary.p99).toBeGreaterThan(90);
  });
});

describe("identifiers", () => {
  test("access tokens are prefixed, unique and hashed deterministically", () => {
    const first = generateAccessToken();
    const second = generateAccessToken();
    expect(first.plaintext.startsWith("ggh_")).toBe(true);
    expect(first.plaintext).not.toBe(second.plaintext);
    expect(first.hash).toBe(sha256Hex(first.plaintext));
    expect(first.hash).toHaveLength(64);
  });

  test("hueFor is stable and bounded", () => {
    expect(hueFor("octocat")).toBe(hueFor("octocat"));
    expect(hueFor("octocat")).toBeGreaterThanOrEqual(0);
    expect(hueFor("octocat")).toBeLessThan(360);
  });

  test("slugify produces url-safe text", () => {
    expect(slugify("Hello, World!")).toBe("hello-world");
    expect(slugify("---")).toBe("");
  });
});

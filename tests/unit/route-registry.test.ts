import { describe, expect, test } from "bun:test";
import { Router } from "../../src/api/router.ts";
import { buildRouter } from "../../src/api/index.ts";

const ok = (): Response => new Response("ok");

describe("route registry", () => {
  test("rejects a duplicate method+path registration", () => {
    const router = new Router();
    router.get("/api/thing", ok);
    expect(() => router.get("/api/thing", ok)).toThrow(/Duplicate route registration/);
  });

  test("allows the same path under different methods", () => {
    const router = new Router();
    router.get("/api/thing", ok);
    expect(() => router.post("/api/thing", ok)).not.toThrow();
  });

  test("the composed router has no duplicate registrations", () => {
    const router = buildRouter();
    const registrations = router.registrations();
    expect(new Set(registrations).size).toBe(registrations.length);
    expect(router.size).toBe(registrations.length);
  });

  test("registers the content and collaboration endpoints the UI depends on", () => {
    const registered = new Set(buildRouter().registrations());
    for (const route of [
      "GET /api/repos/:owner/:name/raw",
      "GET /api/repos/:owner/:name/blame",
      "GET /api/repos/:owner/:name/diff",
      "GET /api/repos/:owner/:name/blob",
      "GET /api/repos/:owner/:name/tree",
      "GET /api/repos/:owner/:name/commits/:sha",
      "GET /api/repos/:owner/:name/commits/:sha/diff",
      "GET /api/repos/:owner/:name/pulls/:number/files",
      "POST /api/repos/:owner/:name/pulls/:number/merge",
      "GET /api/repos/:owner/:name/ci/runs",
      "GET /api/repos/:owner/:name/ci/runs/:id",
      "GET /api/repos/:owner/:name/ci/runs/:id/log",
    ]) {
      expect(registered.has(route)).toBe(true);
    }
  });

  test("ci routes remain reachable even when the repo is named 'ci'", () => {
    const router = buildRouter();
    expect(router.match("GET", "/api/repos/acme/widget/ci/runs")).not.toBeNull();
    const match = router.match("GET", "/api/repos/acme/widget/ci/runs");
    expect(match?.params?.owner).toBe("acme");
    expect(match?.params?.name).toBe("widget");
  });

  test("no API route claims the static asset prefix", () => {
    const registrations = buildRouter().registrations();
    expect(registrations.some((entry) => entry.includes("/_assets"))).toBe(false);
  });

  test("a duplicate would otherwise have been served by registration order", () => {
    const router = new Router();
    router.get("/api/dup", () => new Response("first"));
    expect(() => router.get("/api/dup", () => new Response("second"))).toThrow();
  });
});

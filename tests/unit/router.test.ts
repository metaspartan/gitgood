import { describe, expect, test } from "bun:test";
import { Router } from "../../src/api/router.ts";
import { ANONYMOUS } from "../../src/auth/service.ts";

const ctx = (params: Record<string, string> = {}) => ({
  request: new Request("http://localhost/"),
  url: new URL("http://localhost/"),
  params,
  auth: ANONYMOUS,
  ip: "127.0.0.1",
});

describe("router", () => {
  test("matches static routes without allocating params", () => {
    const router = new Router();
    router.get("/api/health", () => new Response("ok"));
    const match = router.match("GET", "/api/health");
    expect(match).not.toBeNull();
    expect(match?.params).toEqual({});
  });

  test("extracts and decodes path parameters", () => {
    const router = new Router();
    router.get("/api/repos/:owner/:name", () => new Response("ok"));
    const match = router.match("GET", "/api/repos/octocat/hello%20world");
    expect(match?.params.owner).toBe("octocat");
    expect(match?.params.name).toBe("hello world");
  });

  test("prefers static routes over parameterised ones", () => {
    const router = new Router();
    router.get("/api/repos/:owner/:name", () => new Response("param"));
    router.get("/api/repos/list", () => new Response("static"));
    expect(router.match("GET", "/api/repos/list")?.params).toEqual({});
  });

  test("distinguishes methods", () => {
    const router = new Router();
    router.get("/api/thing", () => new Response("ok"));
    expect(router.match("POST", "/api/thing")).toBeNull();
    expect(router.hasPath("/api/thing")).toBe(true);
  });

  test("does not match different segment counts", () => {
    const router = new Router();
    router.get("/api/repos/:owner/:name", () => new Response("ok"));
    expect(router.match("GET", "/api/repos/a/b/c")).toBeNull();
    expect(router.match("GET", "/api/repos/a")).toBeNull();
  });

  test("dispatches the matched handler", async () => {
    const router = new Router();
    router.post("/api/echo/:word", (c) => new Response(c.params.word ?? ""));
    const match = router.match("POST", "/api/echo/hello");
    const response = await match?.handler(ctx({ word: "hello" }));
    expect(await response?.text()).toBe("hello");
  });
});

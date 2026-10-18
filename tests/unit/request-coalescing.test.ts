import { afterEach, expect, test } from "bun:test";
import { request } from "../../src/web/api.ts";

const realFetch = globalThis.fetch;
let pending: Array<(value: Response) => void> = [];
let calls: string[] = [];
let methods: string[] = [];

function stubFetch(): void {
  calls = [];
  methods = [];
  pending = [];
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    calls.push(path);
    methods.push((init?.method ?? "GET").toUpperCase());
    return new Promise<Response>((resolve) => {
      pending.push((value) => resolve(value));
    });
  }) as typeof fetch;
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

afterEach(() => {
  globalThis.fetch = realFetch;
});

test("two concurrent GETs for the same path make one request", async () => {
  stubFetch();
  const first = request<{ value: number }>("/api/repos/a/b");
  const second = request<{ value: number }>("/api/repos/a/b");
  expect(calls).toEqual(["/api/repos/a/b"]);

  pending[0]!(json({ value: 7 }));
  expect((await first).value).toBe(7);
  expect((await second).value).toBe(7);
  expect(calls).toHaveLength(1);
});

test("different paths are not merged", async () => {
  stubFetch();
  const a = request<{ ok: boolean }>("/api/repos/a/b");
  const b = request<{ ok: boolean }>("/api/repos/a/b/branches");
  expect(calls).toEqual(["/api/repos/a/b", "/api/repos/a/b/branches"]);
  pending[0]!(json({}));
  pending[1]!(json({}));
  await Promise.all([a, b]);
});

test("a request after the response settled reaches the server again", async () => {
  stubFetch();
  const first = request<{ value: number }>("/api/repos/a/b");
  pending[0]!(json({ value: 1 }));
  await first;

  const second = request<{ value: number }>("/api/repos/a/b");
  expect(calls).toEqual(["/api/repos/a/b", "/api/repos/a/b"]);
  pending[1]!(json({ value: 2 }));
  expect((await second).value).toBe(2);
});

test("a failed request is not left in the map to poison the next one", async () => {
  stubFetch();
  const failing = request<unknown>("/api/repos/a/b");
  pending[0]!(new Response(JSON.stringify({ error: { code: "not_found", message: "gone" } }), { status: 404 }));
  await expect(failing).rejects.toThrow();

  const retry = request<{ value: number }>("/api/repos/a/b");
  expect(calls).toHaveLength(2);
  pending[1]!(json({ value: 3 }));
  expect((await retry).value).toBe(3);
});

test("writes are never shared, even for the same path", async () => {
  stubFetch();
  const first = request("/api/repos/a/b", { method: "POST", body: "{}" });
  const second = request("/api/repos/a/b", { method: "POST", body: "{}" });
  expect(calls).toHaveLength(2);
  expect(methods).toEqual(["POST", "POST"]);
  pending[0]!(json({ ok: true }));
  pending[1]!(json({ ok: true }));
  await Promise.all([first, second]);
});

test("a 204 shares the same way an empty body does", async () => {
  stubFetch();
  const first = request<void>("/api/thing");
  const second = request<void>("/api/thing");
  expect(calls).toHaveLength(1);
  pending[0]!(new Response(null, { status: 204 }));
  expect(await first).toBeUndefined();
  expect(await second).toBeUndefined();
});

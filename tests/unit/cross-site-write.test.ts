import { expect, test } from "bun:test";
import { isCrossSiteWrite } from "../../src/lib/http.ts";

const url = new URL("https://git.example.test/api/repos");
const req = (method: string, headers: Record<string, string>) => new Request(url, { method, headers });

test("cookie-authenticated writes from another origin are refused", () => {
  expect(isCrossSiteWrite(req("POST", { cookie: "s=1", origin: "https://evil.test" }), url)).toBe(true);
  expect(isCrossSiteWrite(req("DELETE", { cookie: "s=1", "sec-fetch-site": "cross-site" }), url)).toBe(true);
  expect(isCrossSiteWrite(req("POST", { cookie: "s=1", origin: "null" }), url)).toBe(true);
});

test("same-origin, token and read requests pass", () => {
  expect(isCrossSiteWrite(req("POST", { cookie: "s=1", origin: "https://git.example.test" }), url)).toBe(false);
  expect(isCrossSiteWrite(req("POST", { cookie: "s=1", "sec-fetch-site": "same-origin" }), url)).toBe(false);
  expect(isCrossSiteWrite(req("POST", { cookie: "s=1" }), url)).toBe(false);
  expect(isCrossSiteWrite(req("POST", { authorization: "Bearer x", origin: "https://evil.test" }), url)).toBe(false);
  expect(isCrossSiteWrite(req("POST", { origin: "https://evil.test" }), url)).toBe(false);
  expect(isCrossSiteWrite(req("GET", { cookie: "s=1", origin: "https://evil.test" }), url)).toBe(false);
});

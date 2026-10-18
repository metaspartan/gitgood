import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createServer } from "../../src/server.ts";
import { changes } from "../../src/db/index.ts";
import { readBootSession } from "../../src/web/App.tsx";

const server = createServer(0);
const BASE = `http://127.0.0.1:${server.port}`;
const stamp = Date.now().toString(36);
const name = `bs${stamp}`;
const PASSWORD = "boot-session-password";
let cookie = "";

const shell = async (headers: Record<string, string> = {}) => {
  const response = await fetch(`${BASE}/some/deep/link`, { headers });
  return { response, html: await response.text() };
};
const meta = (html: string) => /<meta name="gg-session" content="([^"]*)" \/>/.exec(html)?.[1] ?? null;
const decode = (value: string) => value.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

beforeAll(async () => {
  const signup = await fetch(`${BASE}/api/auth/signup`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: name, email: `${name}@example.test`, password: PASSWORD }),
  });
  cookie = signup.headers.get("set-cookie")!.split(";")[0]!;
  changes("UPDATE users SET display_name = ? WHERE username = ?", `"><script>alert(1)</script>`, name);
});
afterAll(() => server.stop(true));

describe("session in the HTML shell", () => {
  test("anonymous visitors get a shared, cacheable shell that says nobody is signed in", async () => {
    const { response, html } = await shell();
    expect(meta(html)).toBe("null");
    expect(response.headers.get("cache-control")).toBe("no-cache");
  });

  test("a signed-in visitor's shell carries their user, escaped, and is private", async () => {
    const { response, html } = await shell({ cookie });
    expect(response.headers.get("cache-control")).toBe("no-cache, private");
    expect(html).not.toContain("<script>alert(1)</script>");
    const raw = meta(html);
    expect(raw).not.toBeNull();
    const parsed = JSON.parse(decode(raw!)) as { user: { username: string; display_name: string } };
    expect(parsed.user.username).toBe(name);
    expect(parsed.user.display_name).toBe(`"><script>alert(1)</script>`);
    const anon = await shell();
    expect(response.headers.get("etag")).not.toBe(anon.response.headers.get("etag"));
  });

  test("an invalid or blocked session is treated as anonymous", async () => {
    expect(meta((await shell({ cookie: "gg_session=forged" })).html)).toBe("null");
    changes("UPDATE users SET blocked_at = 1 WHERE username = ?", name);
    expect(meta((await shell({ cookie })).html)).toBe("null");
    changes("UPDATE users SET blocked_at = NULL WHERE username = ?", name);
  });

  test("the client reads the boot session and falls back when it is absent or malformed", () => {
    const doc = (content: string | null) => ({
      querySelector: () => (content === null ? null : ({ content } as HTMLMetaElement)),
    }) as unknown as Pick<Document, "querySelector">;
    expect(readBootSession(doc(null))).toBeUndefined();
    expect(readBootSession(doc("null"))).toEqual({ user: null });
    expect(readBootSession(doc('{"user":{"username":"a"}}'))?.user?.username).toBe("a");
    expect(readBootSession(doc("{broken"))).toBeUndefined();
  });
});

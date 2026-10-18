import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createServer } from "../../src/server.ts";
import { toMatchQuery } from "../../src/api/routes/search.ts";

const server = createServer(0);
const BASE = `http://127.0.0.1:${server.port}`;
const run = Date.now().toString(36);

interface Receiver {
  url: string;
  hits: number;
  statuses: number[];
  signatureHeaders: string[];
  bodies: string[];
  stop: () => void;
}

function startReceiver(path: string, statusFor: (hit: number) => number): Receiver {
  const state: Receiver = {
    url: "",
    hits: 0,
    statuses: [],
    signatureHeaders: [],
    bodies: [],
    stop: () => {},
  };
  const receiver = Bun.serve({
    port: 0,
    fetch: async (request) => {
      if (new URL(request.url).pathname !== path) return new Response("not found", { status: 404 });
      state.hits += 1;
      state.bodies.push(await request.text());
      state.signatureHeaders.push(request.headers.get("x-hub-signature-256") ?? "");
      const status = statusFor(state.hits);
      state.statuses.push(status);
      return new Response(status < 400 ? "ok" : "boom", { status });
    },
  });
  state.url = `http://127.0.0.1:${receiver.port}${path}`;
  state.stop = () => receiver.stop(true);
  return state;
}

class Client {
  cookie = "";

  async request<T>(
    path: string,
    options: { method?: string; body?: unknown } = {},
  ): Promise<{ status: number; data: T }> {
    const headers: Record<string, string> = {};
    if (this.cookie) headers.cookie = this.cookie;
    if (options.body !== undefined) headers["content-type"] = "application/json";
    const response = await fetch(`${BASE}${path}`, {
      method: options.method ?? "GET",
      headers,
      ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
    });
    const setCookie = response.headers.get("set-cookie");
    if (setCookie) this.cookie = setCookie.split(";")[0] ?? "";
    const text = await response.text();
    let data: unknown = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = text;
      }
    }
    return { status: response.status, data: data as T };
  }
}

const user = new Client();
const username = `feat${run}`;

beforeAll(() => {
  process.env.GITGOOD_WEBHOOK_ALLOW_PRIVATE = "1";
});

async function poll<T>(fn: () => Promise<T>, predicate: (value: T) => boolean, timeoutMs = 15_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (predicate(value)) return value;
    if (Date.now() > deadline) throw new Error("condition never satisfied");
    await Bun.sleep(120);
  }
}

interface DeliveryJson {
  id: number;
  event: string;
  status_code: number | null;
  error: string | null;
  attempts: number;
  duration_ms: number;
}

interface SearchJson {
  query: string;
  repos: Array<{ full_name: string }>;
  issues: Array<{ title: string; repository?: string }>;
  pulls: Array<{ title: string }>;
}

beforeAll(async () => {
  const signup = await user.request("/api/auth/signup", {
    method: "POST",
    body: { username, email: `${username}@example.com`, password: "supersecret123" },
  });
  expect(signup.status).toBe(201);
  const repo = await user.request("/api/repos", {
    method: "POST",
    body: { name: "alpha", description: "the alpha service" },
  });
  expect(repo.status).toBe(201);
  await user.request("/api/repos", {
    method: "POST",
    body: { name: "beta", description: "the beta service" },
  });
});

afterAll(async () => {
  await server.stop(true);
});

describe("search match expressions", () => {
  test("quotes every token and makes it a prefix term", () => {
    expect(toMatchQuery("Bug report")).toBe('"bug"* "report"*');
  });

  test("strips punctuation that would be FTS syntax", () => {
    expect(toMatchQuery('title:"x" OR (y)')).toBe('"title"* "x"* "or"* "y"*');
  });

  test("returns null when there is nothing indexable to search for", () => {
    expect(toMatchQuery("!!!")).toBeNull();
    expect(toMatchQuery("   ")).toBeNull();
    expect(toMatchQuery("")).toBeNull();
  });

  test("caps the number of terms", () => {
    const many = Array.from({ length: 30 }, (_, i) => `w${i}`).join(" ");
    expect(toMatchQuery(many)?.split(" ")).toHaveLength(8);
  });
});

describe("full-text search", () => {
  test("finds issues by a body word, not just the title", async () => {
    const created = await user.request<{ number: number }>(`/api/repos/${username}/alpha/issues`, {
      method: "POST",
      body: { title: "Login is broken", body: "Reproduces when the session cookie expires silently" },
    });
    expect(created.status).toBe(201);

    const search = await user.request<SearchJson>("/api/search?q=cookie");
    expect(search.data.issues.some((issue) => issue.title === "Login is broken")).toBe(true);
  });

  test("matches prefixes so partial words find results", async () => {
    const search = await user.request<SearchJson>("/api/search?q=repro");
    expect(search.data.issues.length).toBeGreaterThan(0);
  });

  test("reindexes on update so stale text stops matching", async () => {
    const created = await user.request<{ number: number }>(`/api/repos/${username}/alpha/issues`, {
      method: "POST",
      body: { title: "Deprecated feature", body: "zebrafinch" },
    });
    expect((await user.request<SearchJson>("/api/search?q=zebrafinch")).data.issues.length).toBe(1);

    await user.request(`/api/repos/${username}/alpha/issues/${created.data.number}`, {
      method: "PATCH",
      body: { body: "replaced text" },
    });
    expect((await user.request<SearchJson>("/api/search?q=zebrafinch")).data.issues.length).toBe(0);
    expect((await user.request<SearchJson>("/api/search?q=replaced")).data.issues.length).toBe(1);
  });

  test("a query of only punctuation returns empty results rather than an error", async () => {
    const response = await user.request<SearchJson>("/api/search?q=%21%21%21");
    expect(response.status).toBe(200);
    expect(response.data.issues).toHaveLength(0);
    expect(response.data.pulls).toHaveLength(0);
  });

  test("repository search keeps substring semantics", async () => {
    const search = await user.request<SearchJson>("/api/search?q=alph");
    expect(search.data.repos.some((repo) => repo.full_name === `${username}/alpha`)).toBe(true);
  });
});

describe("batched repository counts", () => {
  test("list reports open item counts without per-repo queries", async () => {
    const list = await user.request<{
      items: Array<{ full_name: string; openIssues: number; openPulls: number }>;
    }>("/api/repos");
    const alpha = list.data.items.find((repo) => repo.full_name === `${username}/alpha`);
    expect(alpha).toBeDefined();
    expect(alpha?.openIssues).toBe(2);
    expect(alpha?.openPulls).toBe(0);
  });

  test("closing an issue is reflected in the list count", async () => {
    await user.request(`/api/repos/${username}/alpha/issues/1`, {
      method: "PATCH",
      body: { state: "closed" },
    });
    const list = await user.request<{
      items: Array<{ full_name: string; openIssues: number }>;
    }>("/api/repos");
    const alpha = list.data.items.find((repo) => repo.full_name === `${username}/alpha`);
    expect(alpha?.openIssues).toBe(1);
  });
});

describe("webhook delivery", () => {
  const retrying = startReceiver("/retry", (hit) => (hit <= 2 ? 500 : 200));
  const rejecting = startReceiver("/reject", () => 404);

  afterAll(() => {
    retrying.stop();
    rejecting.stop();
  });

  test("retries transient failures and records the eventual success", async () => {
    const created = await user.request<{ id: number }>(`/api/repos/${username}/alpha/webhooks`, {
      method: "POST",
      body: { url: retrying.url, secret: "s3cret", events: ["issues"] },
    });
    expect(created.status).toBe(201);

    await user.request(`/api/repos/${username}/alpha/issues`, {
      method: "POST",
      body: { title: "Webhook trigger" },
    });

    const deliveries = await poll(
      () => user.request<{ items: DeliveryJson[] }>(`/api/repos/${username}/alpha/webhooks/${created.data.id}/deliveries`),
      (value) => value.data.items.length > 0,
    );

    const first = deliveries.data.items[0];
    expect(first?.event).toBe("issues");
    expect(first?.status_code).toBe(200);
    expect(first?.attempts).toBe(3);
    expect(retrying.hits).toBeGreaterThanOrEqual(3);
    expect(first?.error).toBeNull();

    expect(retrying.signatureHeaders[0]).toMatch(/^sha256=[0-9a-f]{64}$/);
    expect(retrying.bodies[0]).toContain("Webhook trigger");
  }, 30_000);

  test("does not retry a 4xx rejection", async () => {
    const created = await user.request<{ id: number }>(`/api/repos/${username}/beta/webhooks`, {
      method: "POST",
      body: { url: rejecting.url, events: ["issues"] },
    });
    expect(created.status).toBe(201);

    await user.request(`/api/repos/${username}/beta/issues`, {
      method: "POST",
      body: { title: "Rejected delivery" },
    });

    const deliveries = await poll(
      () => user.request<{ items: DeliveryJson[] }>(`/api/repos/${username}/beta/webhooks/${created.data.id}/deliveries`),
      (value) => value.data.items.length > 0,
    );
    const first = deliveries.data.items[0];
    expect(first?.status_code).toBe(404);
    expect(first?.attempts).toBe(1);
    expect(rejecting.hits).toBe(1);
  }, 30_000);

  test("hook listing reports per-hook delivery health", async () => {
    const list = await user.request<{
      items: Array<{ id: number; last_status: number | null; delivery_count: number }>;
      available_events: string[];
    }>(`/api/repos/${username}/alpha/webhooks`);
    const hook = list.data.items[0];
    expect(hook?.delivery_count).toBeGreaterThan(0);
    expect(hook?.last_status).toBe(200);
    expect(list.data.available_events).toContain("push");
  });

  test("a hook not subscribed to the event is never called", async () => {
    const idle = startReceiver("/idle", () => 200);
    const created = await user.request<{ id: number }>(`/api/repos/${username}/alpha/webhooks`, {
      method: "POST",
      body: { url: idle.url, events: ["push"] },
    });

    await user.request(`/api/repos/${username}/alpha/issues`, {
      method: "POST",
      body: { title: "Should not reach a push-only hook" },
    });
    await Bun.sleep(600);

    const deliveries = await user.request<{ items: DeliveryJson[] }>(
      `/api/repos/${username}/alpha/webhooks/${created.data.id}/deliveries`,
    );
    expect(deliveries.data.items).toHaveLength(0);
    expect(idle.hits).toBe(0);
    idle.stop();
  }, 20_000);

  test("deliveries for an unknown hook are a 404", async () => {
    const response = await user.request(`/api/repos/${username}/alpha/webhooks/999999/deliveries`);
    expect(response.status).toBe(404);
  });
});

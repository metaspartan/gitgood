import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "../../src/server.ts";

const scratch = mkdtempSync(join(tmpdir(), "gg-egress-test-"));
const server = createServer(0);
const BASE = `http://127.0.0.1:${server.port}`;
const run = Date.now().toString(36);

afterAll(async () => {
  await server.stop(true);
  try {
    rmSync(scratch, { recursive: true, force: true });
  } catch {
  }
});

class Client {
  cookie = "";
  async request<T>(path: string, options: { method?: string; body?: unknown } = {}): Promise<{ status: number; data: T }> {
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
const username = `egr${run}`;
const repo = "hooks";

beforeAll(() => {
  delete process.env.GITGOOD_WEBHOOK_ALLOW_PRIVATE;
});

beforeAll(async () => {
  await user.request("/api/auth/signup", {
    method: "POST",
    body: { username, email: `${username}@example.com`, password: "supersecret123" },
  });
  await user.request("/api/repos", { method: "POST", body: { name: repo } });
});

describe("webhook egress guard", () => {
  test("internal destinations are refused at creation with a reason", async () => {
    for (const url of [
      "http://169.254.169.254/latest/meta-data/",
      "http://127.0.0.1:9999/hook",
      "http://10.9.9.9/hook",
      "http://192.168.0.10/hook",
      "http://localhost:8080/hook",
      "http://[::1]:8080/hook",
    ]) {
      const result = await user.request<{ error?: { message?: string } }>(`/api/repos/${username}/${repo}/webhooks`, {
        method: "POST",
        body: { url },
      });
      expect(result.status).toBe(400);
      expect(JSON.stringify(result.data)).toContain("refused");
    }
  });

  test("a public-range destination is accepted", async () => {
    const result = await user.request(`/api/repos/${username}/${repo}/webhooks`, {
      method: "POST",
      body: { url: "http://192.0.2.1/hook", events: ["push"] },
    });
    expect(result.status).toBe(201);
  });

  test("a webhook that was valid can still be listed and deleted", async () => {
    const list = await user.request<{ items: Array<{ id: number }> }>(`/api/repos/${username}/${repo}/webhooks`);
    expect(list.status).toBe(200);
    expect(list.data.items.length).toBe(1);
    const removed = await user.request(`/api/repos/${username}/${repo}/webhooks/${list.data.items[0]!.id}`, {
      method: "DELETE",
    });
    expect(removed.status).toBe(200);
  });
});

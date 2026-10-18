import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "../../src/server.ts";

const scratch = mkdtempSync(join(tmpdir(), "gg-contents-test-"));
const server = createServer(0);
const BASE = `http://127.0.0.1:${server.port}`;
const run = Date.now().toString(36);

afterAll(async () => {
  await server.stop(true);
  rmSync(scratch, { recursive: true, force: true });
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
  async raw(path: string): Promise<{ status: number; type: string | null; bytes: Uint8Array }> {
    const response = await fetch(`${BASE}${path}`);
    return {
      status: response.status,
      type: response.headers.get("content-type"),
      bytes: new Uint8Array(await response.arrayBuffer()),
    };
  }
}

const user = new Client();
const stranger = new Client();
const username = `cnt${run}`;
const repo = "editme";
beforeAll(async () => {
  await user.request("/api/auth/signup", {
    method: "POST",
    body: { username, email: `${username}@example.com`, password: "supersecret123" },
  });
  await user.request("/api/repos", { method: "POST", body: { name: repo } });
  await stranger.request("/api/auth/signup", {
    method: "POST",
    body: { username: `cntx${run}`, email: `cntx${run}@example.com`, password: "supersecret123" },
  });
});

describe("web file editing", () => {
  test("creates a text file as a commit", async () => {
    const result = await user.request<{ commit: string; path: string }>(`/api/repos/${username}/${repo}/contents`, {
      method: "PUT",
      body: { path: "docs/hello.md", branch: "main", content: "# hello\n", encoding: "utf8" },
    });
    expect(result.status).toBe(201);
    expect((result.data as { commit: string }).commit).toMatch(/^[0-9a-f]{40,64}$/);
  });

  test("the raw endpoint serves the created file with its bytes", async () => {
    const raw = await user.raw(`/api/repos/${username}/${repo}/raw?ref=main&path=${encodeURIComponent("docs/hello.md")}`);
    expect(raw.status).toBe(200);
    expect(new TextDecoder().decode(raw.bytes)).toBe("# hello\n");
  });

  test("updating the same path produces a second commit with new content", async () => {
    const first = await user.request<{ commit: string }>(`/api/repos/${username}/${repo}/contents`, {
      method: "PUT",
      body: { path: "docs/hello.md", branch: "main", content: "# hello\n", encoding: "utf8" },
    });
    const second = await user.request<{ commit: string }>(`/api/repos/${username}/${repo}/contents`, {
      method: "PUT",
      body: { path: "docs/hello.md", branch: "main", content: "# hello, edited\n", encoding: "utf8" },
    });
    expect(second.status).toBe(201);
    expect((second.data as { commit: string }).commit).not.toBe(first.data.commit);
    const raw = await user.raw(`/api/repos/${username}/${repo}/raw?ref=main&path=${encodeURIComponent("docs/hello.md")}`);
    expect(new TextDecoder().decode(raw.bytes)).toBe("# hello, edited\n");
  });

  test("commits a binary image and the blob endpoint reports kind=image", async () => {
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
      "base64",
    );
    const result = await user.request(`/api/repos/${username}/${repo}/contents`, {
      method: "PUT",
      body: { path: "pixel.png", branch: "main", content: png.toString("base64"), encoding: "base64" },
    });
    expect(result.status).toBe(201);

    const raw = await user.raw(`/api/repos/${username}/${repo}/raw?ref=main&path=pixel.png`);
    expect(raw.status).toBe(200);
    expect(raw.type).toBe("image/png");
    expect(Buffer.from(raw.bytes).equals(png)).toBe(true);

    const blob = await user.request<{ kind: string; mime: string; content: string | null }>(
      `/api/repos/${username}/${repo}/blob?path=pixel.png&ref=main`,
    );
    expect(blob.data.kind).toBe("image");
    expect(blob.data.mime).toBe("image/png");
    expect(blob.data.content).toBeNull();
  });

  test("deletes a file and then reports 404 for it", async () => {
    const result = await user.request(`/api/repos/${username}/${repo}/contents`, {
      method: "DELETE",
      body: { path: "docs/hello.md", branch: "main" },
    });
    expect(result.status).toBe(200);
    const raw = await user.raw(`/api/repos/${username}/${repo}/raw?ref=main&path=${encodeURIComponent("docs/hello.md")}`);
    expect(raw.status).toBe(404);
  });

  test("deleting a missing path is a 404, not an empty commit", async () => {
    const result = await user.request(`/api/repos/${username}/${repo}/contents`, {
      method: "DELETE",
      body: { path: "docs/hello.md", branch: "main" },
    });
    expect(result.status).toBe(404);
  });

  test("rejects path traversal and .git segments", async () => {
    for (const path of ["../escape.md", "a/../../b.md", ".git/config", "sub/.git/x", "/absolute.md", "a//b.md"]) {
      const result = await user.request(`/api/repos/${username}/${repo}/contents`, {
        method: "PUT",
        body: { path, branch: "main", content: "x", encoding: "utf8" },
      });
      expect(result.status).toBe(400);
    }
  });

  test("rejects an unknown branch", async () => {
    const result = await user.request(`/api/repos/${username}/${repo}/contents`, {
      method: "PUT",
      body: { path: "x.txt", branch: "nope", content: "x", encoding: "utf8" },
    });
    expect(result.status).toBe(404);
  });

  test("a non-writer cannot edit; anonymous cannot either", async () => {
    const strangerResult = await stranger.request(`/api/repos/${username}/${repo}/contents`, {
      method: "PUT",
      body: { path: "hijack.md", branch: "main", content: "x", encoding: "utf8" },
    });
    expect([401, 403, 404]).toContain(strangerResult.status);
    const anon = await fetch(`${BASE}/api/repos/${username}/${repo}/contents`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: "hijack.md", branch: "main", content: "x", encoding: "utf8" }),
    });
    expect([401, 403]).toContain(anon.status);
  });
});

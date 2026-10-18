import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "../../src/server.ts";
import { git } from "../../src/git/run.ts";
import { hashedRepositoryPath } from "../../src/git/repo.ts";

const scratch = mkdtempSync(join(tmpdir(), "gg-releases-test-"));
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
  async uploadAsset(releaseId: number, name: string, bytes: Uint8Array<ArrayBuffer>, contentType = "application/zip"): Promise<{ status: number; data: { asset?: { id: number; name: string; size: number; downloads: number } } }> {
    const response = await fetch(`${BASE}/api/repos/${username}/${repo}/releases/${releaseId}/assets?name=${encodeURIComponent(name)}`, {
      method: "POST",
      headers: { cookie: this.cookie, "content-type": contentType },
      body: bytes,
    });
    return { status: response.status, data: (await response.json()) as never };
  }

  async tagExists(name: string): Promise<boolean> {
    const result = await git(["tag", "-l", name], { cwd: hashedRepositoryPath(username, repo) });
    return result.stdout.trim() === name;
  }

  async downloadAsset(releaseId: number, assetId: number): Promise<{ status: number; bytes: Uint8Array; type: string | null; disposition: string | null }> {
    const response = await fetch(`${BASE}/api/repos/${username}/${repo}/releases/${releaseId}/assets/${assetId}`, {
      headers: { cookie: this.cookie },
    });
    return {
      status: response.status,
      bytes: new Uint8Array(await response.arrayBuffer()),
      type: response.headers.get("content-type"),
      disposition: response.headers.get("content-disposition"),
    };
  }
}

const owner = new Client();
const stranger = new Client();
const username = `rel${run}`;
const repo = "shipped";

beforeAll(async () => {
  await owner.request("/api/auth/signup", {
    method: "POST",
    body: { username, email: `${username}@example.com`, password: "supersecret123" },
  });
  await owner.request("/api/repos", { method: "POST", body: { name: repo } });
  await stranger.request("/api/auth/signup", {
    method: "POST",
    body: { username: `relx${run}`, email: `relx${run}@example.com`, password: "supersecret123" },
  });
  await owner.request(`/api/repos/${username}/${repo}/contents`, {
    method: "PUT",
    body: { path: "README.md", branch: "main", content: "# shipped\n", encoding: "utf8" },
  });
});

describe("releases", () => {
  test("creates a release and auto-creates its tag at the default branch", async () => {
    const result = await owner.request<{ id: number; tag_name: string; assets: unknown[] }>(
      `/api/repos/${username}/${repo}/releases`,
      {
        method: "POST",
        body: { tag_name: `v1.0.${run.length}`, name: "First", body: "## Notes\nIt works.", prerelease: false },
      },
    );
    expect(result.status).toBe(201);
    expect(result.data.assets).toEqual([]);
    expect(await owner.tagExists(`v1.0.${run.length}`)).toBe(true);
  });

  test("a second release for the same tag conflicts", async () => {
    const result = await owner.request(`/api/repos/${username}/${repo}/releases`, {
      method: "POST",
      body: { tag_name: `v1.0.${run.length}` },
    });
    expect(result.status).toBe(409);
  });

  test("the list carries author, notes and the release just made", async () => {
    const list = await owner.request<{ items: Array<{ tag_name: string; author: string; body: string }> }>(
      `/api/repos/${username}/${repo}/releases`,
    );
    expect(list.status).toBe(200);
    const found = list.data.items.find((r) => r.tag_name === `v1.0.${run.length}`);
    expect(found?.author).toBe(username);
    expect(found?.body).toContain("It works.");
  });

  test("uploads an asset and serves the exact bytes back", async () => {
    const list = await owner.request<{ items: Array<{ id: number; assets: Array<{ id: number }> }> }>(
      `/api/repos/${username}/${repo}/releases`,
    );
    const releaseId = list.data.items[0]!.id;
    const bytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3, 4, 5]);
    const upload = await owner.uploadAsset(releaseId, "build.zip", bytes);
    expect(upload.status).toBe(201);
    expect(upload.data.asset?.size).toBe(bytes.byteLength);

    const download = await owner.downloadAsset(releaseId, upload.data.asset!.id);
    expect(download.status).toBe(200);
    expect(Array.from(download.bytes)).toEqual(Array.from(bytes));
    expect(download.disposition).toContain("build.zip");
  });

  test("downloads are counted", async () => {
    const list = await owner.request<{ items: Array<{ id: number; assets: Array<{ id: number; downloads: number }> }> }>(
      `/api/repos/${username}/${repo}/releases`,
    );
    const before = list.data.items[0]!.assets[0]!.downloads;
    await owner.downloadAsset(list.data.items[0]!.id, list.data.items[0]!.assets[0]!.id);
    const after = await owner.request<{ items: Array<{ assets: Array<{ downloads: number }> }> }>(
      `/api/repos/${username}/${repo}/releases`,
    );
    expect(after.data.items[0]!.assets[0]!.downloads).toBe(before + 1);
  });

  test("edits notes; the tag is not touched", async () => {
    const list = await owner.request<{ items: Array<{ id: number }> }>(`/api/repos/${username}/${repo}/releases`);
    const id = list.data.items[0]!.id;
    const patched = await owner.request<{ body: string }>(`/api/repos/${username}/${repo}/releases/${id}`, {
      method: "PATCH",
      body: { body: "## Notes\nEdited." },
    });
    expect(patched.status).toBe(200);
    const list2 = await owner.request<{ items: Array<{ body: string }> }>(`/api/repos/${username}/${repo}/releases`);
    expect(list2.data.items[0]!.body).toContain("Edited.");
  });

  test("drafts are hidden from non-writers and shown to writers", async () => {
    const draft = await owner.request<{ id: number }>(`/api/repos/${username}/${repo}/releases`, {
      method: "POST",
      body: { tag_name: `v0.draft.${run.length}`, draft: true },
    });
    expect(draft.status).toBe(201);
    const own = await owner.request<{ items: Array<{ tag_name: string }> }>(`/api/repos/${username}/${repo}/releases`);
    expect(JSON.stringify(own.data)).toContain(`v0.draft.${run.length}`);
    const other = await stranger.request<{ items: Array<{ tag_name: string }> }>(
      `/api/repos/${username}/${repo}/releases`,
    );
    expect(JSON.stringify(other.data)).not.toContain(`v0.draft.${run.length}`);
  });

  test("deleting the release keeps the tag", async () => {
    const made = await owner.request<{ id: number }>(`/api/repos/${username}/${repo}/releases`, {
      method: "POST",
      body: { tag_name: `v9.tmp.${run.length}` },
    });
    expect(made.status).toBe(201);
    const removed = await owner.request(`/api/repos/${username}/${repo}/releases/${made.data.id}`, {
      method: "DELETE",
    });
    expect(removed.status).toBe(200);
    expect(await owner.tagExists(`v9.tmp.${run.length}`)).toBe(true);
    const list = await owner.request<{ items: Array<{ tag_name: string }> }>(`/api/repos/${username}/${repo}/releases`);
    expect(JSON.stringify(list.data)).not.toContain(`v9.tmp.${run.length}`);
  });

  test("rejects injection-shaped tag names", async () => {
    for (const tag of ["../evil", "-dash", "has space", "a..b"]) {
      const result = await owner.request(`/api/repos/${username}/${repo}/releases`, {
        method: "POST",
        body: { tag_name: tag },
      });
      expect(result.status).toBe(400);
    }
  });

  test("a release for an unknown target is a 404, not a dangling tag", async () => {
    const result = await owner.request(`/api/repos/${username}/${repo}/releases`, {
      method: "POST",
      body: { tag_name: `vx.${run.length}`, target: "no-such-branch" },
    });
    expect(result.status).toBe(404);
  });

  test("draft asset downloads require write access until publication", async () => {
    const made = await owner.request<{ id: number }>(`/api/repos/${username}/${repo}/releases`, {
      method: "POST", body: { tag_name: "private-asset-test", draft: true },
    });
    expect(made.status).toBe(201);
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const uploaded = await owner.uploadAsset(made.data.id, "private.bin", bytes);
    expect(uploaded.status).toBe(201);
    const assetId = uploaded.data.asset!.id;
    const path = `/api/repos/${username}/${repo}/releases/${made.data.id}/assets/${assetId}`;
    expect((await stranger.downloadAsset(made.data.id, assetId)).status).toBe(404);
    const anonymous = await fetch(BASE + path);
    expect(anonymous.status).toBe(404);
    await anonymous.arrayBuffer();
    const own = await owner.downloadAsset(made.data.id, assetId);
    expect(own.status).toBe(200); expect(Array.from(own.bytes)).toEqual(Array.from(bytes));
    const published = await owner.request(`/api/repos/${username}/${repo}/releases/${made.data.id}`, { method: "PATCH", body: { draft: false } });
    expect(published.status).toBe(200);
    const publicDownload = await fetch(BASE + path);
    expect(publicDownload.status).toBe(200);
    expect(Array.from(new Uint8Array(await publicDownload.arrayBuffer()))).toEqual(Array.from(bytes));
  });

  test("non-writers cannot create; anonymous cannot either", async () => {
    const strangerResult = await stranger.request(`/api/repos/${username}/${repo}/releases`, {
      method: "POST",
      body: { tag_name: `hijack.${run.length}` },
    });
    expect([403, 404]).toContain(strangerResult.status);
    const anon = await fetch(`${BASE}/api/repos/${username}/${repo}/releases`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tag_name: `anon.${run.length}` }),
    });
    expect([401, 403]).toContain(anon.status);
  });
});

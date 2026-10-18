import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "../../src/server.ts";

const scratch = mkdtempSync(join(tmpdir(), "gg-media2-test-"));
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
}

const user = new Client();
const username = `med2${run.slice(-6)}`;
const repo = "previews";

beforeAll(async () => {
  await user.request("/api/auth/signup", {
    method: "POST",
    body: { username, email: `${username}@example.com`, password: "supersecret123" },
  });
  await user.request("/api/repos", { method: "POST", body: { name: repo } });
});

function wavFixture(): Uint8Array {
  const bytes = new Uint8Array(48);
  const view = new DataView(bytes.buffer);
  bytes.set(new TextEncoder().encode("RIFF"), 0);
  view.setUint32(4, 40, true);
  bytes.set(new TextEncoder().encode("WAVE"), 8);
  return bytes;
}

async function upload(name: string, bytes: Uint8Array): Promise<{ status: number }> {
  const result = await user.request(`/api/repos/${username}/${repo}/contents`, {
    method: "PUT",
    body: { path: name, branch: "main", content: Buffer.from(bytes).toString("base64"), encoding: "base64" },
  });
  return { status: result.status };
}

describe("media via the web editor", () => {
  test("a WAV uploaded as binary previews as audio with the sniffed mime", async () => {
    const put = await upload("tone.wav", wavFixture());
    expect(put.status).toBe(201);

    const blob = await user.request<{ kind: string; mime: string }>(
      `/api/repos/${username}/${repo}/blob?path=tone.wav&ref=main`,
    );
    expect(blob.data.kind).toBe("audio");
    expect(blob.data.mime).toBe("audio/wav");
  });

  test("a text file renamed .stl stays text - extension lies do not become geometry", async () => {
    const text = new TextEncoder().encode("# notes\n\nsolid advice inside\n");
    const put = await upload("readme.stl", text);
    expect(put.status).toBe(201);
    const blob = await user.request<{ kind: string; mime: string }>(
      `/api/repos/${username}/${repo}/blob?path=readme.stl&ref=main`,
    );
    expect(blob.data.kind).toBe("text");
  });

  test("an ASCII STL does become geometry", async () => {
    const stl = new TextEncoder().encode(
      "solid bracket\nfacet normal 0 0 1\n  outer loop\n    vertex 0 0 0\n    vertex 2 0 0\n    vertex 0 2 0\n  endloop\nendfacet\nendsolid bracket\n",
    );
    const put = await upload("bracket.stl", stl);
    expect(put.status).toBe(201);
    const blob = await user.request<{ kind: string; mime: string }>(
      `/api/repos/${username}/${repo}/blob?path=bracket.stl&ref=main`,
    );
    expect(blob.data.kind).toBe("model");
    expect(blob.data.mime).toBe("model/stl");
  });

  test("raw serves every uploaded shape byte-identically with nosniff", async () => {
    const cases: Array<[string, Uint8Array]> = [
      ["tone.wav", wavFixture()],
      ["bracket.stl", new TextEncoder().encode("solid bracket\nfacet normal 0 0 1\n  outer loop\n    vertex 0 0 0\n    vertex 2 0 0\n    vertex 0 2 0\n  endloop\nendfacet\nendsolid bracket\n")],
    ];
    for (const [name, bytes] of cases) {
      const raw = await fetch(`${BASE}/api/repos/${username}/${repo}/raw?ref=main&path=${name}`);
      expect(raw.status).toBe(200);
      expect(raw.headers.get("x-content-type-options")).toBe("nosniff");
      const served = new Uint8Array(await raw.arrayBuffer());
      expect(Buffer.from(served).equals(Buffer.from(bytes))).toBe(true);
    }
  });
});

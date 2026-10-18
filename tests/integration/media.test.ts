import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "../../src/server.ts";

const scratch = mkdtempSync(join(tmpdir(), "gg-media-test-"));
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
const username = `med${run}`;
const repo = "media";

function wavBytes(): Buffer {
  const data = Buffer.from([0x80, 0x7f, 0x40, 0xc0]);
  const buffer = Buffer.alloc(44 + data.length);
  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36 + data.length, 4);
  buffer.write("WAVE", 8);
  buffer.write("fmt ", 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(8000, 24);
  buffer.writeUInt32LE(8000, 28);
  buffer.writeUInt16LE(1, 32);
  buffer.writeUInt16LE(8, 34);
  buffer.write("data", 36);
  buffer.writeUInt32LE(data.length, 40);
  data.copy(buffer, 44);
  return buffer;
}

function binaryStlBytes(): Buffer {
  const buffer = Buffer.alloc(84 + 50);
  buffer.write("media test stl", 0);
  buffer.writeUInt32LE(1, 80);
  return buffer;
}

const fixtures: Array<{ name: string; bytes: Buffer; kind: string; mime: string }> = [
  { name: "tone.wav", bytes: wavBytes(), kind: "audio", mime: "audio/wav" },
  {
    name: "clip.webm",
    bytes: Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x01, 0, 0, 0, 0, 0, 0, 0]), Buffer.from("...webm")]),
    kind: "video",
    mime: "video/webm",
  },
  { name: "part.stl", bytes: binaryStlBytes(), kind: "model", mime: "model/stl" },
  {
    name: "scene.glb",
    bytes: Buffer.concat([Buffer.from("glTF"), Buffer.from([0x02, 0, 0, 0]), Buffer.alloc(20)]),
    kind: "model",
    mime: "model/gltf-binary",
  },
];

beforeAll(async () => {
  await user.request("/api/auth/signup", {
    method: "POST",
    body: { username, email: `${username}@example.com`, password: "supersecret123" },
  });
  await user.request("/api/repos", { method: "POST", body: { name: repo } });
});

describe("media previews end to end", () => {
  for (const fixture of fixtures) {
    test(`${fixture.name} -> kind=${fixture.kind}, raw served as ${fixture.mime}`, async () => {
      const put = await user.request(`/api/repos/${username}/${repo}/contents`, {
        method: "PUT",
        body: {
          path: fixture.name,
          branch: "main",
          content: fixture.bytes.toString("base64"),
          encoding: "base64",
        },
      });
      expect(put.status).toBe(201);

      const blob = await user.request<{ kind: string; mime: string }>(
        `/api/repos/${username}/${repo}/blob?path=${fixture.name}&ref=main`,
      );
      expect(blob.status).toBe(200);
      expect(blob.data.kind).toBe(fixture.kind);
      expect(blob.data.mime).toBe(fixture.mime);

      const raw = await fetch(`${BASE}/api/repos/${username}/${repo}/raw?ref=main&path=${fixture.name}`);
      expect(raw.status).toBe(200);
      expect(raw.headers.get("content-type")).toBe(fixture.mime);
      expect(raw.headers.get("x-content-type-options")).toBe("nosniff");
      const bytes = new Uint8Array(await raw.arrayBuffer());
      expect(Buffer.from(bytes).equals(fixture.bytes)).toBe(true);
    });
  }

  test("the tree lists media files without downloading them", async () => {
    const tree = await user.request<{ items: Array<{ name: string; size: number }> }>(
      `/api/repos/${username}/${repo}/tree?ref=main`,
    );
    expect(tree.status).toBe(200);
    const names = tree.data.items.map((entry) => entry.name);
    for (const fixture of fixtures) expect(names).toContain(fixture.name);
  });
});

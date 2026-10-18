import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { createServer } from "../../src/server.ts";

const server = createServer(0);
const BASE = `http://127.0.0.1:${server.port}`;
const stamp = Date.now().toString(36);
const victim = `lv${stamp}`;
const attacker = `la${stamp}`;
const PASSWORD = "lfs-isolation-password";
const LFS = "application/vnd.git-lfs+json";
const basic = (user: string) => `Basic ${Buffer.from(`${user}:${PASSWORD}`).toString("base64")}`;
const secret = new TextEncoder().encode(`private payload ${stamp}`);
const oid = createHash("sha256").update(secret).digest("hex");

async function call(path: string, user: string, init: RequestInit = {}) {
  return fetch(BASE + path, { ...init, headers: { authorization: basic(user), ...(init.headers as Record<string, string>) } });
}
async function json(path: string, user: string, method: string, body: unknown) {
  return call(path, user, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}
async function batch(owner: string, repo: string, user: string, operation: "upload" | "download") {
  const response = await call(`/${owner}/${repo}.git/info/lfs/objects/batch`, user, {
    method: "POST",
    headers: { accept: LFS, "content-type": LFS },
    body: JSON.stringify({ operation, transfers: ["basic"], objects: [{ oid, size: secret.length }] }),
  });
  return (await response.json()) as { objects: { actions?: Record<string, unknown>; error?: { code: number } }[] };
}

beforeAll(async () => {
  for (const name of [victim, attacker]) {
    await fetch(`${BASE}/api/auth/signup`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: name, email: `${name}@example.test`, password: PASSWORD }) });
  }
  expect((await json("/api/repos", victim, "POST", { name: "vault", visibility: "private" })).status).toBe(201);
  expect((await json("/api/repos", victim, "POST", { name: "shared" })).status).toBe(201);
  expect((await json("/api/repos", attacker, "POST", { name: "probe" })).status).toBe(201);
  const put = await call(`/${victim}/vault.git/info/lfs/objects/${oid}`, victim, { method: "PUT", body: new Blob([secret]) });
  expect(put.status).toBe(200);
});
afterAll(() => server.stop(true));

describe("LFS objects are scoped to the repositories that hold them", () => {
  test("the owning repository can download its object", async () => {
    expect((await batch(victim, "vault", victim, "download")).objects[0]!.actions?.download).toBeDefined();
    const response = await call(`/${victim}/vault.git/info/lfs/objects/${oid}`, victim);
    expect(response.status).toBe(200);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(secret);
  });

  test("another repository cannot download it by object id", async () => {
    expect((await batch(attacker, "probe", attacker, "download")).objects[0]!.error?.code).toBe(404);
    expect((await call(`/${attacker}/probe.git/info/lfs/objects/${oid}`, attacker)).status).toBe(404);
  });

  test("declaring the object for upload does not grant it; the bytes must be sent", async () => {
    expect((await batch(attacker, "probe", attacker, "upload")).objects[0]!.actions?.upload).toBeDefined();
    expect((await call(`/${attacker}/probe.git/info/lfs/objects/${oid}`, attacker)).status).toBe(404);
    const wrong = await call(`/${attacker}/probe.git/info/lfs/objects/${oid}`, attacker, { method: "PUT", body: new Blob([new TextEncoder().encode("guess")]) });
    expect(wrong.status).toBe(422);
    expect((await call(`/${attacker}/probe.git/info/lfs/objects/${oid}`, attacker)).status).toBe(404);
  });

  test("a forged pointer committed to another repository shows the pointer text, not the private content", async () => {
    const pointer = `version https://git-lfs.github.com/spec/v1\noid sha256:${oid}\nsize ${secret.length}\n`;
    const created = await json(`/api/repos/${attacker}/probe/contents`, attacker, "PUT", { branch: "main", path: "stolen.bin", content: pointer, encoding: "utf8" });
    expect(created.status).toBe(201);
    const raw = await call(`/api/repos/${attacker}/probe/raw?ref=main&path=stolen.bin`, attacker);
    const body = new Uint8Array(await raw.arrayBuffer());
    expect(new TextDecoder().decode(body)).toContain("git-lfs.github.com/spec/v1");
    expect(body).not.toEqual(secret);
    const blob = await (await call(`/api/repos/${attacker}/probe/blob?ref=main&path=stolen.bin`, attacker)).text();
    expect(blob).not.toContain(new TextDecoder().decode(secret));
  });

  test("a fork inherits its parent's objects", async () => {
    const put = await call(`/${victim}/shared.git/info/lfs/objects/${oid}`, victim, { method: "PUT", body: new Blob([secret]) });
    expect(put.status).toBe(200);
    const fork = await json(`/api/repos/${victim}/shared/forks`, attacker, "POST", { name: "shared-fork" });
    expect(fork.status).toBe(201);
    const response = await call(`/${attacker}/shared-fork.git/info/lfs/objects/${oid}`, attacker);
    expect(response.status).toBe(200);
  });

  test("uploading the genuine bytes proves possession and links the object", async () => {
    const put = await call(`/${attacker}/probe.git/info/lfs/objects/${oid}`, attacker, { method: "PUT", body: new Blob([secret]) });
    expect(put.status).toBe(200);
    expect((await call(`/${attacker}/probe.git/info/lfs/objects/${oid}`, attacker)).status).toBe(200);
  });
});

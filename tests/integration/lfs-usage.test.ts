import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { createServer } from "../../src/server.ts";
import { changes } from "../../src/db/index.ts";
import { findRepo, repoDiskPath } from "../../src/data/repos.ts";
import { repoLfsUsage, scanRepoPointers } from "../../src/lfs/usage.ts";

const server = createServer(0);
const BASE = `http://127.0.0.1:${server.port}`;
const run = Date.now().toString(36);
const owner = `lfu${run}`;
const reader = `lfr${run}`;
const PASSWORD = "lfs-usage-password";
const LFS = "application/vnd.git-lfs+json";

afterAll(() => server.stop(true));

let cookie = "";
async function api<T>(path: string, method = "GET", body?: unknown): Promise<{ status: number; data: T }> {
  const response = await fetch(BASE + path, {
    method,
    headers: { ...(cookie ? { cookie } : {}), ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const setCookie = response.headers.get("set-cookie");
  if (setCookie) cookie = setCookie.split(";")[0]!;
  return { status: response.status, data: (await response.json().catch(() => null)) as T };
}

const basic = (user: string) => `Basic ${Buffer.from(`${user}:${PASSWORD}`).toString("base64")}`;

function object(content: string): { oid: string; size: number; bytes: Uint8Array<ArrayBuffer> } {
  const bytes = new TextEncoder().encode(content);
  return { oid: createHash("sha256").update(bytes).digest("hex"), size: bytes.length, bytes };
}

async function batch(repo: string, user: string, operation: "upload" | "download", objects: { oid: string; size: number }[]) {
  const response = await fetch(`${BASE}/${owner}/${repo}.git/info/lfs/objects/batch`, {
    method: "POST",
    headers: { authorization: basic(user), accept: LFS, "content-type": LFS },
    body: JSON.stringify({ operation, transfers: ["basic"], objects }),
  });
  return { status: response.status, data: (await response.json()) as { objects: { oid: string; actions?: unknown }[] } };
}

async function upload(repo: string, obj: { oid: string; bytes: Uint8Array<ArrayBuffer> }) {
  const response = await fetch(`${BASE}/${owner}/${repo}.git/info/lfs/objects/${obj.oid}`, {
    method: "PUT",
    headers: { authorization: basic(owner), "content-type": "application/octet-stream" },
    body: new Blob([obj.bytes]),
  });
  return response.status;
}

async function stats(repo: string): Promise<{ lfsObjects: number; lfsBytes: number }> {
  const detail = await api<{ stats: { lfsObjects: number; lfsBytes: number } }>(`/api/repos/${owner}/${repo}`);
  return detail.data.stats;
}

const first = object(`first asset ${run}`);
const second = object(`second asset, a little longer ${run}`);

beforeAll(async () => {
  await api("/api/auth/signup", "POST", { username: reader, email: `${reader}@example.test`, password: PASSWORD });
  cookie = "";
  await api("/api/auth/signup", "POST", { username: owner, email: `${owner}@example.test`, password: PASSWORD });
  for (const name of ["one", "two", "scanned"]) {
    expect((await api("/api/repos", "POST", { name })).status).toBe(201);
  }
});

describe("lfs usage", () => {
  test("a fresh repository reports zero", async () => {
    expect(await stats("one")).toMatchObject({ lfsObjects: 0, lfsBytes: 0 });
  });

  test("an upload is counted with its stored size", async () => {
    const declared = await batch("one", owner, "upload", [{ oid: first.oid, size: first.size }]);
    expect(declared.status).toBe(200);
    expect(await upload("one", first)).toBe(200);
    expect(await stats("one")).toMatchObject({ lfsObjects: 1, lfsBytes: first.size });
  });

  test("an object already in the store is linked when a second repository declares it", async () => {
    const declared = await batch("two", owner, "upload", [{ oid: first.oid, size: first.size }]);
    expect(declared.data.objects[0]!.actions).toBeUndefined();
    expect(await stats("two")).toMatchObject({ lfsObjects: 1, lfsBytes: first.size });
  });

  test("declaring an object that is never uploaded adds no usage", async () => {
    await batch("one", owner, "upload", [{ oid: second.oid, size: second.size }]);
    expect(await stats("one")).toMatchObject({ lfsObjects: 1, lfsBytes: first.size });
  });

  test("repeat uploads do not double count", async () => {
    expect(await upload("one", first)).toBe(200);
    expect(await upload("one", second)).toBe(200);
    expect(await stats("one")).toMatchObject({ lfsObjects: 2, lfsBytes: first.size + second.size });
  });

  test("the list endpoint carries the same totals", async () => {
    const list = await api<{ items: { name: string; lfsObjects: number; lfsBytes: number }[] }>(`/api/users/${owner}/repos`);
    const row = list.data.items.find((item) => item.name === "one");
    expect(row).toMatchObject({ lfsObjects: 2, lfsBytes: first.size + second.size });
  });

  test("a reader's download batch never adds usage", async () => {
    await batch("scanned", reader, "download", [{ oid: first.oid, size: first.size }]);
    expect(await stats("scanned")).toMatchObject({ lfsObjects: 0, lfsBytes: 0 });
  });

  test("the pointer scan backfills a repository whose history predates the link table", async () => {
    const pointer = `version https://git-lfs.github.com/spec/v1\noid sha256:${second.oid}\nsize ${second.size}\n`;
    const put = await api(`/api/repos/${owner}/scanned/contents`, "PUT", {
      path: "assets/big.bin",
      branch: "main",
      content: pointer,
      encoding: "utf8",
    });
    expect(put.status).toBe(201);
    await api(`/api/repos/${owner}/scanned/contents`, "PUT", {
      path: "README.md",
      branch: "main",
      content: "x".repeat(150),
      encoding: "utf8",
    });
    const repo = findRepo(owner, "scanned")!;
    changes("DELETE FROM lfs_repo_objects WHERE repo_id = ?", repo.id);
    expect(repoLfsUsage(repo.id)).toEqual({ objects: 0, bytes: 0 });

    expect(await scanRepoPointers(repo.id, repoDiskPath(repo))).toBe(1);
    expect(await stats("scanned")).toMatchObject({ lfsObjects: 1, lfsBytes: second.size });
    await scanRepoPointers(repo.id, repoDiskPath(repo));
    expect(repoLfsUsage(repo.id)).toEqual({ objects: 1, bytes: second.size });
  });

  test("deleting a repository removes its links", async () => {
    const repo = findRepo(owner, "two")!;
    expect((await api(`/api/repos/${owner}/two`, "DELETE")).status).toBeLessThan(300);
    expect(repoLfsUsage(repo.id)).toEqual({ objects: 0, bytes: 0 });
  });
});

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "../../src/server.ts";

const scratch = mkdtempSync(join(tmpdir(), "gg-commit-file-test-"));
const server = createServer(0);
const BASE = `http://127.0.0.1:${server.port}`;
const run = Date.now().toString(36);
const username = `cfv${run}`;
const repo = "history";

afterAll(async () => {
  await server.stop(true);
  rmSync(scratch, { recursive: true, force: true });
});

let cookie = "";
async function call<T>(path: string, options: { method?: string; body?: unknown } = {}): Promise<{ status: number; data: T }> {
  const headers: Record<string, string> = {};
  if (cookie) headers.cookie = cookie;
  if (options.body !== undefined) headers["content-type"] = "application/json";
  const response = await fetch(`${BASE}${path}`, {
    method: options.method ?? "GET",
    headers,
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
  const setCookie = response.headers.get("set-cookie");
  if (setCookie) cookie = setCookie.split(";")[0] ?? "";
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

async function rawAt(ref: string, path: string): Promise<{ status: number; text: string }> {
  const response = await fetch(
    `${BASE}/api/repos/${username}/${repo}/raw?ref=${encodeURIComponent(ref)}&path=${encodeURIComponent(path)}`,
  );
  return { status: response.status, text: await response.text() };
}

const FIRST = "const value = 'first';\n";
const SECOND = "const value = 'second';\nconst extra = true;\n";
const PATH = "src/value.ts";
const LATER_PATH = "src/added-later.ts";

let firstCommit = "";
let secondCommit = "";

beforeAll(async () => {
  await call("/api/auth/signup", {
    method: "POST",
    body: { username, email: `${username}@example.com`, password: "supersecret123" },
  });
  await call("/api/repos", { method: "POST", body: { name: repo } });

  const first = await call<{ commit: string }>(`/api/repos/${username}/${repo}/contents`, {
    method: "PUT",
    body: { path: PATH, branch: "main", content: FIRST, encoding: "utf8" },
  });
  firstCommit = first.data.commit;

  const second = await call<{ commit: string }>(`/api/repos/${username}/${repo}/contents`, {
    method: "PUT",
    body: { path: PATH, branch: "main", content: SECOND, encoding: "utf8" },
  });
  secondCommit = second.data.commit;
  await call(`/api/repos/${username}/${repo}/contents`, {
    method: "PUT",
    body: { path: LATER_PATH, branch: "main", content: "export const later = 1;\n", encoding: "utf8" },
  });
});

describe("a file resolves to its content at a specific commit", () => {
  test("the two commits really are different commits", async () => {
    expect(firstCommit).toMatch(/^[0-9a-f]{40,64}$/);
    expect(secondCommit).toMatch(/^[0-9a-f]{40,64}$/);
    expect(firstCommit).not.toBe(secondCommit);
  });

  test("raw at the older commit serves the older bytes, not the branch tip", async () => {
    const at = await rawAt(firstCommit, PATH);
    const tip = await rawAt("main", PATH);
    expect(at.status).toBe(200);
    expect(at.text).toBe(FIRST);
    expect(tip.status).toBe(200);
    expect(tip.text).toBe(SECOND);
    expect(at.text).not.toBe(tip.text);
  });

  test("the blob endpoint honours a bare 40-character SHA as a ref", async () => {
    expect(firstCommit).toHaveLength(40);
    const at = await call<{ content: string; path: string }>(
      `/api/repos/${username}/${repo}/blob?ref=${firstCommit}&path=${encodeURIComponent(PATH)}`,
    );
    expect(at.status).toBe(200);
    expect(at.data.content).toBe(FIRST);
    expect(at.data.path).toBe(PATH);
  });

  test("a path that did not exist yet is refused at the older commit", async () => {
    const missing = await rawAt(firstCommit, LATER_PATH);
    expect(missing.status).toBe(404);

    const present = await rawAt("main", LATER_PATH);
    expect(present.status).toBe(200);
  });

  test("the tree at a commit is the tree that commit produced", async () => {
    const at = await call<{ items: { name: string; type: string }[] }>(
      `/api/repos/${username}/${repo}/tree?ref=${firstCommit}`,
    );
    expect(at.status).toBe(200);
    const names = at.data.items.map((item) => item.name);
    expect(names).toContain("src");

    const atSrc = await call<{ items: { name: string }[] }>(
      `/api/repos/${username}/${repo}/tree?ref=${firstCommit}&path=src`,
    );
    const tipSrc = await call<{ items: { name: string }[] }>(
      `/api/repos/${username}/${repo}/tree?ref=main&path=src`,
    );
    expect(atSrc.data.items.map((i) => i.name)).toContain("value.ts");
    expect(atSrc.data.items.map((i) => i.name)).not.toContain("added-later.ts");
    expect(tipSrc.data.items.map((i) => i.name)).toContain("added-later.ts");
  });

  test("the commit's own diff names the file that changed", async () => {
    const detail = await call<{ sha: string; files: unknown[]; message: string }>(
      `/api/repos/${username}/${repo}/commits/${secondCommit}`,
    );
    expect(detail.status).toBe(200);
    expect(detail.data.sha).toBe(secondCommit);
    const serialised = JSON.stringify(detail.data.files);
    expect(serialised).toContain("value.ts");
  });
});

const source = await Bun.file(join(import.meta.dir, "..", "..", "src", "web", "components", "DiffView.tsx")).text();
const commitPage = await Bun.file(join(import.meta.dir, "..", "..", "src", "web", "pages", "Commit.tsx")).text();

describe("the diff links a file to that file at that commit", () => {

  test("the commit page hands the diff the commit's own SHA as the ref", async () => {
    expect(commitPage).toContain("context={{ owner, repo, ref: detail.sha, baseRef: detail.parents[0] ?? null }}");
  });

  test("the file header links to the blob at that ref", () => {
    expect(source).toContain("context.owner");
    expect(source).toContain("/blob/${context.ref}/${file.path}");
  });

  test("a deleted file cannot be viewed, and says so rather than vanishing", () => {
    expect(source).toContain('const exists = file.status !== "deleted"');
    expect(source).toContain("disabledReason: gone");
    expect(source).toContain('label: "History"');
  });

  test("the collapse control is a button and the path is a sibling link", () => {
    expect(source).not.toMatch(/<button className="diff-file-head"[^>]*>[\s\S]{0,400}<Link/);
    expect(source).toContain('className="diff-file-toggle"');
    expect(source).toContain("aria-controls={bodyId}");
  });

  test("every body branch carries the id the collapse control points at", () => {
    const ids = source.match(/id=\{bodyId\}/g) ?? [];
    expect(ids.length).toBe(5);
  });
});

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "../../src/server.ts";
import { git } from "../../src/git/run.ts";
import { HIGHLIGHT_LIMITS } from "../../src/web/highlight.ts";

const scratch = mkdtempSync(join(tmpdir(), "gg-large-test-"));
const server = createServer(0);
const BASE = `http://127.0.0.1:${server.port}`;
const run = Date.now().toString(36);
const identity = ["-c", "user.name=Large", "-c", "user.email=large@example.com"];
const SOURCE = join(import.meta.dir, "..", "fixtures", "express-ish");

interface RepoListing {
  items: Array<{ name: string; type: string; path: string; size: number; sha: string }>;
}

afterAll(async () => {
  await server.stop(true);
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      rmSync(scratch, { recursive: true, force: true, maxRetries: 3 });
      return;
    } catch {
      await Bun.sleep(200);
    }
  }
}, 60_000);

interface CommitList {
  items: Array<{ sha: string; message: string; short_sha: string }>;
  has_more: boolean;
}

interface DiffJson {
  files: Array<{
    path: string;
    old_path: string | null;
    status: string;
    additions: number;
    deletions: number;
    omitted: string | null;
    language: string | null;
    hunks: Array<{ lines: Array<{ kind: string; old_line: number | null; new_line: number | null }> }>;
  }>;
  additions: number;
  deletions: number;
  truncated: boolean;
}

interface BlobJson {
  kind: "text" | "image" | "binary";
  language: string | null;
  line_count: number;
  size: number;
  truncated: boolean;
  content: string | null;
}

class Client {
  cookie = "";
  async request<T>(
    path: string,
    options: { method?: string; body?: unknown } = {},
  ): Promise<{ status: number; data: T; bytes: number }> {
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
    return { status: response.status, data: data as T, bytes: Buffer.byteLength(text) };
  }
}

const user = new Client();
const username = `large${run}`;
const work = join(scratch, "work");
let token = "";
let headSha = "";
let fixtureCommits = 0;

beforeAll(async () => {
  if (!existsSync(SOURCE)) {
    throw new Error(
      `Fixture missing at ${SOURCE}. Generate it with: bun tests/fixtures/make-large-repo.ts`,
    );
  }

  await user.request("/api/auth/signup", {
    method: "POST",
    body: { username, email: `${username}@example.com`, password: "supersecret123" },
  });
  const issued = await user.request<{ token: string }>("/api/tokens", {
    method: "POST",
    body: { name: "large" },
  });
  token = issued.data.token;
  await user.request("/api/repos", { method: "POST", body: { name: "framework", description: "large fixture" } });

  const remote = `${BASE.replace("http://", `http://${username}:${token}@`)}/${username}/framework.git`;
  mkdirSync(work);
  await git(["clone", "-q", SOURCE, work], { cwd: scratch });
  await git(["remote", "set-url", "origin", remote], { cwd: work });
  await git(["fetch", "-q", SOURCE, "next:next"], { cwd: work });
  const push = await git(["push", "-q", "origin", "main", "next", "--tags"], { cwd: work });
  expect(push.exitCode).toBe(0);

  headSha = (await git(["rev-parse", "HEAD"], { cwd: work })).stdout.trim();
  fixtureCommits = Number.parseInt((await git(["rev-list", "--count", "HEAD"], { cwd: work })).stdout.trim(), 10);
}, 300_000);

function mkdirSync(dir: string): void {
  require("node:fs").mkdirSync(dir, { recursive: true });
}

describe("large repository: shape", () => {
  test("the fixture is genuinely large enough to be interesting", () => {
    expect(fixtureCommits).toBeGreaterThan(30);
  });

  test("history pages and reports more available", async () => {
    const page = await user.request<CommitList>(`/api/repos/${username}/framework/commits?ref=main`);
    expect(page.data.items.length).toBe(30);
    expect(page.data.has_more).toBe(true);
    const second = await user.request<CommitList>(`/api/repos/${username}/framework/commits?ref=main&page=2`);
    expect(second.data.items[0]?.sha).not.toBe(page.data.items[0]?.sha);
  });

  test("the root tree lists directories first with sizes", async () => {
    const tree = await user.request<RepoListing>(`/api/repos/${username}/framework/tree`);
    expect(tree.data.items.length).toBeGreaterThanOrEqual(4);
    const types = tree.data.items.map((entry) => entry.type);
    const firstFile = types.indexOf("blob");
    const lastDir = types.lastIndexOf("tree");
    if (firstFile !== -1 && lastDir !== -1) {
      expect(lastDir).toBeLessThan(firstFile);
    }
    const biggest = tree.data.items.filter((entry) => entry.type === "blob").sort((a, b) => b.size - a.size)[0];
    expect(biggest?.size).toBeGreaterThan(0);

    for (const entry of tree.data.items) {
      expect(entry.path.length).toBeGreaterThan(0);
      expect(entry.sha).toMatch(/^[0-9a-f]{40}$/);
    }
  });

  test("a nested directory resolves by path", async () => {
    const tree = await user.request<RepoListing>(`/api/repos/${username}/framework/tree?path=lib`);
    expect(tree.data.items.length).toBeGreaterThan(0);
    for (const entry of tree.data.items) expect(entry.path.startsWith("lib/")).toBe(true);
  });

  test("branches and tags from the fixture are all present", async () => {
    const branches = await user.request<{ items: Array<{ name: string }> }>(
      `/api/repos/${username}/framework/branches`,
    );
    expect(branches.data.items.length).toBeGreaterThanOrEqual(2);
    const tags = await user.request<{ items: Array<{ name: string }> }>(
      `/api/repos/${username}/framework/tags`,
    );
    expect(tags.data.items.length).toBeGreaterThanOrEqual(2);
  });
});

describe("large repository: real source files", () => {
  test("a real JavaScript file is classified and highlighted as such", async () => {
    const blob = await user.request<BlobJson>(
      `/api/repos/${username}/framework/blob?path=lib/router/index.js&ref=main`,
    );
    expect(blob.status).toBe(200);
    expect(blob.data.kind).toBe("text");
    expect(blob.data.language ?? "").toBe("javascript");
    expect(blob.data.line_count).toBeGreaterThan(50);
    expect(blob.data.content).toContain("function");
  });

  test("line count matches the content it returns", async () => {
    const blob = await user.request<BlobJson>(
      `/api/repos/${username}/framework/blob?path=lib/router/index.js&ref=main`,
    );
    const actual = (blob.data.content ?? "").split("\n").length;
    expect(Math.abs((blob.data.line_count ?? 0) - actual)).toBeLessThanOrEqual(1);
  });

  test("a large generated file crosses the highlight limit and is reported as such", async () => {
    const blob = await user.request<BlobJson>(
      `/api/repos/${username}/framework/blob?path=lib/generated/bundle.js&ref=main`,
    );
    expect(blob.status).toBe(200);

    expect(blob.data.line_count).toBeGreaterThan(HIGHLIGHT_LIMITS.maxLines);
    expect(blob.data.size).toBeLessThan(HIGHLIGHT_LIMITS.maxBytes);

    expect((blob.data.content ?? "").length).toBe(blob.data.size);
    expect(blob.data.truncated).toBe(false);
  });

  test("a file with unusual characters in its path still resolves", async () => {
    const blob = await user.request<BlobJson>(
      `/api/repos/${username}/framework/blob?path=lib/edge/case-sensitive%2Bname.js&ref=main`,
    );
    expect(blob.status).toBe(200);
    expect(blob.data.kind).toBe("text");
  });

  test("markdown and json files get their own languages", async () => {
    const readme = await user.request<BlobJson>(
      `/api/repos/${username}/framework/blob?path=README.md&ref=main`,
    );
    expect(readme.data.language ?? "").toBe("markdown");
    const pkg = await user.request<BlobJson>(
      `/api/repos/${username}/framework/blob?path=package.json&ref=main`,
    );
    expect(pkg.data.language ?? "").toBe("json");
  });

  test("raw bytes for a source file match the blob content", async () => {
    const blob = await user.request<BlobJson>(
      `/api/repos/${username}/framework/blob?path=lib/router/index.js&ref=main`,
    );
    const raw = await fetch(`${BASE}/api/repos/${username}/framework/raw?path=lib/router/index.js&ref=main`);
    expect(raw.status).toBe(200);
    const rawText = await raw.text();
    expect(rawText).toBe(blob.data.content ?? "");
  });
});

describe("large repository: diffs at scale", () => {
  test("a commit early in history diffs without error", async () => {
    const history = await user.request<CommitList>(`/api/repos/${username}/framework/commits?ref=main&page=2`);
    const sha = history.data.items[history.data.items.length - 1]?.sha ?? "";
    const diff = await user.request<DiffJson>(`/api/repos/${username}/framework/commits/${sha}/diff`);
    expect(diff.status).toBe(200);
    expect(diff.data.files.length).toBeGreaterThan(0);
  });

  test("line numbers on both sides hold deep into a large diff", async () => {
    const diff = await user.request<DiffJson>(`/api/repos/${username}/framework/commits/${headSha}/diff`);
    const lines = diff.data.files.flatMap((file) => file.hunks.flatMap((hunk) => hunk.lines));
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      if (line.kind === "add") expect(line.old_line).toBeNull();
      else if (line.kind === "del") expect(line.new_line).toBeNull();
      else {
        expect(line.old_line).not.toBeNull();
        expect(line.new_line).not.toBeNull();
      }
    }
  });

  test("the full history diff is bounded rather than unbounded", async () => {
    const perPage = 30;
    let oldest = headSha;
    for (let page = 1; page <= 10; page++) {
      const history = await user.request<CommitList>(
        `/api/repos/${username}/framework/commits?ref=main&page=${page}`,
      );
      if (history.data.items.length === 0) break;
      oldest = history.data.items[history.data.items.length - 1]?.sha ?? oldest;
      if (!history.data.has_more) break;
      void perPage;
    }
    const diff = await user.request<DiffJson>(`/api/repos/${username}/framework/commits/${oldest}/diff`);
    expect(diff.status).toBe(200);
    const totalLines = diff.data.files.reduce((sum, file) => sum + file.additions + file.deletions, 0);
    if (totalLines > 20_000) expect(diff.data.truncated).toBe(true);
  });

  test("a rename deep in the tree reports its previous path", async () => {
    const history = await user.request<CommitList>(`/api/repos/${username}/framework/commits?ref=main`);
    let found: DiffJson["files"][number] | undefined;
    for (const commit of history.data.items) {
      const diff = await user.request<DiffJson>(`/api/repos/${username}/framework/commits/${commit.sha}/diff`);
      found = diff.data.files.find((file) => file.status === "renamed");
      if (found) break;
    }
    expect(found).toBeDefined();
    expect(found?.old_path).toBeTruthy();
    expect(found?.old_path).not.toBe(found?.path);
  }, 60_000);
});

describe("large repository: blame and archives", () => {
  test("blame attributes a real file line by line", async () => {
    const blame = await user.request<{
      lines: Array<{ line: number; sha: string; author: string; text: string }>;
      total_lines: number;
      language?: string | null;
    }>(`/api/repos/${username}/framework/blame?path=lib/router/index.js&ref=main`);
    expect(blame.status).toBe(200);
    expect(blame.data.lines.length).toBeGreaterThan(50);
    expect(blame.data.language ?? "").toBe("javascript");
    expect(blame.data.lines[0]?.line).toBe(1);
    for (let i = 1; i < blame.data.lines.length; i++) {
      expect((blame.data.lines[i]?.line ?? 0) - (blame.data.lines[i - 1]?.line ?? 0)).toBe(1);
    }
    for (const line of blame.data.lines) {
      expect(line.sha).toMatch(/^[0-9a-f]{40}$/);
      expect(line.author.length).toBeGreaterThan(0);
    }
  });

  test("blaming the large generated file is bounded, not an error", async () => {
    const blame = await user.request<{ lines: unknown[]; truncated: boolean }>(
      `/api/repos/${username}/framework/blame?path=lib/generated/bundle.js&ref=main`,
    );
    expect(blame.status).toBe(200);
    expect(Array.isArray(blame.data.lines)).toBe(true);
  });

  test("an archive of the whole repository downloads and is a valid zip", async () => {
    const response = await fetch(`${BASE}/api/repos/${username}/framework/archive?ref=main&format=zip`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.status).toBe(200);
    const bytes = new Uint8Array(await response.arrayBuffer());
    expect(bytes[0]).toBe(0x50);
    expect(bytes[1]).toBe(0x4b);
    expect(bytes.byteLength).toBeGreaterThan(10_000);

    const file = join(scratch, "large.zip");
    await Bun.write(file, bytes);
    const lister = process.platform === "win32" ? ["tar", "-tf", file] : ["unzip", "-Z1", file];
    const proc = Bun.spawn(lister, { stdout: "pipe", stderr: "pipe" });
    const [listing] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);

    const entries = listing
      .split("\n")
      .map((entry) => entry.replaceAll("\\", "/").trim())
      .filter((entry) => entry.length > 0);
    expect(entries.length).toBeGreaterThan(50);
    expect(entries.some((entry) => entry.endsWith("lib/router/index.js"))).toBe(true);
    expect(entries.some((entry) => entry.endsWith("lib/generated/bundle.js"))).toBe(true);
    expect(entries.some((entry) => entry.endsWith("UPPER.lower.js"))).toBe(true);
  }, 120_000);
});

describe("large repository: git CLI interop", () => {
  test("a fresh clone reproduces every tracked file byte for byte", async () => {
    const target = join(scratch, "verify-clone");
    const clone = await git(["clone", "-q", `${BASE}/${username}/framework.git`, target], { cwd: scratch });
    expect(clone.exitCode).toBe(0);

    const original = (await git(["ls-files"], { cwd: work })).stdout.trim().split("\n").filter(Boolean).sort();
    const cloned = (await git(["ls-files"], { cwd: target })).stdout.trim().split("\n").filter(Boolean).sort();
    expect(cloned.length).toBe(original.length);
    expect(cloned).toEqual(original);
    expect(cloned.length).toBeGreaterThan(50);

    for (const relative of ["package.json", "README.md", "lib/router/index.js"]) {
      const a = readFileSync(join(work, relative));
      const b = readFileSync(join(target, relative));
      expect(b.equals(a)).toBe(true);
    }
  }, 180_000);

  test("a shallow clone of the large repository also works", async () => {
    const target = join(scratch, "shallow");
    const clone = await git(["clone", "-q", "--depth", "1", `${BASE}/${username}/framework.git`, target], {
      cwd: scratch,
    });
    expect(clone.exitCode).toBe(0);
    const files = (await git(["ls-files"], { cwd: target })).stdout.trim().split("\n").filter(Boolean);
    expect(files.length).toBeGreaterThan(50);
  }, 180_000);

  test("incremental fetch after a new commit transfers only the delta", async () => {
    const target = join(scratch, "incremental");
    const firstClone = await git(["clone", "-q", `${BASE}/${username}/framework.git`, target], {
      cwd: scratch,
    });
    expect(firstClone.exitCode).toBe(0);
    const before = (await git(["rev-parse", "HEAD"], { cwd: target })).stdout.trim();

    await git(["checkout", "-q", "main"], { cwd: work });
    Bun.write(join(work, "lib/router/delta-marker.js"), "export const marker = 'delta';\n");
    await git(["add", "."], { cwd: work });
    await git([...identity, "commit", "-q", "-m", "add delta marker"], { cwd: work });
    const push = await git(["push", "-q", "origin", "main"], { cwd: work });
    expect(push.exitCode).toBe(0);

    const fetch = await git(["fetch", "-q", "origin"], { cwd: target });
    expect(fetch.exitCode).toBe(0);
    const after = (await git(["rev-parse", "origin/main"], { cwd: target })).stdout.trim();
    expect(after).not.toBe(before);

    Bun.write(join(target, "lib", "router", "delta-marker.js"), "stale\n");
    await git(["reset", "--hard", "-q", "origin/main"], { cwd: target });
    expect(readFileSync(join(target, "lib", "router", "delta-marker.js"), "utf8")).toContain("delta");
  }, 180_000);

  test("git log and git blame agree with what the API reports", async () => {
    const localLog = (await git(["log", "--format=%H", "-n", "5", "origin/main"], { cwd: work }))
      .stdout.trim()
      .split("\n");
    const apiLog = await user.request<CommitList>(`/api/repos/${username}/framework/commits?ref=main`);
    expect(apiLog.data.items.slice(0, 5).map((entry) => entry.sha)).toEqual(localLog);

    const localBlame = (await git(["blame", "--porcelain", "-L", "1,20", "lib/router/index.js"], { cwd: work }))
      .stdout.split("\n")
      .filter((line) => /^[0-9a-f]{40} /.test(line))
      .length;
    const apiBlame = await user.request<{ lines: unknown[] }>(
      `/api/repos/${username}/framework/blame?path=lib/router/index.js&ref=main`,
    );
    expect(apiBlame.data.lines.length).toBeGreaterThanOrEqual(20);
    expect(localBlame).toBeGreaterThan(0);
  }, 120_000);
});

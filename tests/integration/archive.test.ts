import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "../../src/server.ts";
import { git } from "../../src/git/run.ts";
import { BODY_PREVIEW_LENGTH } from "../../src/data/issues.ts";

const scratch = mkdtempSync(join(tmpdir(), "gg-archive-test-"));
const server = createServer(0);
const BASE = `http://127.0.0.1:${server.port}`;
const run = Date.now().toString(36);
const identity = ["-c", "user.name=Archiver", "-c", "user.email=archive@example.com"];

interface IssueListJson {
  items: Array<{
    number: number;
    title: string;
    body?: string;
    body_preview?: string;
    body_truncated?: boolean;
    comment_count?: number;
    labels?: string[];
  }>;
  total: number;
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
const username = `arch${run}`;
const work = join(scratch, "work");
let token = "";

async function extract(bytes: Uint8Array, label: string): Promise<string[]> {
  const dir = join(scratch, `extract-${label}`);
  mkdirSync(dir, { recursive: true });
  const archive = join(scratch, `${label}.bin`);
  writeFileSync(archive, bytes);
  const proc = Bun.spawn(["tar", "-xf", archive, "-C", dir], { stdout: "pipe", stderr: "pipe" });
  const [stderr, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
  if (code !== 0) throw new Error(`tar failed: ${stderr}`);

  const listing: string[] = [];
  const walk = (directory: string, prefix: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(join(directory, entry.name), relative);
      else listing.push(relative);
    }
  };
  walk(dir, "");
  return listing.sort();
}

beforeAll(async () => {
  await user.request("/api/auth/signup", {
    method: "POST",
    body: { username, email: `${username}@example.com`, password: "supersecret123" },
  });
  const issued = await user.request<{ token: string }>("/api/tokens", { method: "POST", body: { name: "arch" } });
  token = issued.data.token;

  const remote = `${BASE.replace("http://", `http://${username}:${token}@`)}/${username}/sources.git`;
  await user.request("/api/repos", { method: "POST", body: { name: "sources" } });

  mkdirSync(join(work, "src", "deep"), { recursive: true });
  writeFileSync(join(work, "README.md"), "# sources\n\narchived by the test suite\n");
  writeFileSync(join(work, "src", "index.ts"), "export const entry = 1;\n");
  writeFileSync(join(work, "src", "deep", "nested.txt"), "deep contents\n");
  await git(["init", "-q", "-b", "main", work], { cwd: work });
  await git(["remote", "add", "origin", remote], { cwd: work });
  await git(["add", "."], { cwd: work });
  await git([...identity, "commit", "-q", "-m", "initial"], { cwd: work });
  await git(["tag", "v1.0.0"], { cwd: work });
  await git(["push", "-q", "origin", "main"], { cwd: work });
  await git(["push", "-q", "origin", "v1.0.0"], { cwd: work });
  await git(["checkout", "-q", "-b", "feature/nested", "main"], { cwd: work });
  writeFileSync(join(work, "branch-only.txt"), "only on the branch\n");
  await git(["add", "."], { cwd: work });
  await git([...identity, "commit", "-q", "-m", "branch work"], { cwd: work });
  await git(["push", "-q", "origin", "feature/nested"], { cwd: work });
  await git(["checkout", "-q", "main"], { cwd: work });
}, 120_000);

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
}, 30_000);

describe("archive download", () => {
  test("serves a tar.gz that extracts to the repository contents", async () => {
    const response = await fetch(`${BASE}/api/repos/${username}/sources/archive?ref=main&format=tar.gz`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/gzip");
    expect(response.headers.get("content-disposition")).toContain("attachment");
    expect(response.headers.get("content-disposition")).toContain("sources-main.tar.gz");

    const bytes = new Uint8Array(await response.arrayBuffer());
    expect(bytes[0]).toBe(0x1f);
    expect(bytes[1]).toBe(0x8b);

    const files = await extract(bytes, "targz");
    expect(files).toContain("main/README.md");
    expect(files).toContain("main/src/index.ts");
    expect(files).toContain("main/src/deep/nested.txt");
    expect(files).not.toContain("main/branch-only.txt");

    const readme = readFileSync(join(scratch, "extract-targz", "main", "README.md"), "utf8");
    expect(readme).toContain("archived by the test suite");
  }, 60_000);

  test("serves a zip that extracts to the same contents", async () => {
    const response = await fetch(`${BASE}/api/repos/${username}/sources/archive?ref=main&format=zip`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/zip");
    const bytes = new Uint8Array(await response.arrayBuffer());
    expect(bytes[0]).toBe(0x50);
    expect(bytes[1]).toBe(0x4b);

    const files = await extract(bytes, "zip");
    expect(files).toContain("main/README.md");
    expect(files).toContain("main/src/deep/nested.txt");
  }, 60_000);

  test("archives a branch under its own name, including nested refs", async () => {
    const response = await fetch(`${BASE}/api/repos/${username}/sources/archive?ref=feature/nested`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-disposition")).toContain("sources-feature-nested.tar.gz");

    const bytes = new Uint8Array(await response.arrayBuffer());
    const files = await extract(bytes, "branch");
    expect(files).toContain("feature-nested/branch-only.txt");
    expect(files).toContain("feature-nested/README.md");
  }, 60_000);

  test("archives a tag", async () => {
    const response = await fetch(`${BASE}/api/repos/${username}/sources/archive?ref=v1.0.0&format=zip`);
    expect(response.status).toBe(200);
    const files = await extract(new Uint8Array(await response.arrayBuffer()), "tag");
    expect(files).toContain("v1.0.0/README.md");
  }, 60_000);

  test("scopes the archive to a subdirectory when asked", async () => {
    const response = await fetch(`${BASE}/api/repos/${username}/sources/archive?ref=main&path=src`);
    expect(response.status).toBe(200);
    const files = await extract(new Uint8Array(await response.arrayBuffer()), "subdir");
    expect(files).toContain("main/src/index.ts");
    expect(files).toContain("main/src/deep/nested.txt");
    expect(files.some((file) => file.endsWith("README.md"))).toBe(false);
  }, 60_000);

  test("defaults to the repository's default branch", async () => {
    const response = await fetch(`${BASE}/api/repos/${username}/sources/archive`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-disposition")).toContain("sources-main.tar.gz");
  }, 60_000);

  test("archives a bare commit sha", async () => {
    const commits = await user.request<{ items: Array<{ sha: string }> }>(
      `/api/repos/${username}/sources/commits?ref=main`,
    );
    const sha = commits.data.items[0]?.sha ?? "";
    const response = await fetch(`${BASE}/api/repos/${username}/sources/archive?ref=${sha}&format=zip`);
    expect(response.status).toBe(200);
    const files = await extract(new Uint8Array(await response.arrayBuffer()), "sha");
    expect(files).toContain(`${sha}/README.md`);
  }, 60_000);

  test("an unknown ref is a 404, not an empty download", async () => {
    const response = await fetch(`${BASE}/api/repos/${username}/sources/archive?ref=no-such-branch`);
    expect(response.status).toBe(404);
  });

  test("a traversal-shaped ref is refused", async () => {
    for (const ref of ["../../../etc/passwd", "..%2f..%2fetc", "a/b/../../../c"]) {
      const response = await fetch(
        `${BASE}/api/repos/${username}/sources/archive?ref=${encodeURIComponent(ref)}`,
      );
      expect([400, 404]).toContain(response.status);
      const disposition = response.headers.get("content-disposition") ?? "";
      expect(disposition.includes("..")).toBe(false);
    }
  });

  test("an unsupported format is a 400 with the supported list", async () => {
    const response = await fetch(`${BASE}/api/repos/${username}/sources/archive?format=rar`);
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { message: string } };
    expect(body.error.message).toContain("tar.gz");
    expect(body.error.message).toContain("zip");
  });

  test("anonymous access to a private repository's archive is denied", async () => {
    await user.request("/api/repos", { method: "POST", body: { name: "sealed", visibility: "private" } });
    const response = await fetch(`${BASE}/api/repos/${username}/sealed/archive`);
    expect(response.status).toBe(404);
  });

  test("an empty repository says so rather than blaming the ref name", async () => {
    await user.request("/api/repos", { method: "POST", body: { name: "empty" } });
    const emptyArchive = await user.request<{ error: { message: string } }>(
      `/api/repos/${username}/empty/archive`,
    );
    expect(emptyArchive.status).toBe(404);
    expect(emptyArchive.data.error.message).toContain("no commits yet");
    expect(emptyArchive.data.error.message).not.toContain("Ref");

    const badRef = await user.request<{ error: { message: string } }>(
      `/api/repos/${username}/sources/archive?ref=no-such-branch`,
    );
    expect(badRef.status).toBe(404);
    expect(badRef.data.error.message).toContain("no-such-branch");
  });

  test("counts archives served", async () => {
    const stats = await user.request<{ counters: Record<string, number> }>("/api/stats");
    expect(stats.data.counters.archives_served_total ?? 0).toBeGreaterThan(0);
  });
});

describe("list payloads omit full bodies", () => {
  const longBody = `${"Detailed reproduction steps. ".repeat(60)}END-OF-BODY-MARKER`;

  test("setup: create issues with a long body and comments", async () => {
    expect(longBody.length).toBeGreaterThan(BODY_PREVIEW_LENGTH * 2);

    for (let i = 1; i <= 3; i++) {
      const created = await user.request<{ number: number }>(`/api/repos/${username}/sources/issues`, {
        method: "POST",
        body: { title: `Issue ${i}`, body: longBody, labels: ["bug"] },
      });
      expect(created.status).toBe(201);
      const comments = i === 1 ? 2 : i === 2 ? 1 : 0;
      for (let c = 0; c < comments; c++) {
        await user.request(`/api/repos/${username}/sources/issues/${i}/comments`, {
          method: "POST",
          body: { body: `comment ${c}` },
        });
      }
    }
  }, 60_000);

  test("the list carries a preview instead of the body", async () => {
    const list = await user.request<IssueListJson>(`/api/repos/${username}/sources/issues?state=open`);
    expect(list.data.items.length).toBe(3);
    for (const item of list.data.items) {
      expect(item.body).toBeUndefined();
      expect(typeof item.body_preview).toBe("string");
      expect(item.body_preview?.length).toBeLessThanOrEqual(BODY_PREVIEW_LENGTH);
      expect(item.body_truncated).toBe(true);
    }
  });

  test("the list response is far smaller than the bodies it summarises", async () => {
    const list = await user.request<IssueListJson>(`/api/repos/${username}/sources/issues?state=open`);
    const serialized = JSON.stringify(list.data);
    const storedBodies = longBody.length * 3;
    expect(serialized.length).toBeLessThan(storedBodies);
  });

  test("comment counts are per-issue and come from the join", async () => {
    const list = await user.request<IssueListJson>(`/api/repos/${username}/sources/issues?state=open`);
    const byNumber = new Map(list.data.items.map((item) => [item.number, item]));
    expect(byNumber.get(1)?.comment_count).toBe(2);
    expect(byNumber.get(2)?.comment_count).toBe(1);
    expect(byNumber.get(3)?.comment_count).toBe(0);
  });

  test("labels still come through on list rows", async () => {
    const list = await user.request<IssueListJson>(`/api/repos/${username}/sources/issues?state=open`);
    expect(list.data.items[0]?.labels).toEqual(["bug"]);
  });

  test("the detail endpoint still returns the complete body", async () => {
    const detail = await user.request<{ body: string; comment_count: number }>(
      `/api/repos/${username}/sources/issues/1`,
    );
    expect(detail.data.body).toBe(longBody);
    expect(detail.data.body).toContain("END-OF-BODY-MARKER");
    expect(detail.data.comment_count).toBe(2);
  });

  test("a short body is not flagged as truncated", async () => {
    await user.request(`/api/repos/${username}/sources/issues`, {
      method: "POST",
      body: { title: "Short one", body: "brief" },
    });
    const list = await user.request<IssueListJson>(`/api/repos/${username}/sources/issues?state=open`);
    const short = list.data.items.find((item) => item.title === "Short one");
    expect(short?.body_preview).toBe("brief");
    expect(short?.body_truncated).toBe(false);
  });

  test("pull request lists use the same summary shape", async () => {
    const created = await user.request<{ number: number }>(`/api/repos/${username}/sources/pulls`, {
      method: "POST",
      body: { title: "Add a branch", head: "feature/nested", base: "main", body: longBody },
    });
    expect(created.status).toBe(201);

    const list = await user.request<{ items: Array<{ body?: string; body_preview?: string; head: string }> }>(
      `/api/repos/${username}/sources/pulls?state=open`,
    );
    expect(list.data.items.length).toBe(1);
    expect(list.data.items[0]?.body).toBeUndefined();
    expect(list.data.items[0]?.body_preview?.length).toBeLessThanOrEqual(BODY_PREVIEW_LENGTH);
    expect(list.data.items[0]?.head).toBe("feature/nested");

    const detail = await user.request<{ body: string }>(`/api/repos/${username}/sources/pulls/1`);
    expect(detail.data.body).toBe(longBody);
  }, 60_000);
});

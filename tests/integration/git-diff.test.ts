import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "../../src/server.ts";
import { git } from "../../src/git/run.ts";

const scratch = mkdtempSync(join(tmpdir(), "gg-diff-test-"));
const server = createServer(0);
const BASE = `http://127.0.0.1:${server.port}`;
const run = Date.now().toString(36);
const identity = ["-c", "user.name=Diff", "-c", "user.email=diff@example.com"];

interface DiffJson {
  files: Array<{
    path: string;
    old_path: string | null;
    status: string;
    binary: boolean;
    additions: number;
    deletions: number;
    omitted: string | null;
    language: string | null;
    hunks: Array<{
      header: string;
      old_start: number;
      new_start: number;
      lines: Array<{ kind: string; text: string; old_line: number | null; new_line: number | null }>;
    }>;
  }>;
  additions: number;
  deletions: number;
  truncated: boolean;
  files_changed?: number;
}

interface BlameJson {
  lines: Array<{
    line: number;
    sha: string;
    short_sha: string;
    author: string;
    authored_at: number;
    group: number;
    text: string;
  }>;
  total_lines: number;
  truncated: boolean;
  language?: string | null;
}

interface BlobJson {
  kind: "text" | "image" | "binary";
  mime: string;
  language: string | null;
  line_count: number;
  content: string | null;
  binary: boolean;
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
const username = `diff${run}`;
let token = "";
const work = join(scratch, "work");
let rootSha = "";
let secondSha = "";

const PNG_BYTES = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
  0x89, 0x00, 0x00, 0x00, 0x0a, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
  0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae,
  0x42, 0x60, 0x82,
]);

beforeAll(async () => {
  await user.request("/api/auth/signup", {
    method: "POST",
    body: { username, email: `${username}@example.com`, password: "supersecret123" },
  });
  const tokenResponse = await user.request<{ token: string }>("/api/tokens", {
    method: "POST",
    body: { name: "diff" },
  });
  token = tokenResponse.data.token;

  const remote = `${BASE.replace("http://", `http://${username}:${token}@`)}/${username}/diffs.git`;
  await user.request("/api/repos", { method: "POST", body: { name: "diffs" } });

  mkdirSync(join(work, "src"), { recursive: true });
  await git(["init", "-q", "-b", "main", work], { cwd: work });
  await git(["remote", "add", "origin", remote], { cwd: work });

  writeFileSync(join(work, "src", "app.ts"), "export const value = 1;\nexport const other = 2;\n");
  writeFileSync(join(work, "README.md"), "# initial\n");
  writeFileSync(join(work, "logo.png"), PNG_BYTES);
  await git(["add", "."], { cwd: work });
  await git([...identity, "commit", "-q", "-m", "initial commit"], { cwd: work });
  await git(["push", "-q", "origin", "main"], { cwd: work });
  rootSha = (await git(["rev-parse", "HEAD"], { cwd: work })).stdout.trim();

  const renameBody = Array.from({ length: 40 }, (_, i) => `export const original${i} = ${i};`).join("\n") + "\n";
  writeFileSync(join(work, "src", "original.ts"), renameBody);
  await git(["add", "."], { cwd: work });
  await git([...identity, "commit", "-q", "-m", "seed rename source"], { cwd: work });

  writeFileSync(join(work, "src", "app.ts"), "export const value = 10;\nexport const other = 2;\nexport const added = 3;\n");
  writeFileSync(join(work, "src", "new-file.ts"), "export const fresh = true;\n");
  await git(["mv", "src/original.ts", "src/renamed.ts"], { cwd: work });
  await git(["rm", "-q", "README.md"], { cwd: work });
  writeFileSync(join(work, "docs.md"), "# docs\n");
  await git(["add", "-A"], { cwd: work });
  await git([...identity, "commit", "-q", "-m", "second commit with mixed changes"], { cwd: work });
  await git(["push", "-q", "origin", "main"], { cwd: work });
  secondSha = (await git(["rev-parse", "HEAD"], { cwd: work })).stdout.trim();
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

describe("commit diff", () => {
  test("reports line numbers on both sides of a modified file", async () => {
    const response = await user.request<DiffJson>(
      `/api/repos/${username}/diffs/commits/${secondSha}/diff`,
    );
    expect(response.status).toBe(200);

    const app = response.data.files.find((file) => file.path === "src/app.ts");
    expect(app).toBeDefined();
    expect(app?.status).toBe("modified");
    expect(app?.additions).toBe(2);
    expect(app?.deletions).toBe(1);

    const lines = app?.hunks.flatMap((hunk) => hunk.lines) ?? [];
    const removed = lines.find((line) => line.kind === "del");
    const added = lines.find((line) => line.kind === "add");

    expect(removed?.old_line).toBe(1);
    expect(removed?.new_line).toBeNull();
    expect(added?.new_line).toBe(1);
    expect(added?.old_line).toBeNull();

    const context = lines.find((line) => line.kind === "context");
    expect(context?.old_line).not.toBeNull();
    expect(context?.new_line).not.toBeNull();
    expect(context?.text).toBe("export const other = 2;");
  });

  test("classifies added and deleted files", async () => {
    const response = await user.request<DiffJson>(
      `/api/repos/${username}/diffs/commits/${secondSha}/diff`,
    );
    const byPath = new Map(response.data.files.map((file) => [file.path, file]));
    expect(byPath.get("src/new-file.ts")?.status).toBe("added");
    expect(byPath.get("README.md")?.status).toBe("deleted");
    expect(byPath.get("docs.md")?.status).toBe("added");
  });

  test("detects a rename and reports the previous path", async () => {
    const response = await user.request<DiffJson>(
      `/api/repos/${username}/diffs/commits/${secondSha}/diff`,
    );
    const renamed = response.data.files.find((file) => file.path === "src/renamed.ts");
    expect(renamed).toBeDefined();
    expect(renamed?.status).toBe("renamed");
    expect(renamed?.old_path).toBe("src/original.ts");
    expect(renamed?.additions).toBe(0);
    expect(renamed?.deletions).toBe(0);
  });

  test("a root commit is a diff against nothing, not an error", async () => {
    const response = await user.request<DiffJson>(
      `/api/repos/${username}/diffs/commits/${rootSha}/diff`,
    );
    expect(response.status).toBe(200);
    const paths = response.data.files.map((file) => file.path);
    expect(paths).toContain("src/app.ts");
    expect(paths).toContain("README.md");
  });

  test("marks a binary file rather than emitting garbage lines", async () => {
    const response = await user.request<DiffJson>(
      `/api/repos/${username}/diffs/commits/${secondSha}/diff`,
    );
    const root = await user.request<DiffJson>(`/api/repos/${username}/diffs/commits/${rootSha}/diff`);
    const png = root.data.files.find((file) => file.path === "logo.png") ?? response.data.files.find((f) => f.path === "logo.png");
    expect(png).toBeDefined();
    expect(png?.binary).toBe(true);
    expect(png?.hunks).toHaveLength(0);
  });

  test("scopes a diff to a single path", async () => {
    const response = await user.request<DiffJson>(
      `/api/repos/${username}/diffs/commits/${secondSha}/diff?path=src/app.ts`,
    );
    expect(response.data.files).toHaveLength(1);
    expect(response.data.files[0]?.path).toBe("src/app.ts");
  });

  test("resolves the language for each changed file", async () => {
    const response = await user.request<DiffJson>(
      `/api/repos/${username}/diffs/commits/${secondSha}/diff`,
    );
    const app = response.data.files.find((file) => file.path === "src/app.ts");
    expect(app?.language).toBe("typescript");
    const docs = response.data.files.find((file) => file.path === "docs.md");
    expect(docs?.language).toBe("markdown");
  });

  test("an unknown revision is a 404", async () => {
    const response = await user.request(`/api/repos/${username}/diffs/commits/deadbeefdiff/diff`);
    expect(response.status).toBe(404);
  });
});

describe("range diff", () => {
  test("diffs between two revisions", async () => {
    const response = await user.request<DiffJson>(
      `/api/repos/${username}/diffs/diff?base=${rootSha}&head=${secondSha}`,
    );
    expect(response.status).toBe(200);
    expect(response.data.files.length).toBeGreaterThan(0);
    expect(response.data.additions).toBeGreaterThan(0);
  });

  test("requires a base revision", async () => {
    const response = await user.request<{ error: { code: string } }>(
      `/api/repos/${username}/diffs/diff?head=main`,
    );
    expect(response.status).toBe(400);
  });
});

describe("blame", () => {
  test("attributes every line of a file to a commit", async () => {
    const response = await user.request<BlameJson>(
      `/api/repos/${username}/diffs/blame?ref=main&path=src/app.ts`,
    );
    expect(response.status).toBe(200);
    expect(response.data.lines).toHaveLength(3);
    expect(response.data.lines[0]?.line).toBe(1);
    expect(response.data.lines[0]?.text).toBe("export const value = 10;");
    expect(response.data.lines[0]?.author).toBe("Diff");

    const shas = new Set(response.data.lines.map((line) => line.sha));
    expect(shas.has(secondSha)).toBe(true);
    expect(shas.has(rootSha)).toBe(true);
  });

  test("groups consecutive lines from the same commit", async () => {
    const response = await user.request<BlameJson>(
      `/api/repos/${username}/diffs/blame?ref=main&path=src/app.ts`,
    );
    const groups = response.data.lines.map((line) => line.group);
    for (let i = 1; i < groups.length; i++) {
      expect((groups[i] ?? 0) >= (groups[i - 1] ?? 0)).toBe(true);
    }
    const distinct = new Set(groups).size;
    expect(distinct).toBeLessThanOrEqual(response.data.lines.length);
  });

  test("reports the file's language for highlighting", async () => {
    const response = await user.request<BlameJson>(
      `/api/repos/${username}/diffs/blame?ref=main&path=src/app.ts`,
    );
    expect(response.data.language).toBe("typescript");
  });

  test("a missing path is a 404", async () => {
    const response = await user.request(`/api/repos/${username}/diffs/blame?ref=main&path=nope.ts`);
    expect(response.status).toBe(404);
  });

  test("requires a path", async () => {
    const response = await user.request(`/api/repos/${username}/diffs/blame?ref=main`);
    expect(response.status).toBe(400);
  });
});

describe("blob classification", () => {
  test("detects a PNG by magic bytes and reports it as an image", async () => {
    const response = await user.request<BlobJson>(
      `/api/repos/${username}/diffs/blob?ref=main&path=logo.png`,
    );
    expect(response.status).toBe(200);
    expect(response.data.kind).toBe("image");
    expect(response.data.mime).toBe("image/png");
    expect(response.data.content).toBeNull();
  });

  test("serves the image with its sniffed content type and inline disposition", async () => {
    const response = await fetch(`${BASE}/api/repos/${username}/diffs/raw?path=logo.png`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("content-disposition")).toContain("inline");
    const bytes = new Uint8Array(await response.arrayBuffer());
    expect(bytes[0]).toBe(0x89);
    expect(bytes[1]).toBe(0x50);
  });

  test("a download request switches to an attachment with a filename", async () => {
    const response = await fetch(`${BASE}/api/repos/${username}/diffs/raw?path=logo.png&download=1`);
    expect(response.headers.get("content-disposition")).toContain("attachment");
    expect(response.headers.get("content-disposition")).toContain("logo.png");
  });

  test("a PNG named .txt is still served as an image, because bytes win", async () => {
    writeFileSync(join(work, "mislabelled.txt"), PNG_BYTES);
    await git(["add", "."], { cwd: work });
    await git([...identity, "commit", "-q", "-m", "mislabelled image"], { cwd: work });
    await git(["push", "-q", "origin", "main"], { cwd: work });

    const response = await fetch(`${BASE}/api/repos/${username}/diffs/raw?path=mislabelled.txt`);
    expect(response.headers.get("content-type")).toBe("image/png");
  });

  test("reports language and line count for a text file", async () => {
    const response = await user.request<BlobJson>(
      `/api/repos/${username}/diffs/blob?ref=main&path=src/app.ts`,
    );
    expect(response.data.kind).toBe("text");
    expect(response.data.language).toBe("typescript");
    expect(response.data.line_count).toBe(3);
    expect(response.data.content).toContain("export const added = 3;");
  });

  test("an SVG is treated as an image", async () => {
    writeFileSync(join(work, "icon.svg"), '<svg xmlns="http://www.w3.org/2000/svg"><circle r="4"/></svg>');
    await git(["add", "."], { cwd: work });
    await git([...identity, "commit", "-q", "-m", "add svg"], { cwd: work });
    await git(["push", "-q", "origin", "main"], { cwd: work });

    const response = await user.request<BlobJson>(
      `/api/repos/${username}/diffs/blob?ref=main&path=icon.svg`,
    );
    expect(response.data.kind).toBe("image");
    expect(response.data.mime).toBe("image/svg+xml");
  });

  test("SVG served raw keeps a content type that cannot execute script in an image context", async () => {
    const response = await fetch(`${BASE}/api/repos/${username}/diffs/raw?path=icon.svg`);
    expect(response.headers.get("content-type")).toBe("image/svg+xml");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  });
});

describe("regression: file content is never executed", () => {
  test("a blob containing HTML is returned as JSON, not as markup", async () => {
    const html = '<script>alert("xss")</script>';
    writeFileSync(join(work, "evil.html"), html);
    await git(["add", "."], { cwd: work });
    await git([...identity, "commit", "-q", "-m", "add html"], { cwd: work });
    await git(["push", "-q", "origin", "main"], { cwd: work });

    const response = await fetch(`${BASE}/api/repos/${username}/diffs/blob?ref=main&path=evil.html`);
    expect(response.headers.get("content-type")).toContain("application/json");
    const body = (await response.json()) as BlobJson;
    expect(body.content).toBe(html);
  });

  test("the raw endpoint marks HTML content as download-only-safe via nosniff", async () => {
    const response = await fetch(`${BASE}/api/repos/${username}/diffs/raw?path=evil.html`);
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(readFileSync(join(work, "evil.html"), "utf8")).toContain("script");
  });
});

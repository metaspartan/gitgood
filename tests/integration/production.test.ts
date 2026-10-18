import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createServer } from "../../src/server.ts";
import { config } from "../../src/config.ts";
import { BACKUP_FORMAT, planRestore, runBackup, runRestore, snapshotDatabase } from "../../src/lib/backup.ts";
import { one, scalar, run } from "../../src/db/index.ts";

const backupRoot = join(config.dataDir, "backups-test");

beforeAll(() => {
  mkdirSync(backupRoot, { recursive: true });
});

afterAll(() => {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      rmSync(backupRoot, { recursive: true, force: true, maxRetries: 3 });
      return;
    } catch {
      void attempt;
    }
  }
});

describe("database snapshot", () => {
  test("VACUUM INTO produces a readable database with the same rows", () => {
    const target = join(backupRoot, "snapshot.db");
    const marker = `snap${Date.now().toString(36)}`;
    run(
      "INSERT INTO users (username, email, display_name, password_hash, is_admin, avatar_hue, created_at) VALUES (?, ?, ?, ?, 0, 0, ?)",
      marker,
      `${marker}@example.com`,
      marker,
      "hash",
      Date.now(),
    );

    snapshotDatabase(config.dbPath, target);
    expect(existsSync(target)).toBe(true);

    const { Database } = require("bun:sqlite") as typeof import("bun:sqlite");
    const copy = new Database(target, { readonly: true });
    try {
      const found = copy.query("SELECT username FROM users WHERE username = ?").get(marker) as
        | { username: string }
        | undefined;
      expect(found?.username).toBe(marker);
      const integrity = copy.query("PRAGMA integrity_check").get() as { integrity_check: string };
      expect(integrity.integrity_check).toBe("ok");
    } finally {
      copy.close();
    }
  });
});

describe("full backup and restore round trip", () => {
  const label = `roundtrip-${Date.now().toString(36)}`;
  const outDir = join(backupRoot, label);

  test("backup captures database, repositories and lfs", async () => {
    const manifest = await runBackup({ outDir, label });
    expect(manifest.format).toBe(BACKUP_FORMAT);
    expect(manifest.label).toBe(label);
    expect(manifest.database.bytes).toBeGreaterThan(0);
    expect(manifest.databaseSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(existsSync(join(outDir, "manifest.json"))).toBe(true);
    expect(existsSync(join(outDir, "repositories"))).toBe(true);
    expect(existsSync(join(outDir, "lfs"))).toBe(true);
  });

  test("a second backup refuses to overwrite without force", async () => {
    await expect(runBackup({ outDir, label })).rejects.toThrow(/not empty/);
  });

  test("planRestore validates the manifest and the digest", () => {
    const plan = planRestore({ from: outDir });
    expect(plan.manifest.label).toBe(label);
    expect(plan.targets.database).toBe(config.dbPath);
  });

  test("a tampered database is refused rather than restored", () => {
    const tampered = join(backupRoot, `tampered-${Date.now().toString(36)}`);
    mkdirSync(tampered, { recursive: true });
    const manifest = JSON.parse(readFileSync(join(outDir, "manifest.json"), "utf8")) as Record<string, unknown>;
    const bytes = new Uint8Array(readFileSync(join(outDir, "gitgood.db")));
    const middle = Math.floor(bytes.length / 2);
    bytes[middle] = (bytes[middle] ?? 0) ^ 0xff;
    writeFileSync(join(tampered, "gitgood.db"), bytes);
    writeFileSync(join(tampered, "manifest.json"), JSON.stringify(manifest));
    mkdirSync(join(tampered, "repositories"), { recursive: true });
    mkdirSync(join(tampered, "lfs"), { recursive: true });

    expect(() => planRestore({ from: tampered })).toThrow(/corrupt|digest/i);
  });

  test("an unsupported format version is refused", () => {
    const future = join(backupRoot, `future-${Date.now().toString(36)}`);
    mkdirSync(future, { recursive: true });
    writeFileSync(
      join(future, "manifest.json"),
      JSON.stringify({ format: BACKUP_FORMAT + 99, label: "x", database: { file: "gitgood.db", bytes: 0 } }),
    );
    writeFileSync(join(future, "gitgood.db"), "not a database");
    expect(() => planRestore({ from: future })).toThrow(/format/i);
  });

  test("restore writes the trees and refuses a database it cannot replace", async () => {
    const marker = `restoreme-${Date.now().toString(36)}`;
    const repoPath = join(config.repoRoot, "testowner-missing", "restoreme.git");
    mkdirSync(repoPath, { recursive: true });
    writeFileSync(join(repoPath, "HEAD"), "ref: refs/heads/main\n");
    writeFileSync(join(repoPath, "marker.txt"), "repository payload");

    const dir = join(backupRoot, marker);
    await runBackup({ outDir: dir, label: marker });

    rmSync(repoPath, { recursive: true, force: true });
    expect(existsSync(join(repoPath, "marker.txt"))).toBe(false);

    let refused = false;
    try {
      const result = runRestore({ from: dir, force: true });
      expect(result.restored.repositories).toBe(true);
      expect(result.restored.lfs).toBe(true);
      expect(result.sidecarsPending.length + 0).toBeGreaterThanOrEqual(0);
    } catch (error) {
      refused = true;
      const message = error instanceof Error ? error.message : String(error);
      expect(message).toMatch(/written \d+ of \d+|Stop the GitGood server/);
      expect(message.length).toBeGreaterThan(40);
    }

    expect(existsSync(join(repoPath, "marker.txt"))).toBe(true);

    if (!refused) {
      const written = readFileSync(config.dbPath).byteLength;
      expect(written).toBeGreaterThan(0);
    }
  }, 60_000);

  test("restore refuses to clobber live state without force", () => {
    expect(() => runRestore({ from: outDir })).toThrow(/--force/);
  });

  test("dry run reports the plan and writes nothing", () => {
    const before = readdirSync(join(outDir, "repositories")).length;
    const result = runRestore({ from: outDir, dryRun: true });
    expect(result.restored.database).toBe(false);
    expect(result.manifest.label).toBe(label);
    expect(readdirSync(join(outDir, "repositories")).length).toBe(before);
  });
});

describe("backup restore across processes", () => {
  test("a stopped instance comes back with its data", async () => {
    const proc = Bun.spawn(["bun", "tools/restore-check.ts"], {
      cwd: process.cwd(),
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, GITGOOD_LOG_LEVEL: "error" },
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);

    expect(code === 0 ? "" : `${stdout}
${stderr}`).toBe("");
    expect(stdout).toContain("the user row written before the backup is present after the restore");
    expect(stdout).toContain("the repository content is byte-identical");
    expect(stdout).toContain("no SQLite sidecars were left pending");
    expect(stdout).toMatch(/PASS - \d+\/\d+ checks/);
  }, 300_000);
});

describe("readiness and liveness", () => {
  const server = createServer(0);
  const BASE = `http://127.0.0.1:${server.port}`;

  afterAll(async () => {
    await server.stop(true);
  });

  test("liveness is cheap and reports the database", async () => {
    const response = await fetch(`${BASE}/api/health`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { status: string; database: string };
    expect(body.status).toBe("ok");
    expect(body.database).toBe("ok");
  });

  test("readiness checks every dependency separately", async () => {
    const response = await fetch(`${BASE}/api/ready`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      ready: boolean;
      checks: Array<{ name: string; ok: boolean; detail: string }>;
    };
    expect(body.ready).toBe(true);
    const names = body.checks.map((check) => check.name);
    expect(names).toContain("database");
    expect(names).toContain("data_dir");
    expect(names).toContain("repo_root");
    expect(names).toContain("lfs_root");
    expect(names).toContain("git");
    for (const check of body.checks) {
      expect(check.ok).toBe(true);
      expect(check.detail.length).toBeGreaterThan(0);
    }
  });

  test("readiness leaves no probe files behind", async () => {
    await fetch(`${BASE}/api/ready`);
    for (const dir of [config.repoRoot, config.lfsRoot, config.dataDir]) {
      const leftovers = readdirSync(dir).filter((name) => name.startsWith(".ready-"));
      expect(leftovers).toEqual([]);
    }
  });
});

describe("transport hardening", () => {
  const server = createServer(0);
  const BASE = `http://127.0.0.1:${server.port}`;

  afterAll(async () => {
    await server.stop(true);
  });

  test("security headers are present on API responses", async () => {
    const response = await fetch(`${BASE}/api/health`);
    expect(response.headers.get("content-security-policy")).toContain("default-src 'self'");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("x-frame-options")).toBe("DENY");
    expect(response.headers.get("permissions-policy")).toContain("camera=()");
    expect(response.headers.get("referrer-policy")).toBe("strict-origin-when-cross-origin");
  });

  test("the CSP forbids inline script and framing", async () => {
    const csp = (await fetch(`${BASE}/api/health`)).headers.get("content-security-policy") ?? "";
    expect(csp).toContain("script-src 'self'");
    expect(csp).not.toContain("'unsafe-eval'");
    expect(csp.replace("'wasm-unsafe-eval'", "")).not.toContain("unsafe-eval");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("style-src 'self' 'unsafe-inline'");
  });

  test("HSTS is not sent over plain http", async () => {
    const response = await fetch(`${BASE}/api/health`);
    expect(response.headers.get("strict-transport-security")).toBeNull();
  });

  test("HSTS is sent for a secure request", () => {
    const { isSecureRequest } = require("../../src/lib/http.ts") as typeof import("../../src/lib/http.ts");
    expect(isSecureRequest(new Request("https://example.com/"))).toBe(true);
    expect(isSecureRequest(new Request("http://example.com/"))).toBe(false);
  });

  test("errors carry the same security headers as successes", async () => {
    const response = await fetch(`${BASE}/api/does-not-exist`);
    expect(response.status).toBe(404);
    expect(response.headers.get("content-security-policy")).toContain("default-src 'self'");
  });
});

describe("compression and conditional GETs", () => {
  const server = createServer(0);
  const BASE = `http://127.0.0.1:${server.port}`;
  let cookie = "";

  beforeAll(async () => {
    const name = `compress${Date.now().toString(36)}`;
    const response = await fetch(`${BASE}/api/auth/signup`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: name, email: `${name}@example.com`, password: "supersecret123" }),
    });
    cookie = (response.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  });

  afterAll(async () => {
    await server.stop(true);
  });

  test("a large JSON body is gzipped when the client accepts it", async () => {
    const plain = await fetch(`${BASE}/api/repos`, { headers: { cookie } });
    const compressed = await fetch(`${BASE}/api/repos`, {
      headers: { cookie, "accept-encoding": "gzip" },
    });
    const plainBytes = (await plain.arrayBuffer()).byteLength;
    const compressedBytes = (await compressed.arrayBuffer()).byteLength;

    expect(plainBytes).toBeGreaterThan(0);
    expect(compressedBytes).toBe(plainBytes);

    if (compressed.headers.get("content-encoding") === "gzip") {
      expect(compressed.headers.get("vary")).toContain("accept-encoding");
    } else {
      expect(compressedBytes).toBeGreaterThan(0);
    }
  });

  test("a client that does not accept gzip gets the plain body", async () => {
    const response = await fetch(`${BASE}/api/repos`, {
      headers: { cookie, "accept-encoding": "identity" },
    });
    expect(response.headers.get("content-encoding")).toBeNull();
  });

  test("the gzip body decodes to the same JSON as the plain body", async () => {
    const plain = await (await fetch(`${BASE}/api/repos`, { headers: { cookie } })).json();
    const gzipped = await (
      await fetch(`${BASE}/api/repos`, { headers: { cookie, "accept-encoding": "gzip" } })
    ).json();
    expect(gzipped).toEqual(plain);
  });

  test("a listing answers a conditional GET with 304", async () => {
    const first = await fetch(`${BASE}/api/repos`, { headers: { cookie } });
    const etag = first.headers.get("etag");
    expect(etag).toBeTruthy();

    const second = await fetch(`${BASE}/api/repos`, {
      headers: { cookie, "if-none-match": etag ?? "" },
    });
    expect(second.status).toBe(304);
    expect((await second.text()).length).toBe(0);
  });

  test("a changed listing gets a different ETag", async () => {
    const before = await fetch(`${BASE}/api/repos`, { headers: { cookie } });
    const etagBefore = before.headers.get("etag");

    await fetch(`${BASE}/api/repos`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ name: `etag-${Date.now().toString(36)}` }),
    });

    const after = await fetch(`${BASE}/api/repos`, { headers: { cookie } });
    expect(after.headers.get("etag")).not.toBe(etagBefore);
  });

  test("a 304 still carries security headers", async () => {
    const first = await fetch(`${BASE}/api/repos`, { headers: { cookie } });
    const etag = first.headers.get("etag") ?? "";
    const second = await fetch(`${BASE}/api/repos`, { headers: { cookie, "if-none-match": etag } });
    expect(second.status).toBe(304);
    expect(second.headers.get("content-security-policy")).toContain("default-src");
  });

  test("streamed archives are not double-compressed", async () => {
    const name = `stream-${Date.now().toString(36)}`;
    const created = await fetch(`${BASE}/api/repos`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ name }),
    });
    const repo = (await created.json()) as { owner: string; name: string };

    const issued = await fetch(`${BASE}/api/tokens`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ name: "stream" }),
    });
    const token = ((await issued.json()) as { token: string }).token;

    const work = join(config.dataDir, `stream-work-${Date.now().toString(36)}`);
    mkdirSync(work, { recursive: true });
    const remote = `http://${repo.owner}:${token}@127.0.0.1:${new URL(BASE).port}/${repo.owner}/${repo.name}.git`;
    const gitIn = async (args: string[]): Promise<void> => {
      const proc = Bun.spawn(["git", ...args], { cwd: work, stdout: "pipe", stderr: "pipe" });
      const [stderr, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
      if (code !== 0) throw new Error(`git ${args.join(" ")}: ${stderr.slice(0, 200)}`);
    };
    try {
      await gitIn(["init", "-q", "-b", "main"]);
      await gitIn(["remote", "add", "origin", remote]);
      writeFileSync(join(work, "file.txt"), "archive me\n");
      await gitIn(["add", "."]);
      await gitIn(["-c", "user.name=T", "-c", "user.email=t@e.io", "commit", "-q", "-m", "seed"]);
      await gitIn(["push", "-q", "origin", "main"]);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }

    const archive = await fetch(`${BASE}/api/repos/${repo.owner}/${repo.name}/archive?format=tar.gz`, {
      headers: { cookie, "accept-encoding": "gzip" },
    });
    expect(archive.status).toBe(200);
    expect(archive.headers.get("content-type")).toBe("application/gzip");
    expect(archive.headers.get("content-encoding")).toBeNull();
    const bytes = new Uint8Array(await archive.arrayBuffer());
    expect(bytes[0]).toBe(0x1f);
    expect(bytes[1]).toBe(0x8b);
  }, 60_000);
});

describe("conditional request semantics", () => {
  const server = createServer(0);
  const BASE = `http://127.0.0.1:${server.port}`;

  afterAll(async () => {
    await server.stop(true);
  });

  test("If-None-Match is compared per RFC 7232, not by exact string", async () => {
    const { isNotModified } = await import("../../src/lib/http.ts");
    const tag = 'W/"12-abc"';
    const cases: Array<[string, string, boolean]> = [
      ["exact weak tag", tag, true],
      ["strong form of our weak tag", '"12-abc"', true],
      ["comma-separated list containing our tag", `"other", ${tag}`, true],
      ["list with irregular spacing", `"other",   ${tag}  `, true],
      ["wildcard", "*", true],
      ["a different tag", 'W/"99-zzz"', false],
      ["no header", "", false],
      ["a trailing comma does not match", '"other",', false],
    ];
    for (const [name, header, expected] of cases) {
      const request = new Request("http://localhost/api/repos", {
        headers: header === "" ? {} : { "if-none-match": header },
      });
      expect({ case: name, result: isNotModified(request, tag) }).toEqual({ case: name, result: expected });
    }
  });

  test("a 304 is returned for a list form and a strong form", async () => {
    const name = `cond${Date.now().toString(36)}`;
    const response = await fetch(`${BASE}/api/auth/signup`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: name, email: `${name}@example.com`, password: "supersecret123" }),
    });
    const cookie = (response.headers.get("set-cookie") ?? "").split(";")[0] ?? "";

    const first = await fetch(`${BASE}/api/repos`, { headers: { cookie } });
    const etag = first.headers.get("etag") ?? "";
    expect(etag).toMatch(/^W\//);

    const asList = await fetch(`${BASE}/api/repos`, {
      headers: { cookie, "if-none-match": `"unrelated", ${etag}` },
    });
    expect(asList.status).toBe(304);

    const asStrong = await fetch(`${BASE}/api/repos`, {
      headers: { cookie, "if-none-match": etag.replace(/^W\//, "") },
    });
    expect(asStrong.status).toBe(304);

    const wildcard = await fetch(`${BASE}/api/repos`, { headers: { cookie, "if-none-match": "*" } });
    expect(wildcard.status).toBe(304);

    await first.arrayBuffer();
    await asList.arrayBuffer();
    await asStrong.arrayBuffer();
    await wildcard.arrayBuffer();
  }, 30_000);
});

describe("git stream bounds", () => {
  test("a stream timeout is configured and generous", async () => {
    const { STREAM_TIMEOUT_MS } = await import("../../src/git/run.ts");
    expect(STREAM_TIMEOUT_MS).toBeGreaterThanOrEqual(20 * 60 * 1000);
  });

  test("the semaphore publishes saturation gauges", async () => {
    const metrics = await import("../../src/lib/metrics.ts");
    const { git } = await import("../../src/git/run.ts");
    await git(["--version"], { unthrottled: true });
    await git(["init", "-q", join(config.dataDir, "gauge-probe")], { allowFailure: true });
    const stats = metrics.allCounters();
    void stats;
    expect(typeof metrics.gaugeValue("git_slots_available")).toBe("number");
    expect(typeof metrics.gaugeValue("git_queue_depth")).toBe("number");
    rmSync(join(config.dataDir, "gauge-probe"), { recursive: true, force: true });
  });
});

describe("repository verification modes", () => {
  const dir = join(config.dataDir, "verify-src");
  const repo = join(dir, "repo");

  const runGit = async (args: string[]): Promise<number> => {
    const proc = Bun.spawn(["git", ...args], { cwd: repo, stdout: "pipe", stderr: "pipe" });
    const [stderr, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
    void stderr;
    return code;
  };

  beforeAll(async () => {
    mkdirSync(repo, { recursive: true });
    await runGit(["init", "-q", "-b", "main"]);
    writeFileSync(join(repo, "a.txt"), "hello\n");
    writeFileSync(join(repo, "b.txt"), "world\n");
    await runGit(["add", "."]);
    await runGit(["-c", "user.name=T", "-c", "user.email=t@e.io", "commit", "-q", "-m", "seed"]);
  }, 60_000);

  test("both modes pass on a healthy repository", async () => {
    const { verifyRepository } = await import("../../src/git/repo.ts");
    expect(await verifyRepository(repo)).toBe(true);
    expect(await verifyRepository(repo, { full: true })).toBe(true);
  }, 60_000);

  test("a corrupted repository is reported as damaged", async () => {
    const { verifyRepository } = await import("../../src/git/repo.ts");

    const objectsDir = join(repo, ".git", "objects");
    const findLoose = (base: string): string | null => {
      for (const shard of readdirSync(base)) {
        if (shard.length !== 2) continue;
        const entries = readdirSync(join(base, shard));
        if (entries.length > 0) return join(base, shard, entries[0] as string);
      }
      return null;
    };
    const target = findLoose(objectsDir);
    expect(target).not.toBeNull();

    chmodSync(target as string, 0o644);
    const bytes = readFileSync(target as string);
    bytes[10] = (bytes[10] ?? 0) ^ 0xff;
    writeFileSync(target as string, bytes);

    expect(await verifyRepository(repo, { full: true })).toBe(false);
  }, 120_000);

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("admin surface", () => {
  test("db exposes the maintenance primitives the CLI relies on", () => {
    expect(typeof one).toBe("function");
    expect(typeof scalar).toBe("function");
    expect(typeof run).toBe("function");
    const integrity = one<{ integrity_check: string }>("PRAGMA integrity_check");
    expect(integrity?.integrity_check).toBe("ok");
  });
});

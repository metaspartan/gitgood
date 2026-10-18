import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerStorageRoutes } from "../../src/api/routes/storage.ts";
import { Router, type RouteContext } from "../../src/api/router.ts";
import { createStorageScanner, type StorageOverview } from "../../src/lib/storage-overview.ts";
import { scanStorage, STORAGE_SCAN_LIMITS, type StorageRoots } from "../../src/lib/storage-scan.ts";
import { collectStorage, type StorageWorkerResult } from "../../src/lib/storage-worker.ts";

function fixture(): { roots: StorageRoots; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "storage-overview-"));
  const roots: StorageRoots = {
    repoRoot: join(root, "repositories"),
    lfsRoot: join(root, "lfs"),
    releasesRoot: join(root, "releases"),
    dbPath: join(root, "gitgood.db"),
  };
  mkdirSync(join(roots.repoRoot, "ab", "cd"), { recursive: true });
  mkdirSync(join(roots.lfsRoot, "objects", "aa"), { recursive: true });
  mkdirSync(join(roots.releasesRoot, "7"), { recursive: true });
  writeFileSync(join(roots.repoRoot, "ab", "cd", "pack"), "repo-bytes");
  writeFileSync(join(roots.lfsRoot, "objects", "aa", "object"), "lfs-bytes!!");
  writeFileSync(join(roots.releasesRoot, "7", "9"), "asset");
  writeFileSync(roots.dbPath, "db");
  writeFileSync(`${roots.dbPath}-wal`, "wal!");
  writeFileSync(`${roots.dbPath}-shm`, "sh");
  writeFileSync(join(root, "outside"), "not-counted-at-all");
  symlinkSync(join(root, "outside"), join(roots.repoRoot, "escape"));
  symlinkSync(join(roots.lfsRoot, "objects", "aa", "object"), join(roots.lfsRoot, "alias"));
  return { roots, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function sample(bytes: number, sampledAt: number): StorageWorkerResult {
  const category = { bytes, files: 1 };
  return {
    sampledAt,
    scan: {
      repositories: category,
      lfs: { bytes: 0, files: 0 },
      releaseAssets: { bytes: 0, files: 0 },
      database: { bytes: 0, files: 0 },
      trackedBytes: bytes,
      trackedFiles: 1,
      truncated: false,
    },
    filesystems: [{ id: "fs", totalBytes: 100, availableBytes: 40, additive: true }],
    quota: null,
    ready: null,
  };
}

const admin = { kind: "user", userId: 1, username: "admin", isAdmin: true, scopes: ["admin"], via: "session" } as const;

describe("storage overview", () => {
  test("counts logical files inside configured roots and skips symlink targets", () => {
    const { roots, cleanup } = fixture();
    try {
      const report = scanStorage(roots);
      expect(report.repositories).toEqual({ bytes: "repo-bytes".length, files: 1 });
      expect(report.lfs).toEqual({ bytes: "lfs-bytes!!".length, files: 1 });
      expect(report.releaseAssets).toEqual({ bytes: "asset".length, files: 1 });
      expect(report.database).toEqual({ bytes: "db".length + "wal!".length + "sh".length, files: 3 });
      expect(report.trackedFiles).toBe(6);
      expect(report.trackedBytes).toBe(report.repositories.bytes + report.lfs.bytes + report.releaseAssets.bytes + report.database.bytes);
      expect(report.truncated).toBe(false);
    } finally {
      cleanup();
    }
  });

  test("keeps one scan in flight, serves cache, and preserves the last good sample after failure", async () => {
    let now = 1_000;
    let calls = 0;
    let gate: (value: StorageWorkerResult | Error) => void = () => {};
    const scanner = createStorageScanner({
      now: () => now,
      cacheMs: 5 * 60 * 1000,
      spawn: () => new Promise((resolve, reject) => {
        calls += 1;
        gate = (value) => value instanceof Error ? reject(value) : resolve(value);
      }),
    });
    const first = scanner.snapshot();
    const second = scanner.snapshot();
    expect(first.status).toBe("scanning");
    expect(second.status).toBe("scanning");
    expect(calls).toBe(1);
    gate(sample(10, now));
    await Bun.sleep(0);
    const cached = scanner.snapshot();
    expect(cached.trackedBytes).toBe(10);
    expect(cached.status).toBe("current");
    expect(calls).toBe(1);
    now += 5 * 60 * 1000 + 1;
    const refreshing = scanner.snapshot();
    expect(refreshing.trackedBytes).toBe(10);
    expect(refreshing.scanning).toBe(true);
    expect(calls).toBe(2);
    gate(new Error("scan failed"));
    await Bun.sleep(0);
    const preserved = scanner.snapshot();
    expect(preserved.trackedBytes).toBe(10);
    expect(preserved.status).toBe("stale");
    expect(preserved.error).toContain("Storage scan failed");
    expect(calls).toBe(2);
  });

  test("admin storage is session-only and does not expose paths or credentials", async () => {
    const router = new Router();
    registerStorageRoutes(router);
    const route = router.match("GET", "/api/admin/storage");
    expect(route).not.toBeNull();
    const rejected = async (request: Request, auth: RouteContext["auth"]): Promise<unknown> => {
      try {
        await route!.handler({ request, url: new URL(request.url), params: {}, auth, ip: "127.0.0.1" });
        return null;
      } catch (error) {
        return error;
      }
    };
    expect(await rejected(new Request("http://localhost/api/admin/storage"), { kind: "anonymous" })).toMatchObject({ status: 401 });
    expect(await rejected(new Request("http://localhost/api/admin/storage"), { kind: "user", userId: 2, username: "ada", isAdmin: false, scopes: ["read"], via: "session" })).toMatchObject({ status: 403 });
    expect(await rejected(new Request("http://localhost/api/admin/storage"), { kind: "user", userId: 1, username: "admin", isAdmin: true, scopes: ["admin"], via: "token" })).toMatchObject({ status: 403, message: "Use an administrator browser session" });
    expect(await rejected(new Request("http://localhost/api/admin/storage", { headers: { authorization: "Bearer secret" } }), admin)).toMatchObject({ status: 403, message: "Use an administrator browser session" });
    const allowed = await route!.handler({ request: new Request("http://localhost/api/admin/storage"), url: new URL("http://localhost/api/admin/storage"), params: {}, auth: admin, ip: "127.0.0.1" });
    const body = await allowed.json() as StorageOverview;
    expect(body.quota).toBeNull();
    expect(body.readiness).toBeNull();
    expect(JSON.stringify(body)).not.toContain("dbPath");
    expect(JSON.stringify(body)).not.toContain("password");
    expect(body.labels.quota).toContain("No storage quota");
  });
});


test("file cap marks only the smallest over-boundary case incomplete", () => {
  for (const count of [2, 3, 4]) {
    const root = mkdtempSync(join(tmpdir(), "storage-boundary-"));
    try {
      const repoRoot = join(root, "repos"); mkdirSync(repoRoot);
      for (let i = 0; i < count; i++) writeFileSync(join(repoRoot, String(i)), "x");
      const report = scanStorage({ repoRoot, lfsRoot: join(root, "absent-lfs"), releasesRoot: join(root, "absent-assets"), dbPath: join(root, "absent-db") }, { ...STORAGE_SCAN_LIMITS, maxFiles: 3 });
      expect(report.repositories.files).toBe(Math.min(count, 3));
      expect(report.repositories.bytes).toBe(Math.min(count, 3));
      expect(report.truncated).toBe(count > 3);
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
});

test("a configured root symlink is never traversed", () => {
  const root = mkdtempSync(join(tmpdir(), "storage-root-link-"));
  try {
    const outside = join(root, "outside"); mkdirSync(outside); writeFileSync(join(outside, "secret"), "secret");
    const alias = join(root, "alias"); symlinkSync(outside, alias, "junction");
    const report = scanStorage({ repoRoot: alias, lfsRoot: join(root, "none"), releasesRoot: join(root, "none2"), dbPath: join(root, "none3") });
    expect(report.trackedBytes).toBe(0); expect(report.truncated).toBe(true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});


test("missing asset directories sample their existing parent filesystem without fake zero disks", () => {
  const root = mkdtempSync(join(tmpdir(), "storage-capacity-"));
  try {
    const result = collectStorage({ repoRoot: join(root, "repos"), lfsRoot: join(root, "lfs"), releasesRoot: join(root, "releases"), dbPath: join(root, "db") });
    expect(result.filesystems).toHaveLength(1);
    expect(result.filesystems[0]!.totalBytes).toBeGreaterThan(0);
    expect(result.filesystems[0]!.availableBytes).toBeGreaterThan(0);
    expect(result.filesystems[0]!.additive).toBe(true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

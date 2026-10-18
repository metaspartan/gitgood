import { migrate } from "../../src/db/index.ts";
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseBackupDestinations } from "../../src/lib/backup-destinations.ts";
import { registerBackupRoutes } from "../../src/api/routes/backups.ts";
import { Router, type RouteContext } from "../../src/api/router.ts";

const destination = { id: "disk", name: "Recovery disk", kind: "local", target: resolve("backups") };

describe("backup administration", () => {
  migrate();
  test("accepts configured local, NAS and Drive destinations, not arbitrary targets", () => {
    expect(parseBackupDestinations(undefined)).toEqual([]);
    expect(parseBackupDestinations(JSON.stringify([destination]))[0]?.id).toBe("disk");
    expect(parseBackupDestinations(JSON.stringify([{ ...destination, kind: "nas" }]))).toHaveLength(1);
    expect(parseBackupDestinations(JSON.stringify([{ ...destination, kind: "google-drive", target: "drive:GitGood" }]))).toHaveLength(1);
    for (const value of [{ ...destination, target: "relative" }, { ...destination, kind: "ftp" }, { ...destination, kind: "google-drive", target: ":http:url" }, { ...destination, kind: "google-drive", target: "drive:../x" }])
      expect(() => parseBackupDestinations(JSON.stringify([value]))).toThrow();
    expect(() => parseBackupDestinations(JSON.stringify([destination, destination]))).toThrow();
    expect(parseBackupDestinations(JSON.stringify(Array.from({ length: 12 }, (_, i) => ({ ...destination, id: `disk-${i}` }))))).toHaveLength(12);
    expect(() => parseBackupDestinations(JSON.stringify(Array.from({ length: 13 }, (_, i) => ({ ...destination, id: `disk-${i}` }))))).toThrow();
  });
  test("read and write routes reject anonymous, non-admin and token callers", async () => {
    const router = new Router();
    registerBackupRoutes(router);
    for (const method of ["GET", "POST"]) {
      for (const auth of [{ kind: "anonymous" }, { kind: "user", userId: 1, username: "test", isAdmin: false, scopes: ["read", "write"], via: "session" }, { kind: "user", userId: 1, username: "test", isAdmin: true, scopes: ["read", "write", "admin"], via: "token" }]) {
        const request = new Request("http://localhost/api/admin/backups", { method });
        await expect(Promise.resolve().then(() => router.match(method, "/api/admin/backups")!.handler({ request, url: new URL(request.url), params: {}, auth } as RouteContext))).rejects.toThrow();
      }
    }
  });
  test("runner administration rejects non-admin sessions and tokens", async () => {
    const router = new Router(); registerBackupRoutes(router);
    const request = new Request("http://localhost/api/admin/runner");
    for (const auth of [{ kind: "anonymous" }, { kind: "user", userId: 1, username: "user", isAdmin: false, scopes: ["write"], via: "session" }, { kind: "user", userId: 1, username: "admin", isAdmin: true, scopes: ["admin"], via: "token" }]) {
      await expect(Promise.resolve().then(() => router.match("GET", "/api/admin/runner")!.handler({ request, url: new URL(request.url), params: {}, ip: "127.0.0.1", auth } as RouteContext))).rejects.toThrow();
    }
    const response = await router.match("GET", "/api/admin/runner")!.handler({ request, url: new URL(request.url), params: {}, ip: "127.0.0.1", auth: { kind: "user", userId: 1, username: "admin", isAdmin: true, scopes: ["admin"], via: "session" } });
    const result = await response.json(); expect(result.maxConcurrent).toBe(2); expect(result.maxPending).toBe(20); expect(result.runner.isolation).toBe("none");
  });
  test("admin overview reports effective limits without exposing paths or credentials", async () => {
    const router = new Router(); registerBackupRoutes(router);
    const request = new Request("http://localhost/api/admin/backups");
    const response = await router.match("GET", "/api/admin/backups")!.handler({ request, url: new URL(request.url), params: {}, ip: "127.0.0.1", auth: { kind: "user", userId: 1, username: "admin", isAdmin: true, scopes: ["admin"], via: "session" } });
    const body = await response.json();
    expect(body.configuration.gitConcurrency).toBeGreaterThan(0);
    expect(body.configuration.maxLfsBytes).toBeGreaterThan(0);
    expect(body.configuration).not.toHaveProperty("dbPath");
    expect(body.configuration).not.toHaveProperty("password");
    for (const destination of body.destinations) expect(destination).not.toHaveProperty("target");
  });
  test("local worker copies database, git, LFS and release assets without overwriting", async () => {
    const root = mkdtempSync(join(tmpdir(), "backup-worker-"));
    try {
      const data = join(root, "data");
      for (const dir of ["repositories", "lfs", "releases"]) {
        mkdirSync(join(data, dir), { recursive: true });
        writeFileSync(join(data, dir, "fixture"), `bytes:${dir}`);
      }
      const db = new Database(join(data, "gitgood.db"));
      db.run("CREATE TABLE example (id INTEGER)"); db.run("INSERT INTO example VALUES (42)"); db.close();
      const out = join(root, "backups");
      const id = `backup-${crypto.randomUUID()}`;
      const env = { ...process.env, GITGOOD_DATA_DIR: data, GITGOOD_DB_PATH: join(data, "gitgood.db"), GITGOOD_REPO_ROOT: join(data, "repositories"), GITGOOD_LFS_ROOT: join(data, "lfs"), GITGOOD_BACKUP_DESTINATIONS: JSON.stringify([{ ...destination, target: out }]) };
      const run = () => Bun.spawn([process.execPath, "tools/backup-job.ts", "disk", id], { cwd: resolve("."), env, stdout: "ignore", stderr: "pipe" });
      const proc = run();
      const error = await new Response(proc.stderr).text();
      expect({ exit: await proc.exited, error }).toEqual({ exit: 0, error: "" });
      expect(JSON.parse(readFileSync(join(out, id, "manifest.json"), "utf8")).releaseAssetsIncluded).toBe(true);
      expect(readFileSync(join(out, id, "releases", "fixture"), "utf8")).toBe("bytes:releases");
      const second = run(); await new Response(second.stderr).text(); expect(await second.exited).not.toBe(0);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

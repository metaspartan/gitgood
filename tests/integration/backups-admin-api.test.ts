import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "../../src/server.ts";
import { changes } from "../../src/db/index.ts";
import { config } from "../../src/config.ts";
import { isDue, latestSlot, nextSlot } from "../../src/data/backups.ts";
import { parseWorkerError } from "../../src/data/backup-jobs.ts";

const server = createServer(0);
const BASE = `http://127.0.0.1:${server.port}`;
const stamp = Date.now().toString(36);
const admin = `ba${stamp}`;
const member = `bm${stamp}`;
const PASSWORD = "backups-admin-password";
const target = mkdtempSync(join(tmpdir(), "gg-backups-"));
let previousEnv: string | undefined;

class Client {
  cookie = "";
  constructor(private readonly bearer?: string) {}
  async call<T = any>(path: string, method = "GET", body?: unknown): Promise<{ status: number; data: T }> {
    const response = await fetch(BASE + path, {
      method,
      headers: {
        ...(this.cookie ? { cookie: this.cookie } : {}),
        ...(this.bearer ? { authorization: `Bearer ${this.bearer}` } : {}),
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const setCookie = response.headers.get("set-cookie");
    if (setCookie) this.cookie = setCookie.split(";")[0]!;
    const text = await response.text();
    return { status: response.status, data: (text ? JSON.parse(text) : null) as T };
  }
}

const root = new Client();
const user = new Client();
type Destination = { id: string; name: string; kind: string; source: string; target?: string; schedule: string; hour: number; weekday: number; keep: number; next_run_at: number | null };
type Job = { id: string; destination_id: string; state: string; bytes: number | null; error: string | null; location: string | null; pruned: number; trigger: string };
type State = { destinations: Destination[]; jobs: Job[]; active: boolean };

async function waitForJob(id: string): Promise<Job> {
  for (let i = 0; i < 300; i += 1) {
    const state = await root.call<State>("/api/admin/backups");
    const job = state.data.jobs.find((entry) => entry.id === id);
    if (job && job.state !== "running" && !state.data.active) return job;
    await Bun.sleep(100);
  }
  throw new Error("backup did not finish");
}

beforeAll(async () => {
  previousEnv = process.env.GITGOOD_BACKUP_DESTINATIONS;
  process.env.GITGOOD_BACKUP_DESTINATIONS = JSON.stringify([{ id: `env-${stamp}`, name: "Server disk", kind: "local", target: join(target, "env") }]);
  await root.call("/api/auth/signup", "POST", { username: admin, email: `${admin}@example.test`, password: PASSWORD });
  changes("UPDATE users SET is_admin = 1 WHERE username = ?", admin);
  await user.call("/api/auth/signup", "POST", { username: member, email: `${member}@example.test`, password: PASSWORD });
  changes("UPDATE users SET is_admin = 0 WHERE username = ?", member);
});

afterAll(() => {
  changes("DELETE FROM backup_destinations WHERE id LIKE ?", `%${stamp}%`);
  if (previousEnv === undefined) delete process.env.GITGOOD_BACKUP_DESTINATIONS;
  else process.env.GITGOOD_BACKUP_DESTINATIONS = previousEnv;
  server.stop(true);
  rmSync(target, { recursive: true, force: true });
});

describe("backup destinations", () => {
  const id = `disk-${stamp}`;

  test("an administrator adds a destination with a schedule and retention", async () => {
    const created = await root.call<Destination>("/api/admin/backups/destinations", "POST", {
      id, name: "Recovery disk", kind: "local", target: join(target, "stored"), schedule: "daily", hour: 2, keep: 1,
    });
    expect(created.status).toBe(201);
    expect(created.data).toMatchObject({ id, source: "admin", target: join(target, "stored"), schedule: "daily", hour: 2, keep: 1 });
    expect(created.data.next_run_at).toBeGreaterThan(Date.now());
  });

  test("bad input is rejected with a clear message", async () => {
    for (const body of [
      { id: `rel-${stamp}`, name: "x", kind: "local", target: "relative/path" },
      { id: "Bad ID!", name: "x", kind: "local", target: join(target, "x") },
      { id: `drive-${stamp}`, name: "x", kind: "google-drive", target: "drive:../escape" },
      { id, name: "duplicate", kind: "local", target: join(target, "y") },
      { id: `env-${stamp}`, name: "clash", kind: "local", target: join(target, "z") },
    ]) {
      const response = await root.call<{ error: { message: string } }>("/api/admin/backups/destinations", "POST", body);
      expect(response.status).toBe(400);
      expect(response.data.error.message.length).toBeGreaterThan(5);
    }
    expect((await root.call("/api/admin/backups/destinations", "POST", { id: `x-${stamp}`, name: "x", kind: "ftp", target: "/x" })).status).toBe(400);
  });

  test("environment destinations are listed without their path; only their schedule is editable", async () => {
    const state = await root.call<State>("/api/admin/backups");
    const env = state.data.destinations.find((d) => d.id === `env-${stamp}`)!;
    expect(env.source).toBe("environment");
    expect(env).not.toHaveProperty("target");
    expect((await root.call<Destination>(`/api/admin/backups/destinations/env-${stamp}`, "PATCH", { schedule: "weekly", weekday: 6, hour: 4 })).data).toMatchObject({ schedule: "weekly", weekday: 6, hour: 4 });
    expect((await root.call(`/api/admin/backups/destinations/env-${stamp}`, "PATCH", { target: "/elsewhere" })).status).toBe(400);
    expect((await root.call(`/api/admin/backups/destinations/env-${stamp}`, "DELETE")).status).toBe(409);
  });

  test("testing reports a writable destination and refuses GitGood's own data directory without revealing it", async () => {
    const ok = await root.call<{ ok: boolean; free_bytes: number }>(`/api/admin/backups/destinations/${id}/test`, "POST", {});
    expect(ok.data.ok).toBe(true);
    expect(ok.data.free_bytes).toBeGreaterThan(0);
    const inside = `inside-${stamp}`;
    expect((await root.call("/api/admin/backups/destinations", "POST", { id: inside, name: "Inside", kind: "local", target: join(config.dataDir, "nested-backups") })).status).toBe(201);
    const refused = await root.call<{ ok: boolean; message: string }>(`/api/admin/backups/destinations/${inside}/test`, "POST", {});
    expect(refused.data.ok).toBe(false);
    expect(refused.data.message).toContain("outside GitGood");
    expect(refused.data.message).not.toContain(config.dataDir);
    expect((await root.call(`/api/admin/backups/destinations/${inside}`, "DELETE")).status).toBe(204);
  });

  test("backups run, record their size and location, and retention removes older copies", async () => {
    const first = await root.call<{ id: string }>("/api/admin/backups", "POST", { destination: id });
    expect(first.status).toBe(202);
    expect((await root.call("/api/admin/backups", "POST", { destination: id })).status).toBe(409);
    const done = await waitForJob(first.data.id);
    expect(done).toMatchObject({ state: "completed", trigger: "manual", error: null });
    expect(done.bytes).toBeGreaterThan(0);
    expect(done.location).toBe(join(target, "stored", first.data.id));
    expect(existsSync(join(done.location!, "manifest.json"))).toBe(true);

    const second = await root.call<{ id: string }>("/api/admin/backups", "POST", { destination: id });
    expect((await waitForJob(second.data.id)).state).toBe("completed");
    const jobs = (await root.call<State>("/api/admin/backups")).data.jobs;
    expect(jobs.find((job) => job.id === first.data.id)!.pruned).toBe(1);
    expect(existsSync(join(target, "stored", first.data.id))).toBe(false);
    expect(existsSync(join(target, "stored", second.data.id, "manifest.json"))).toBe(true);
  }, 90_000);

  test("editing and deleting a stored destination", async () => {
    const updated = await root.call<Destination>(`/api/admin/backups/destinations/${id}`, "PATCH", { name: "Renamed", schedule: "manual" });
    expect(updated.data).toMatchObject({ name: "Renamed", schedule: "manual", next_run_at: null });
    expect((await root.call(`/api/admin/backups/destinations/${id}`, "DELETE")).status).toBe(204);
    expect((await root.call(`/api/admin/backups/destinations/${id}`, "DELETE")).status).toBe(404);
  });
});

describe("backup access control", () => {
  test("non-administrators, anonymous callers and API tokens are refused", async () => {
    for (const [path, method] of [["/api/admin/backups", "GET"], ["/api/admin/backups/destinations", "POST"], ["/api/admin/configuration", "GET"]] as const) {
      expect((await user.call(path, method, method === "GET" ? undefined : {})).status).toBe(403);
      expect((await new Client().call(path, method, method === "GET" ? undefined : {})).status).toBeGreaterThanOrEqual(401);
      expect((await new Client("ggt_not_a_session").call(path, method, method === "GET" ? undefined : {})).status).toBeGreaterThanOrEqual(401);
    }
  });
});

describe("schedule arithmetic", () => {
  const at = Date.UTC(2026, 9, 19, 7, 30);
  test("daily schedules fire once per day after their hour", () => {
    const daily = { schedule: "daily" as const, hour: 3, weekday: 0, keep: 7 };
    expect(latestSlot(daily, at)).toBe(Date.UTC(2026, 9, 19, 3));
    expect(nextSlot(daily, at)).toBe(Date.UTC(2026, 9, 20, 3));
    expect(latestSlot({ ...daily, hour: 9 }, at)).toBe(Date.UTC(2026, 9, 18, 9));
    expect(isDue({ ...daily, last_scheduled_at: Date.UTC(2026, 9, 19, 2) }, at)).toBe(true);
    expect(isDue({ ...daily, last_scheduled_at: Date.UTC(2026, 9, 19, 3, 1) }, at)).toBe(false);
  });

  test("weekly schedules use the configured weekday and manual never fires", () => {
    const weekly = { schedule: "weekly" as const, hour: 4, weekday: 6, keep: 7 };
    expect(new Date(at).getUTCDay()).toBe(1);
    expect(latestSlot(weekly, at)).toBe(Date.UTC(2026, 9, 17, 4));
    expect(nextSlot(weekly, at)).toBe(Date.UTC(2026, 9, 24, 4));
    expect(latestSlot({ ...weekly, weekday: 1, hour: 7 }, at)).toBe(Date.UTC(2026, 9, 19, 7));
    expect(isDue({ schedule: "manual", hour: 0, weekday: 0, keep: 0, last_scheduled_at: null }, at)).toBe(false);
  });

  test("worker errors are reduced to the safe message line", () => {
    expect(parseWorkerError("noise\nGITGOOD_ERROR:No space left on the destination\n  at /srv/secret/path.ts")).toBe("No space left on the destination");
    expect(parseWorkerError("Error: ENOENT /srv/secret")).toBe("Backup failed; see the server log for details");
  });
});

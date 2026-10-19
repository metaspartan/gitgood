import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { createServer } from "../../src/server.ts";
import { changes, one } from "../../src/db/index.ts";
import { uploadStream, type TokenSource } from "../../src/lib/google-drive.ts";

const CLIENT_ID = "1234567890-testclient.apps.googleusercontent.com";
const CLIENT_SECRET = "GOCSPX-test-secret-value";

interface FakeFile { id: string; name: string; parents: string[]; folder: boolean; bytes: Uint8Array }
interface FakeSession { name: string; parents: string[]; received: Uint8Array[]; size: number }

const google = {
  files: new Map<string, FakeFile>(),
  sessions: new Map<string, FakeSession>(),
  pollsBeforeApproval: 1,
  devicePolls: 0,
  deny: false,
  revoked: new Set<string>(),
  accessTokens: new Set<string>(),
  refreshCount: 0,
  faults: [] as ("503" | "partial" | "401")[],
  nextId: 1,
};

const fake = Bun.serve({
  port: 0,
  async fetch(request) {
    const url = new URL(request.url);
    const formBody = async () => new URLSearchParams(await request.text());
    const bearer = request.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
    const authed = () => google.accessTokens.has(bearer);
    const id = () => `fakefile${String(google.nextId++).padStart(6, "0")}`;
    if (url.pathname === "/device/code" && request.method === "POST") {
      const body = await formBody();
      if (body.get("client_id") !== CLIENT_ID) return Response.json({ error: "invalid_client" }, { status: 401 });
      if (body.get("scope") !== "https://www.googleapis.com/auth/drive.file") return Response.json({ error: "invalid_scope" }, { status: 400 });
      google.devicePolls = 0;
      return Response.json({ device_code: "device-code-1", user_code: "GQVQ-JKEC", verification_url: "https://www.google.com/device", expires_in: 1800, interval: 1 });
    }
    if (url.pathname === "/token" && request.method === "POST") {
      const body = await formBody();
      if (body.get("client_id") !== CLIENT_ID || body.get("client_secret") !== CLIENT_SECRET) return Response.json({ error: "invalid_client" }, { status: 401 });
      if (body.get("grant_type") === "urn:ietf:params:oauth:grant-type:device_code") {
        if (google.deny) return Response.json({ error: "access_denied" }, { status: 403 });
        google.devicePolls += 1;
        if (google.devicePolls <= google.pollsBeforeApproval) return Response.json({ error: "authorization_pending" }, { status: 428 });
        google.accessTokens.add("access-initial");
        return Response.json({ access_token: "access-initial", refresh_token: "refresh-token-1", expires_in: 3599, token_type: "Bearer" });
      }
      if (body.get("grant_type") === "refresh_token") {
        const token = body.get("refresh_token") ?? "";
        if (token !== "refresh-token-1" || google.revoked.has(token)) return Response.json({ error: "invalid_grant" }, { status: 400 });
        google.refreshCount += 1;
        const access = `access-${google.refreshCount}`;
        google.accessTokens.add(access);
        return Response.json({ access_token: access, expires_in: 3599 });
      }
      return Response.json({ error: "unsupported_grant_type" }, { status: 400 });
    }
    if (url.pathname === "/revoke") {
      google.revoked.add((await formBody()).get("token") ?? "");
      return new Response(null, { status: 200 });
    }
    if (!authed()) return Response.json({ error: { code: 401, errors: [{ reason: "authError" }] } }, { status: 401 });
    if (url.pathname === "/drive/v3/about") {
      return Response.json({ user: { emailAddress: "backups@example.com", displayName: "Backup Owner" }, storageQuota: { limit: "16106127360", usage: "1073741824" } });
    }
    if (url.pathname === "/drive/v3/files" && request.method === "GET") {
      const name = /name = '((?:[^'\\]|\\.)*)'/.exec(url.searchParams.get("q") ?? "")?.[1]?.replace(/\\(.)/g, "$1");
      const found = [...google.files.values()].filter((file) => file.folder && file.name === name);
      return Response.json({ files: found.slice(0, 1).map((file) => ({ id: file.id })) });
    }
    if (url.pathname === "/drive/v3/files" && request.method === "POST") {
      const body = (await request.json()) as { name: string; parents: string[] };
      const file = { id: id(), name: body.name, parents: body.parents, folder: true, bytes: new Uint8Array() };
      google.files.set(file.id, file);
      return Response.json({ id: file.id });
    }
    const fileMatch = /^\/drive\/v3\/files\/([\w-]+)$/.exec(url.pathname);
    if (fileMatch && request.method === "DELETE") {
      return google.files.delete(fileMatch[1]!) ? new Response(null, { status: 204 }) : Response.json({ error: { code: 404, errors: [{ reason: "notFound" }] } }, { status: 404 });
    }
    if (url.pathname === "/upload/drive/v3/files" && url.searchParams.get("uploadType") === "resumable") {
      const body = (await request.json()) as { name: string; parents: string[] };
      const sid = id();
      google.sessions.set(sid, { name: body.name, parents: body.parents, received: [], size: 0 });
      return new Response(null, { status: 200, headers: { location: `${url.origin}/upload/session/${sid}` } });
    }
    const sessionMatch = /^\/upload\/session\/([\w-]+)$/.exec(url.pathname);
    if (sessionMatch && request.method === "PUT") {
      const session = google.sessions.get(sessionMatch[1]!);
      if (!session) return new Response(null, { status: 404 });
      const range = request.headers.get("content-range") ?? "";
      const ack = () => new Response(null, { status: 308, headers: session.size ? { range: `bytes=0-${session.size - 1}` } : {} });
      if (/^bytes \*\//.test(range)) return ack();
      const match = /^bytes (\d+)-(\d+)\/(\d+|\*)$/.exec(range);
      if (!match) return new Response("bad range", { status: 400 });
      const fault = google.faults.shift();
      if (fault === "503") return new Response("unavailable", { status: 503 });
      if (fault === "401") return Response.json({ error: { code: 401 } }, { status: 401 });
      const start = Number(match[1]);
      let bytes = new Uint8Array(await request.arrayBuffer());
      if (start !== session.size) return new Response("offset mismatch", { status: 400 });
      if (fault === "partial") bytes = bytes.subarray(0, Math.floor(bytes.byteLength / 2));
      session.received.push(bytes);
      session.size += bytes.byteLength;
      if (match[3] !== "*" && session.size === Number(match[3])) {
        const all = Buffer.concat(session.received);
        const file = { id: id(), name: session.name, parents: session.parents, folder: false, bytes: all };
        google.files.set(file.id, file);
        google.sessions.delete(sessionMatch[1]!);
        return Response.json({ id: file.id, size: String(all.byteLength), md5Checksum: createHash("md5").update(all).digest("hex") });
      }
      return ack();
    }
    return new Response("not found", { status: 404 });
  },
});

const server = createServer(0);
const BASE = `http://127.0.0.1:${server.port}`;
const stamp = Date.now().toString(36);
const admin = `ga${stamp}`;
const admin2 = `gb${stamp}`;
const member = `gm${stamp}`;
const PASSWORD = "google-drive-backups-password";
const saved: Record<string, string | undefined> = {};

class Client {
  cookie = "";
  async call<T = any>(path: string, method = "GET", body?: unknown): Promise<{ status: number; data: T }> {
    const response = await fetch(BASE + path, {
      method,
      headers: { ...(this.cookie ? { cookie: this.cookie } : {}), ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const setCookie = response.headers.get("set-cookie");
    if (setCookie) this.cookie = setCookie.split(";")[0]!;
    const text = await response.text();
    return { status: response.status, data: (text ? JSON.parse(text) : null) as T };
  }
}

const root = new Client();
const other = new Client();
const user = new Client();
type Account = { id: number; email: string; destinations: number };
type GoogleState = { client: { configured: boolean; source: string | null; client_id_hint: string | null }; accounts: Account[] };
type Job = { id: string; state: string; error: string | null; location: string | null; bytes: number | null; pruned: number };
type State = { google: GoogleState; jobs: Job[]; active: boolean; destinations: { id: string; kind: string; account_email: string | null }[] };

async function connect(client: Client): Promise<Account> {
  const started = await client.call<{ session: string; user_code: string; verification_url: string; interval: number }>("/api/admin/backups/google/connect", "POST", {});
  expect(started.status).toBe(201);
  expect(started.data).toMatchObject({ user_code: "GQVQ-JKEC", verification_url: "https://www.google.com/device", interval: 1 });
  expect(JSON.stringify(started.data)).not.toContain("device-code-1");
  for (let i = 0; i < 20; i += 1) {
    await Bun.sleep(1050);
    const poll = await client.call<{ state: string; account?: Account }>(`/api/admin/backups/google/connect/${started.data.session}`, "POST", {});
    expect(poll.status).toBe(200);
    if (poll.data.state === "connected") return poll.data.account!;
    expect(poll.data.state).toBe("pending");
  }
  throw new Error("never connected");
}

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
  for (const key of ["GITGOOD_GOOGLE_ENDPOINT", "GITGOOD_GOOGLE_CHUNK_BYTES", "GITGOOD_GOOGLE_CLIENT_ID", "GITGOOD_GOOGLE_CLIENT_SECRET", "GITGOOD_BACKUP_STAGING"]) saved[key] = process.env[key];
  process.env.GITGOOD_GOOGLE_ENDPOINT = `http://127.0.0.1:${fake.port}`;
  process.env.GITGOOD_GOOGLE_CHUNK_BYTES = String(256 * 1024);
  process.env.GITGOOD_BACKUP_STAGING = resolve(join(process.env.GITGOOD_DATA_DIR!, "..", `gg-drive-staging-${stamp}`));
  delete process.env.GITGOOD_GOOGLE_CLIENT_ID;
  delete process.env.GITGOOD_GOOGLE_CLIENT_SECRET;
  for (const [client, name, isAdmin] of [[root, admin, 1], [other, admin2, 1], [user, member, 0]] as const) {
    await client.call("/api/auth/signup", "POST", { username: name, email: `${name}@example.test`, password: PASSWORD });
    changes("UPDATE users SET is_admin = ? WHERE username = ?", isAdmin, name);
  }
  changes("DELETE FROM google_drive_accounts");
  changes("DELETE FROM google_oauth_client");
});

afterAll(() => {
  changes("DELETE FROM backup_destinations WHERE id LIKE ?", `%${stamp}%`);
  changes("DELETE FROM google_drive_accounts");
  changes("DELETE FROM google_oauth_client");
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  server.stop(true);
  fake.stop(true);
});

describe("Google Drive sign-in", () => {
  test("connecting is refused until an OAuth client is set up, and the client is validated", async () => {
    expect((await root.call<State>("/api/admin/backups")).data.google.client).toEqual({ configured: false, source: null, client_id_hint: null });
    expect((await root.call("/api/admin/backups/google/connect", "POST", {})).status).toBe(400);
    expect((await root.call("/api/admin/backups/google/client", "PUT", { client_id: "not-a-client", client_secret: CLIENT_SECRET })).status).toBe(400);
    expect((await user.call("/api/admin/backups/google/client", "PUT", { client_id: CLIENT_ID, client_secret: CLIENT_SECRET })).status).toBe(403);
    const saved = await root.call<GoogleState>("/api/admin/backups/google/client", "PUT", { client_id: CLIENT_ID, client_secret: CLIENT_SECRET });
    expect(saved.status).toBe(200);
    expect(saved.data.client).toEqual({ configured: true, source: "admin", client_id_hint: "123456…apps.googleusercontent.com" });
    expect(JSON.stringify(saved.data)).not.toContain(CLIENT_SECRET);
    const stored = one<{ client_secret: string }>("SELECT client_secret FROM google_oauth_client")!;
    expect(stored.client_secret.startsWith("v1.")).toBe(true);
    expect(stored.client_secret).not.toContain(CLIENT_SECRET);
  });

  test("signing in with Google links the account without exposing the device code or tokens", async () => {
    const account = await connect(root);
    expect(account).toMatchObject({ email: "backups@example.com", destinations: 0 });
    const stored = one<{ refresh_token: string }>("SELECT refresh_token FROM google_drive_accounts WHERE id = ?", account.id)!;
    expect(stored.refresh_token.startsWith("v1.")).toBe(true);
    expect(stored.refresh_token).not.toContain("refresh-token-1");
    const state = await root.call<State>("/api/admin/backups");
    expect(JSON.stringify(state.data)).not.toContain("refresh-token-1");
    expect(state.data.google.accounts.map((a) => a.email)).toEqual(["backups@example.com"]);
  }, 30_000);

  test("signing in again with the same account refreshes it instead of duplicating it", async () => {
    await connect(root);
    expect((await root.call<State>("/api/admin/backups")).data.google.accounts).toHaveLength(1);
  }, 30_000);

  test("a sign-in session belongs to the admin who started it, and a denial is reported", async () => {
    const started = await root.call<{ session: string }>("/api/admin/backups/google/connect", "POST", {});
    expect((await other.call(`/api/admin/backups/google/connect/${started.data.session}`, "POST", {})).status).toBe(404);
    expect((await user.call(`/api/admin/backups/google/connect/${started.data.session}`, "POST", {})).status).toBe(403);
    google.deny = true;
    await Bun.sleep(1050);
    expect((await root.call<{ state: string }>(`/api/admin/backups/google/connect/${started.data.session}`, "POST", {})).data.state).toBe("denied");
    google.deny = false;
    expect((await root.call(`/api/admin/backups/google/connect/${started.data.session}`, "POST", {})).status).toBe(404);
  });
});

describe("Google Drive backups", () => {
  const id = `drive-${stamp}`;
  let accountId = 0;

  test("a destination needs a connected account and a plain folder name", async () => {
    accountId = (await root.call<State>("/api/admin/backups")).data.google.accounts[0]!.id;
    expect((await root.call("/api/admin/backups/destinations", "POST", { id, name: "Drive", kind: "google-drive", target: "GitGood Backups" })).status).toBe(400);
    expect((await root.call("/api/admin/backups/destinations", "POST", { id, name: "Drive", kind: "google-drive", target: "a/b", account_id: accountId })).status).toBe(400);
    expect((await root.call("/api/admin/backups/destinations", "POST", { id, name: "Drive", kind: "google-drive", target: "GitGood Backups", account_id: 999999 })).status).toBe(400);
    const created = await root.call("/api/admin/backups/destinations", "POST", { id, name: "Drive", kind: "google-drive", target: "GitGood Backups", account_id: accountId, keep: 1 });
    expect(created.status).toBe(201);
    expect(created.data).toMatchObject({ kind: "google-drive", account_email: "backups@example.com", target: "GitGood Backups" });
  });

  test("an old rclone-style Drive target is treated as an rclone remote", async () => {
    const legacy = await root.call<{ kind: string }>("/api/admin/backups/destinations", "POST", { id: `legacy-${stamp}`, name: "Legacy", kind: "google-drive", target: "drive:GitGood" });
    expect(legacy.status).toBe(201);
    expect(legacy.data.kind).toBe("rclone");
    await root.call(`/api/admin/backups/destinations/legacy-${stamp}`, "DELETE");
  });

  test("testing reports the account, free space, and creates the folder once", async () => {
    const result = await root.call<{ ok: boolean; message: string; free_bytes: number }>(`/api/admin/backups/destinations/${id}/test`, "POST", {});
    expect(result.data).toEqual({ ok: true, message: "Connected to Google Drive as backups@example.com. The “GitGood Backups” folder is ready.", free_bytes: 14 * 1024 ** 3 });
    await root.call(`/api/admin/backups/destinations/${id}/test`, "POST", {});
    expect([...google.files.values()].filter((f) => f.folder && f.name === "GitGood Backups")).toHaveLength(1);
  }, 60_000);

  test("a backup uploads one verified archive to the folder, survives faults, and leaves no staging copy", async () => {
    google.faults = ["503", "partial", "401"];
    const started = await root.call<{ id: string }>("/api/admin/backups", "POST", { destination: id });
    expect(started.status).toBe(202);
    const job = await waitForJob(started.data.id);
    expect(job).toMatchObject({ state: "completed", error: null });
    const fileId = /^https:\/\/drive\.google\.com\/file\/d\/([\w-]+)\/view$/.exec(job.location ?? "")?.[1];
    expect(fileId).toBeTruthy();
    const file = google.files.get(fileId!)!;
    const folder = [...google.files.values()].find((f) => f.folder && f.name === "GitGood Backups")!;
    expect(file.parents).toEqual([folder.id]);
    expect(file.name).toMatch(/^gitgood-backup-\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}-[0-9a-f-]{8}\.tar$/);
    expect(job.bytes).toBe(file.bytes.byteLength);
    expect(file.bytes.byteLength).toBeGreaterThan(256 * 1024);
    expect(google.faults).toEqual([]);
    const listing = await new Response(Bun.spawn(["tar", "-tf", "-"], { stdin: file.bytes, stdout: "pipe" }).stdout).text();
    expect(listing).toContain("manifest.json");
    const staging = process.env.GITGOOD_BACKUP_STAGING!;
    expect(existsSync(staging) ? readdirSync(staging).filter((entry) => entry.startsWith("backup-")) : []).toEqual([]);
  }, 120_000);

  test("retention deletes the previous archive from Drive after the next successful backup", async () => {
    const before = [...google.files.values()].filter((f) => !f.folder).map((f) => f.id);
    expect(before).toHaveLength(1);
    const started = await root.call<{ id: string }>("/api/admin/backups", "POST", { destination: id });
    expect((await waitForJob(started.data.id)).state).toBe("completed");
    const after = [...google.files.values()].filter((f) => !f.folder).map((f) => f.id);
    expect(after).toHaveLength(1);
    expect(after[0]).not.toBe(before[0]);
    const jobs = (await root.call<State>("/api/admin/backups")).data.jobs;
    expect(jobs.find((j) => j.location?.includes(before[0]!))!.pruned).toBe(1);
  }, 120_000);

  test("an account in use cannot be disconnected; revoked access fails the backup with a clear message", async () => {
    expect((await root.call(`/api/admin/backups/google/accounts/${accountId}`, "DELETE")).status).toBe(409);
    google.revoked.add("refresh-token-1");
    const started = await root.call<{ id: string }>("/api/admin/backups", "POST", { destination: id });
    const job = await waitForJob(started.data.id);
    expect(job.state).toBe("failed");
    expect(job.error).toBe("Google access was revoked or expired; reconnect the account in Admin → Backups");
    google.revoked.delete("refresh-token-1");
  }, 120_000);

  test("disconnecting revokes the token once no destination uses the account", async () => {
    expect((await root.call(`/api/admin/backups/destinations/${id}`, "DELETE")).status).toBe(204);
    const removed = await root.call<GoogleState>(`/api/admin/backups/google/accounts/${accountId}`, "DELETE");
    expect(removed.status).toBe(200);
    expect(removed.data.accounts).toEqual([]);
    expect(google.revoked.has("refresh-token-1")).toBe(true);
    expect((await root.call<GoogleState>("/api/admin/backups/google/client", "DELETE")).data.client.configured).toBe(false);
  });
});

describe("resumable upload", () => {
  test("multi-chunk uploads recover from 503s, partial acknowledgements and expired tokens", async () => {
    google.accessTokens.add("unit-access");
    let refreshes = 0;
    const tokens: TokenSource = { token: async () => "unit-access", refresh: async () => { refreshes += 1; return "unit-access"; } };
    const payload = new Uint8Array(1_300_000).map((_, i) => (i * 31) % 251);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let i = 0; i < payload.length; i += 100_000) controller.enqueue(payload.subarray(i, i + 100_000));
        controller.close();
      },
    });
    google.faults = ["partial", "503", "401", "partial"];
    const result = await uploadStream(tokens, "folder", "unit.tar", stream, { chunkBytes: 256 * 1024 });
    expect(result.size).toBe(payload.byteLength);
    expect(result.md5).toBe(createHash("md5").update(payload).digest("hex"));
    expect(Buffer.compare(Buffer.from(google.files.get(result.id)!.bytes), Buffer.from(payload))).toBe(0);
    expect(refreshes).toBe(1);
    expect(google.faults).toEqual([]);
  }, 60_000);
});

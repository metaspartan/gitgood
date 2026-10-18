import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

const BASE = process.env.GITGOOD_TEST_URL ?? "http://127.0.0.1:3000";
const username = `lfs${Date.now().toString(36)}`;
const PASSWORD = "supersecret123";

interface RunResult {
  exitCode: number;
  out: string;
  err: string;
}

function run(cmd: string[], cwd: string, extraEnv: Record<string, string> = {}): RunResult {
  const proc = Bun.spawnSync({
    cmd,
    cwd,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", ...extraEnv },
    stdout: "pipe",
    stderr: "pipe",
    timeout: 90_000,
  });
  const timedOut = (proc as { signalCode?: string | null }).signalCode === "SIGTERM";
  return {
    exitCode: proc.exitCode ?? -1,
    out: timedOut ? "" : proc.stdout.toString(),
    err: timedOut ? `timed out after 90s: ${cmd.join(" ")}` : proc.stderr.toString(),
  };
}

function git(args: string[], cwd: string, env: Record<string, string> = {}): RunResult {
  return run(["git", ...args], cwd, env);
}

function lfs(args: string[], cwd: string): RunResult {
  return run(["git", "lfs", ...args], cwd);
}

let failures = 0;
let checks = 0;

function check(label: string, ok: boolean, detail = ""): void {
  checks += 1;
  if (!ok) failures += 1;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  ${detail}` : ""}`);
}

async function api(
  path: string,
  init: { method?: string; body?: unknown; cookie?: string } = {},
): Promise<{ status: number; data: Record<string, unknown>; setCookie: string | null }> {
  const headers: Record<string, string> = {};
  if (init.cookie) headers.cookie = init.cookie;
  let body: string | undefined;
  if (init.body !== undefined) {
    body = JSON.stringify(init.body);
    headers["content-type"] = "application/json";
  }
  const res = await fetch(BASE + path, {
    method: init.method ?? "GET",
    headers: new Headers(headers),
    ...(body !== undefined ? { body } : {}),
  });
  const text = await res.text();
  let data: Record<string, unknown> = {};
  try {
    data = JSON.parse(text) as Record<string, unknown>;
  } catch {
    data = { raw: text };
  }
  return { status: res.status, data, setCookie: res.headers.get("set-cookie") };
}

function makePng(width: number, height: number): Buffer {
  const crcTable: number[] = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crcTable[n] = c >>> 0;
  }
  const crc32 = (buf: Buffer): number => {
    let c = 0xffffffff;
    for (const byte of buf) c = (crcTable[(c ^ byte) & 0xff] as number) ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer): Buffer => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const raw = Buffer.alloc(height * (1 + width * 3));
  for (let y = 0; y < height; y++) {
    const row = y * (1 + width * 3);
    raw[row] = 0;
    for (let x = 0; x < width; x++) {
      const p = row + 1 + x * 3;
      raw[p] = (x * 255) / Math.max(1, width - 1);
      raw[p + 1] = (y * 255) / Math.max(1, height - 1);
      raw[p + 2] = 128;
    }
  }
  const idat = Buffer.from(Bun.deflateSync(raw));

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", idat),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function sha256(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

const signup = await api("/api/auth/signup", {
  method: "POST",
  body: { username, email: `${username}@example.com`, password: PASSWORD },
});
if (signup.status !== 201 && signup.status !== 200) {
  console.error("signup failed:", signup.status, JSON.stringify(signup.data).slice(0, 200));
  process.exit(1);
}
const cookie = (signup.setCookie ?? "").split(";")[0] ?? "";

const created = await api("/api/repos", {
  method: "POST",
  body: { name: "lfs", lfs_enabled: true },
  cookie,
});
if (created.status !== 201) {
  console.error("create repo failed:", created.status, JSON.stringify(created.data).slice(0, 200));
  process.exit(1);
}

const tokenRes = await api("/api/tokens", { method: "POST", body: { name: "cli" }, cookie });
const token = String(tokenRes.data.token ?? "");
if (!token) {
  console.error("could not mint a token:", JSON.stringify(tokenRes.data).slice(0, 200));
  process.exit(1);
}

const remote = `${BASE}/${username}/lfs.git`;
const authenticatedUrl = new URL(remote);
authenticatedUrl.username = username; authenticatedUrl.password = token;
const authedRemote = authenticatedUrl.href;
console.log(`account: ${username}/lfs`);

const work = mkdtempSync(join(tmpdir(), "lfs-work-"));
git(["init", "--quiet", "-b", "main"], work);
git(["config", "user.name", "T"], work);
git(["config", "user.email", "t@example.com"], work);

const install = lfs(["install", "--local"], work);
check("git lfs install --local succeeds", install.exitCode === 0, install.err.trim().slice(0, 120));

const track = lfs(["track", "*.png"], work);
check("git lfs track *.png succeeds", track.exitCode === 0, track.err.trim().slice(0, 120));

const png = makePng(64, 64);
const pngOid = sha256(png);
writeFileSync(join(work, "logo.png"), png);
console.log(`\n  png ${png.length} bytes, oid ${pngOid.slice(0, 16)}…`);

const attrs = readFileSync(join(work, ".gitattributes"), "utf8");
check("gitattributes declares the lfs filter", attrs.includes("filter=lfs"), JSON.stringify(attrs.trim().slice(0, 60)));

git(["add", "--all"], work);
const commit = git(["commit", "--quiet", "-m", "add a tracked png"], work);
check("commit succeeds", commit.exitCode === 0, commit.err.trim().slice(0, 160));

const push = git(["push", "--quiet", authedRemote, "main"], work);
check("push with LFS objects succeeds", push.exitCode === 0, (push.err || push.out).trim().slice(0, 300));

console.log("\n=== what git actually stored ===");
const storedBlob = git(["cat-file", "-p", "HEAD:logo.png"], work);
const storedText = storedBlob.out;
const isPointer = storedText.startsWith("version https://git-lfs.github.com/spec/v1");
check("the committed blob is an LFS pointer", isPointer, JSON.stringify(storedText.slice(0, 80)));
check(
  "the pointer carries the right oid and size",
  storedText.includes(pngOid) && storedText.includes(`size ${png.length}`),
);
check("the pointer is tiny, so the binary went out of band", storedText.length < 200, `${storedText.length} bytes`);

console.log("\n=== the LFS store ===");
const batchDownload = await fetch(`${remote}/info/lfs/objects/batch`, {
  method: "POST",
  headers: new Headers({
    "content-type": "application/vnd.git-lfs+json",
    accept: "application/vnd.git-lfs+json",
    authorization: `Basic ${Buffer.from(`${username}:${token}`).toString("base64")}`,
  }),
  body: JSON.stringify({ operation: "download", transfers: ["basic"], objects: [{ oid: pngOid, size: png.length }] }),
});
const batchBody = (await batchDownload.json()) as {
  transfer?: string;
  hash_algo?: string;
  objects?: Array<{ oid: string; size: number; actions?: Record<string, { href: string }>; error?: unknown }>;
};
check("batch download returns 200", batchDownload.status === 200, `status ${batchDownload.status}`);
check("batch declares transfer: basic", batchBody.transfer === "basic");
check("batch declares hash_algo: sha256", batchBody.hash_algo === "sha256");
const firstObject = batchBody.objects?.[0];
check("the uploaded object is resolvable for download", Boolean(firstObject?.actions?.download), JSON.stringify(firstObject?.error ?? "no error"));
check("the batch reports the true size", firstObject?.size === png.length, `${firstObject?.size} vs ${png.length}`);

const actionHref = firstObject?.actions?.download?.href ?? "";
const fetched = await fetch(actionHref, {
  headers: new Headers({
    authorization: `Basic ${Buffer.from(`${username}:${token}`).toString("base64")}`,
  }),
});
const fetchedBytes = Buffer.from(await fetched.arrayBuffer());
check("the advertised download href returns the object", fetched.status === 200, `status ${fetched.status}`);
check("the downloaded bytes are identical", fetchedBytes.equals(png), `${fetchedBytes.length} vs ${png.length}`);
check("the download is served as octet-stream", (fetched.headers.get("content-type") ?? "").includes("octet-stream"), fetched.headers.get("content-type") ?? "");

console.log("\n=== a fresh clone ===");
const cloneDir = mkdtempSync(join(tmpdir(), "lfs-clone-"));
const clone = git(["clone", "--quiet", authedRemote, cloneDir], tmpdir());
check("clone succeeds", clone.exitCode === 0, (clone.err || clone.out).trim().slice(0, 200));

const pulled = lfs(["pull"], cloneDir);
check("git lfs pull succeeds", pulled.exitCode === 0, (pulled.err || pulled.out).trim().slice(0, 200));

const materialised = join(cloneDir, "logo.png");
check("the working tree has the file", existsSync(materialised));
if (existsSync(materialised)) {
  const clonedBytes = readFileSync(materialised);
  check(
    "the materialised file is the original binary",
    clonedBytes.equals(png),
    `${clonedBytes.length} vs ${png.length}`,
  );
  check(
    "and not a pointer",
    !clonedBytes.toString("utf8", 0, 40).startsWith("version https://git-lfs"),
  );
}

const lsFiles = lfs(["ls-files"], cloneDir);
check("git lfs ls-files lists the object", lsFiles.out.includes("logo.png"), lsFiles.out.trim().slice(0, 80));

console.log("\n=== a clone that does not fetch LFS content ===");
const bare = mkdtempSync(join(tmpdir(), "lfs-bare-"));
const noSmudge = git(
  ["clone", "--quiet", "--no-checkout", authedRemote, bare],
  tmpdir(),
);
check("clone --no-checkout succeeds", noSmudge.exitCode === 0, (noSmudge.err || noSmudge.out).trim().slice(0, 200));
const pointerBlob = git(["cat-file", "-p", "HEAD:logo.png"], bare);
check(
  "the object in the pack is a pointer even in a fresh clone",
  pointerBlob.out.startsWith("version https://git-lfs"),
  JSON.stringify(pointerBlob.out.slice(0, 50)),
);

console.log("\n=== dedup across repositories ===");
const second = await api("/api/repos", { method: "POST", body: { name: "lfs2", lfs_enabled: true }, cookie });
check("second repository created", second.status === 201, `status ${second.status}`);
const secondUrl = new URL(`${BASE}/${username}/lfs2.git`);
secondUrl.username = username; secondUrl.password = token;
const secondRemote = secondUrl.href;
const work2 = mkdtempSync(join(tmpdir(), "lfs-work2-"));
git(["init", "--quiet", "-b", "main"], work2);
git(["config", "user.name", "T"], work2);
git(["config", "user.email", "t@example.com"], work2);
lfs(["install", "--local"], work2);
lfs(["track", "*.png"], work2);
writeFileSync(join(work2, "logo.png"), png);
git(["add", "--all"], work2);
git(["commit", "--quiet", "-m", "same bytes"], work2);
const push2 = git(["push", "--quiet", secondRemote, "main"], work2);
check("the same object can be pushed to a second repository", push2.exitCode === 0, (push2.err || push2.out).trim().slice(0, 200));

const objectPathGuess = `/data/lfs/objects/${pngOid.slice(0, 2)}/${pngOid.slice(2, 4)}/${pngOid}`;
const objectPresent = process.env.GITGOOD_TEST_LFS_ROOT
  ? await Bun.file(join(process.env.GITGOOD_TEST_LFS_ROOT, "objects", pngOid.slice(0, 2), pngOid.slice(2, 4), pngOid)).exists()
  : Bun.spawnSync({ cmd: ["docker", "exec", "gitgood-gitgood-1", "test", "-f", objectPathGuess], stdout: "ignore", stderr: "ignore" }).exitCode === 0;
check("the object exists at its content-addressed path", objectPresent, objectPathGuess);

console.log("\n=== the locking API ===");
const lockCreate = await fetch(`${remote}/info/lfs/locks`, {
  method: "POST",
  headers: new Headers({
    "content-type": "application/vnd.git-lfs+json",
    authorization: `Basic ${Buffer.from(`${username}:${token}`).toString("base64")}`,
  }),
  body: JSON.stringify({ path: "artwork/hero.psd" }),
});
const lockBody = (await lockCreate.json()) as { lock?: { id: string; path: string; owner?: { name: string } } };
check("POST /locks returns 201", lockCreate.status === 201, `status ${lockCreate.status}`);
check("the lock carries an id and the path", Boolean(lockBody.lock?.id) && lockBody.lock?.path === "artwork/hero.psd", JSON.stringify(lockBody.lock ?? {}).slice(0, 90));

const lockList = await fetch(`${remote}/info/lfs/locks`, {
  headers: new Headers({ authorization: `Basic ${Buffer.from(`${username}:${token}`).toString("base64")}` }),
});
const lockListBody = (await lockList.json()) as { locks?: Array<{ path?: string }>; next_cursor?: string };
check(
  "GET /locks lists the lock",
  (lockListBody.locks?.length ?? 0) === 1 && lockListBody.locks?.[0]?.path === "artwork/hero.psd",
  JSON.stringify(lockListBody).slice(0, 110),
);

const lockVerify = await fetch(`${remote}/info/lfs/locks/verify`, {
  method: "POST",
  headers: new Headers({
    "content-type": "application/vnd.git-lfs+json",
    authorization: `Basic ${Buffer.from(`${username}:${token}`).toString("base64")}`,
  }),
  body: JSON.stringify({}),
});
const lockVerifyBody = (await lockVerify.json()) as { ours?: unknown[]; theirs?: unknown[] };
check(
  "POST /locks/verify separates ours from theirs",
  lockVerify.status === 200 && (lockVerifyBody.ours?.length ?? 0) === 1,
  `status ${lockVerify.status} ${JSON.stringify(lockVerifyBody).slice(0, 90)}`,
);

const lockId = lockBody.lock?.id ?? "";
const unlock = await fetch(`${remote}/info/lfs/locks/${lockId}/unlock`, {
  method: "POST",
  headers: new Headers({
    "content-type": "application/vnd.git-lfs+json",
    authorization: `Basic ${Buffer.from(`${username}:${token}`).toString("base64")}`,
  }),
  body: JSON.stringify({}),
});
check("POST /locks/:id/unlock succeeds", unlock.status === 200, `status ${unlock.status}`);

console.log("\n=== the content-addressability guard ===");
const wrongOid = "0".repeat(64);
const badPut = await fetch(`${remote}/info/lfs/objects/${wrongOid}`, {
  method: "PUT",
  headers: new Headers({
    "content-type": "application/octet-stream",
    authorization: `Basic ${Buffer.from(`${username}:${token}`).toString("base64")}`,
  }),
  body: new Uint8Array(png),
});
check(
  "an upload whose bytes do not hash to the declared oid is rejected",
  badPut.status === 422,
  `status ${badPut.status}`,
);

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures > 0) process.exit(1);
console.log(`remote: ${remote}`);

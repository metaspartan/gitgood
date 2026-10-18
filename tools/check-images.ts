import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BASE = "http://127.0.0.1:3000";
const username = `img${Date.now().toString(36)}`;
const PASSWORD = "supersecret123";

function run(cmd: string[], cwd: string, env: Record<string, string> = {}) {
  const proc = Bun.spawnSync({
    cmd,
    cwd,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  return { exitCode: proc.exitCode ?? -1, out: proc.stdout.toString(), err: proc.stderr.toString() };
}

let failures = 0;
let checks = 0;
function check(label: string, ok: boolean, detail = ""): void {
  checks += 1;
  if (!ok) failures += 1;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  ${detail}` : ""}`);
}

async function api(path: string, init: { method?: string; body?: unknown; cookie?: string } = {}) {
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
  const table: number[] = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  const crc32 = (buf: Buffer): number => {
    let c = 0xffffffff;
    for (const b of buf) c = (table[(c ^ b) & 0xff] as number) ^ (c >>> 8);
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
  const raw = Buffer.alloc(height * (1 + width * 3));
  for (let y = 0; y < height; y++) {
    const row = y * (1 + width * 3);
    for (let x = 0; x < width; x++) {
      const p = row + 1 + x * 3;
      raw[p] = Math.floor((x / Math.max(1, width - 1)) * 255);
      raw[p + 1] = Math.floor((y / Math.max(1, height - 1)) * 255);
      raw[p + 2] = 90;
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", Buffer.from(Bun.deflateSync(raw))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const SVG = Buffer.from(
  `<svg xmlns="http://www.w3.org/2000/svg" width="120" height="80" viewBox="0 0 120 80">` +
    `<rect width="120" height="80" fill="#1d4ed8"/><circle cx="60" cy="40" r="28" fill="#f59e0b"/></svg>\n`,
  "utf8",
);

const signup = await api("/api/auth/signup", {
  method: "POST",
  body: { username, email: `${username}@example.com`, password: PASSWORD },
});
const cookie = (signup.setCookie ?? "").split(";")[0] ?? "";
const token = String((await api("/api/tokens", { method: "POST", body: { name: "cli" }, cookie })).data.token ?? "");
console.log(`account: ${username}`);

const plain = await api("/api/repos", { method: "POST", body: { name: "plain" }, cookie: cookie });
check("created the plain repository", plain.status === 201, `status ${plain.status}`);

const png = makePng(96, 64);
const dirA = mkdtempSync(join(tmpdir(), "imgA-"));
run(["git", "init", "--quiet", "-b", "main"], dirA);
run(["git", "config", "user.name", "T"], dirA);
run(["git", "config", "user.email", "t@example.com"], dirA);
writeFileSync(join(dirA, "logo.png"), png);
writeFileSync(join(dirA, "mark.svg"), SVG);
writeFileSync(join(dirA, "notes.txt"), "this is not an image\n");
writeFileSync(join(dirA, "fake.png"), "version 1\nplain text pretending to be a png\n");
run(["git", "add", "--all"], dirA);
run(["git", "commit", "--quiet", "-m", "images"], dirA);
const pushA = run(["git", "push", "--quiet", `http://${username}:${token}@127.0.0.1:3000/${username}/plain.git`, "main"], dirA);
check("pushed the plain repository", pushA.exitCode === 0, (pushA.err || "").trim().slice(0, 160));

const lfsRepo = await api("/api/repos", { method: "POST", body: { name: "lfsimg", lfs_enabled: true }, cookie });
check("created the LFS repository", lfsRepo.status === 201, `status ${lfsRepo.status}`);

const dirB = mkdtempSync(join(tmpdir(), "imgB-"));
run(["git", "init", "--quiet", "-b", "main"], dirB);
run(["git", "config", "user.name", "T"], dirB);
run(["git", "config", "user.email", "t@example.com"], dirB);
run(["git", "lfs", "install", "--local"], dirB);
run(["git", "lfs", "track", "*.png"], dirB);
writeFileSync(join(dirB, "logo.png"), png);
run(["git", "add", "--all"], dirB);
run(["git", "commit", "--quiet", "-m", "image via lfs"], dirB);
const pushB = run(["git", "push", "--quiet", `http://${username}:${token}@127.0.0.1:3000/${username}/lfsimg.git`, "main"], dirB);
check("pushed the LFS repository", pushB.exitCode === 0, (pushB.err || "").trim().slice(0, 200));

console.log("\n=== 1. a PNG committed directly to git ===");
const blobA = await api(`/api/repos/${username}/plain/blob?path=logo.png&ref=main`, { cookie });
const bA = blobA.data as { kind?: string; mime?: string; content?: string | null; size?: number; binary?: boolean; encoding?: string };
check("blob reports kind=image", bA.kind === "image", `kind=${bA.kind}`);
check("blob reports the sniffed mime", bA.mime === "image/png", `mime=${bA.mime}`);
check("blob reports binary and encoding=binary", bA.binary === true && bA.encoding === "binary", `binary=${bA.binary} encoding=${bA.encoding}`);
check("blob does not inline the bytes", bA.content === null, `content=${bA.content === null ? "null" : "present"}`);

for (const [path, wantType] of [
  ["logo.png", "image/png"],
  ["mark.svg", "image/svg+xml"],
  ["fake.png", "text/plain"],
] as const) {
  const res = await fetch(`${BASE}/api/repos/${username}/plain/raw?path=${encodeURIComponent(path)}&ref=main`);
  const got = res.headers.get("content-type") ?? "";
  check(`raw ${path.padEnd(9)} is served as ${wantType}`, got.startsWith(wantType), `got ${got}`);
  const bytes = Buffer.from(await res.arrayBuffer());
  if (path === "logo.png") {
    check("raw logo.png is byte-identical to what was pushed", bytes.equals(png), `${bytes.length} vs ${png.length}`);
  }
  if (path === "fake.png") {
    check(
      "the text file wearing .png is NOT served as an image",
      !got.startsWith("image/"),
      `got ${got} - content type follows the bytes, not the extension`,
    );
  }
}

const rawDisposition = await fetch(`${BASE}/api/repos/${username}/plain/raw?path=logo.png&ref=main`);
check(
  "raw serves inline rather than forcing a download",
  (rawDisposition.headers.get("content-disposition") ?? "inline").startsWith("inline"),
  rawDisposition.headers.get("content-disposition") ?? "(no content-disposition)",
);
const downloadDisposition = await fetch(`${BASE}/api/repos/${username}/plain/raw?path=logo.png&ref=main&download=1`);
check(
  "…and download=1 does force one",
  (downloadDisposition.headers.get("content-disposition") ?? "").startsWith("attachment"),
  downloadDisposition.headers.get("content-disposition") ?? "(none)",
);

console.log("\n=== 2. a PNG tracked in Git LFS (the case that matters) ===");
const blobB = await api(`/api/repos/${username}/lfsimg/blob?path=logo.png&ref=main`, { cookie });
const bB = blobB.data as { kind?: string; mime?: string; content?: string | null; size?: number };
check(
  "blob reports kind=image for the LFS-tracked file",
  bB.kind === "image",
  `kind=${bB.kind} size=${bB.size} mime=${bB.mime}`,
);
if (bB.kind !== "image") {
  console.log(`      content begins: ${JSON.stringify((bB.content ?? "").slice(0, 90))}`);
  console.log("      -> this is the LFS POINTER being shown as the file's contents");
}
const rawB = await fetch(`${BASE}/api/repos/${username}/lfsimg/raw?path=logo.png&ref=main`);
const bufB = Buffer.from(await rawB.arrayBuffer());
check(
  "raw returns the image bytes, not the pointer",
  bufB.equals(png),
  `${bufB.length} bytes vs the real ${png.length}; serves as ${rawB.headers.get("content-type")}`,
);

console.log("\n=== 3. URLs the UI will use (for the browser check) ===");
console.log(`  plain : ${BASE}/${username}/plain/blob/main/logo.png`);
console.log(`  lfs   : ${BASE}/${username}/lfsimg/blob/main/logo.png`);
console.log(`  raw   : ${BASE}/api/repos/${username}/plain/raw?path=logo.png&ref=main`);

console.log(`\n${checks - failures}/${checks} checks passed`);
console.log(`OWNER=${username}`);
if (failures > 0) process.exitCode = 1;

import { git } from "../src/git/run.ts";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BASE = "http://127.0.0.1:3000";
const username = `crlf${Date.now().toString(36)}`;

interface BlobPayload {
  content?: string;
  encoding?: string;
  size?: number;
  line_count?: number;
  truncated?: boolean;
  kind?: string;
}

interface ApiInit {
  method?: string;
  body?: unknown;
  headers?: Record<string, string>;
}

async function api(path: string, init: ApiInit = {}, cookie = ""): Promise<{ status: number; data: Record<string, unknown>; res: Response }> {
  const headers: Record<string, string> = { ...(init.headers ?? {}) };
  if (cookie) headers.cookie = cookie;
  const body = init.body === undefined ? undefined : JSON.stringify(init.body);
  if (body) headers["content-type"] = "application/json";
  const request: RequestInit = {
    method: init.method ?? "GET",
    headers: new Headers(headers),
    ...(body ? { body } : {}),
  };
  const res = await fetch(BASE + path, request);
  const text = await res.text();
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(text) as Record<string, unknown>;
  } catch {
    data = { raw: text };
  }
  return { status: res.status, data, res };
}

const signup = await api("/api/auth/signup", {
  method: "POST",
  body: { username, email: `${username}@example.com`, password: "supersecret123" },
});
if (signup.status !== 201 && signup.status !== 200) {
  console.error("signup failed:", signup.status, JSON.stringify(signup.data).slice(0, 200));
  process.exit(1);
}
const cookie = (signup.res.headers.get("set-cookie") ?? "").split(";")[0] ?? "";

const created = await api("/api/repos", { method: "POST", body: { name: "crlf" } }, cookie);
if (created.status !== 201) {
  console.error("create repo failed:", created.status, JSON.stringify(created.data).slice(0, 200));
  process.exit(1);
}
const tokenResult = await api("/api/tokens", { method: "POST", body: { name: "cli" } }, cookie);
const token = String(tokenResult.data.token ?? "");
console.log(`account: ${username}/crlf`);

const work = mkdtempSync(join(tmpdir(), "crlf-work-"));
await git(["init", "--quiet", "-b", "main"], { cwd: work });

const crlfBytes = Buffer.from("one\r\ntwo\r\nthree\r\n", "utf8");
const lfBytes = Buffer.from("one\ntwo\nthree\n", "utf8");
const mixedBytes = Buffer.from("a\r\nb\nc\r\n", "utf8");
writeFileSync(join(work, "crlf.txt"), crlfBytes);
writeFileSync(join(work, "lf.txt"), lfBytes);
writeFileSync(join(work, "mixed.txt"), mixedBytes);
writeFileSync(join(work, ".gitattributes"), "*.txt -text\n");

await git(["add", "-A"], { cwd: work });
await git(["-c", "user.name=T", "-c", "user.email=t@example.com", "commit", "-q", "-m", "line endings"], { cwd: work });

const remote = `http://${username}:${token}@127.0.0.1:3000/${username}/crlf.git`;
const push = await git(["push", "--quiet", remote, "main"], { cwd: work, allowFailure: true });
console.log(`push exit=${push.exitCode}${push.stderr ? ` stderr=${push.stderr.trim().slice(0, 140)}` : ""}`);

const original: Record<string, Buffer> = {
  "crlf.txt": crlfBytes,
  "lf.txt": lfBytes,
  "mixed.txt": mixedBytes,
};

function crCount(bytes: Buffer): number {
  let n = 0;
  for (const b of bytes) if (b === 0x0d) n++;
  return n;
}

console.log("\n=== 1. GET /raw?path=… — the stored bytes as the server sends them ===");
for (const name of ["crlf.txt", "lf.txt", "mixed.txt"]) {
  const res = await fetch(`${BASE}/api/repos/${username}/crlf/raw?path=${encodeURIComponent(name)}&ref=main`, {
    headers: { cookie },
  });
  const buf = Buffer.from(await res.arrayBuffer());
  const same = buf.equals(original[name]!);
  console.log(`  ${name.padEnd(11)} HTTP ${res.status} ${buf.length}B CR=${crCount(buf)} identical=${same}`);
}

console.log("\n=== 2. GET /blob?path=…&ref=main — the JSON file view ===");
for (const name of ["crlf.txt", "lf.txt", "mixed.txt"]) {
  const r = await api(`/api/repos/${username}/crlf/blob?path=${encodeURIComponent(name)}&ref=main`, {}, cookie);
  if (r.status !== 200) {
    console.log(`  ${name.padEnd(11)} HTTP ${r.status}`);
    continue;
  }
  const payload = r.data as BlobPayload;
  const content = payload.content ?? "";
  console.log(
    `  ${name.padEnd(11)} 200 encoding=${payload.encoding} size=${payload.size} lines=${payload.line_count} contentCR=${(content.match(/\r/g) || []).length} contentLF=${(content.match(/\n/g) || []).length}`,
  );
}

const clone = mkdtempSync(join(tmpdir(), "crlf-clone-"));
const cloned = await git(["clone", "--quiet", `http://127.0.0.1:3000/${username}/crlf.git`, clone], { allowFailure: true });
console.log(`\n=== 3. clone round trip (exit=${cloned.exitCode}) ===`);
if (cloned.exitCode !== 0) {
  console.log(`  clone failed: ${(cloned.stderr ?? "").trim().slice(0, 200)}`);
} else {
  for (const name of ["crlf.txt", "lf.txt", "mixed.txt"]) {
    const bPath = join(clone, name);
    if (!existsSync(bPath)) {
      console.log(`  ${name.padEnd(11)} MISSING from clone`);
      continue;
    }
    const b = readFileSync(bPath);
    const a = original[name]!;
    console.log(
      `  ${name.padEnd(11)} local ${a.length}B CR=${crCount(a)} | clone ${b.length}B CR=${crCount(b)} | identical=${b.equals(a)}`,
    );
  }
}

console.log("\n=== 4. GET /archive?format=zip ===");
const zipRes = await fetch(`${BASE}/api/repos/${username}/crlf/archive?format=zip&ref=main`, { headers: new Headers({ cookie }) });
const zipBuf = Buffer.from(await zipRes.arrayBuffer());
const isZip = zipBuf[0] === 0x50 && zipBuf[1] === 0x4b;
console.log(`  HTTP ${zipRes.status} bytes=${zipBuf.length} isZip=${isZip}`);
if (isZip) {
  const dir = mkdtempSync(join(tmpdir(), "crlf-zip-"));
  const zipPath = join(dir, "a.zip");
  const outDir = join(dir, "x");
  writeFileSync(zipPath, zipBuf);
  const un = Bun.spawnSync(["tar", "-xf", zipPath, "-C", dir]);
  if (un.exitCode !== 0) {
    console.log(`  extraction failed (${un.exitCode}): ${un.stderr.toString().slice(0, 120)}`);
    console.log(`  archive kept at ${zipPath}`);
  } else {
    let found = "";
    const walk = (d: string): void => {
      for (const e of readdirSync(d)) {
        const p = join(d, e);
        if (statSync(p).isDirectory()) walk(p);
        else if (e === "crlf.txt") found = p;
      }
    };
    walk(dir);
    if (found) {
      const b = readFileSync(found);
      const a = original["crlf.txt"]!;
      console.log(
        `  archived crlf.txt ${b.length}B CR=${crCount(b)} identical=${b.equals(a)} -> ${crCount(b) > 0 ? "CRLF PRESERVED" : "CRLF LOST"}`,
      );
    } else {
      console.log(`  crlf.txt not in the archive; extracted tree:`);
      for (const e of readdirSync(outDir).slice(0, 6)) console.log(`    ${e}`);
    }
  }
} else {
  console.log(`  body: ${zipBuf.toString("utf8").slice(0, 120)}`);
}

console.log("\n=== 5. GET /archive?format=tar.gz ===");
const tarRes = await fetch(`${BASE}/api/repos/${username}/crlf/archive?format=tar.gz&ref=main`, { headers: new Headers({ cookie }) });
const tarBuf = Buffer.from(await tarRes.arrayBuffer());
console.log(`  HTTP ${tarRes.status} bytes=${tarBuf.length} isGzip=${tarBuf[0] === 0x1f && tarBuf[1] === 0x8b}`);

console.log(`\nrepo: ${username}/crlf`);

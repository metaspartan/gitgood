import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";

const BASE = Bun.argv[2] ?? "http://127.0.0.1:3001";
const USERNAME = Bun.argv[3] ?? "demo";
const PASSWORD = "demo-password-123";
const REPO = "gitgood-demo";

const scratch = mkdtempSync(join(tmpdir(), "gg-png-"));
const work = join(scratch, "work");
const identity = ["-c", "user.name=Demo Author", "-c", "user.email=demo@example.com"];

async function git(args: string[], cwd: string): Promise<void> {
  const proc = Bun.spawn(["git", ...args], {
    cwd,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stderr, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
  if (code !== 0) throw new Error(`git ${args.join(" ")} failed: ${stderr.trim().split("\n")[0] ?? ""}`);
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const header = new Uint8Array(4);
  new DataView(header.buffer).setUint32(0, data.length);
  const typeBytes = new TextEncoder().encode(type);
  const body = new Uint8Array(typeBytes.length + data.length);
  body.set(typeBytes, 0);
  body.set(data, typeBytes.length);
  const crc = new Uint8Array(4);
  new DataView(crc.buffer).setUint32(0, crc32(body));
  const out = new Uint8Array(4 + body.length + 4);
  out.set(header, 0);
  out.set(body, 4);
  out.set(crc, 4 + body.length);
  return out;
}

function makePng(size: number): Uint8Array {
  const stride = size * 3 + 1;
  const raw = new Uint8Array(stride * size);

  for (let y = 0; y < size; y++) {
    let offset = y * stride;
    raw[offset++] = 0;
    for (let x = 0; x < size; x++) {
      const border = x < 4 || y < 4 || x >= size - 4 || y >= size - 4;
      const diagonal = Math.abs(x - y) < 5 || Math.abs(x + y - (size - 1)) < 5;
      const centre = x > size * 0.35 && x < size * 0.65 && y > size * 0.35 && y < size * 0.65;
      const checker = (Math.floor(x / 16) + Math.floor(y / 16)) % 2 === 0;

      let r: number;
      let g: number;
      let b: number;
      if (border) {
        r = 8; g = 10; b = 18;
      } else if (centre) {
        r = 240; g = 90; b = 70;
      } else if (diagonal) {
        r = 255; g = 255; b = 255;
      } else {
        r = checker ? 60 : 30;
        g = checker ? 130 : 80;
        b = checker ? 240 : 170;
      }

      raw[offset++] = r;
      raw[offset++] = g;
      raw[offset++] = b;
    }
  }

  const ihdr = new Uint8Array(13);
  const view = new DataView(ihdr.buffer);
  view.setUint32(0, size);
  view.setUint32(4, size);
  ihdr[8] = 8;
  ihdr[9] = 2;

  const parts = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", new Uint8Array(deflateSync(raw))),
    chunk("IEND", new Uint8Array(0)),
  ];
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let cursor = 0;
  for (const part of parts) {
    out.set(part, cursor);
    cursor += part.length;
  }
  return out;
}

async function main(): Promise<void> {
  const login = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: USERNAME, password: PASSWORD }),
  });
  const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  if (!cookie) throw new Error("could not authenticate");

  const tokenResponse = await fetch(`${BASE}/api/tokens`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ name: "png" }),
  });
  const token = ((await tokenResponse.json()) as { token: string }).token;

  const remote = `${BASE.replace("http://", `http://${USERNAME}:${token}@`)}/${USERNAME}/${REPO}.git`;
  mkdirSync(work, { recursive: true });
  await git(["init", "-q", "-b", "main"], work);
  await git(["remote", "add", "origin", remote], work);
  await git(["fetch", "-q", "origin", "main"], work);
  await git(["checkout", "-q", "-B", "main", "origin/main"], work);

  mkdirSync(join(work, "assets"), { recursive: true });
  writeFileSync(join(work, "assets", "logo.png"), makePng(128));
  await git(["add", "assets/logo.png"], work);
  await git([...identity, "commit", "-q", "-m", "Use a high-contrast test card for the image demo"], work);
  await git(["push", "-q", "origin", "main"], work);

  console.log("pushed high-contrast assets/logo.png (128x128)");
  rmSync(scratch, { recursive: true, force: true });
}

await main();

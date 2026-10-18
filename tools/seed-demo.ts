import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";

const BASE = Bun.argv[2] ?? "http://127.0.0.1:3000";
const USERNAME = Bun.argv[3] ?? "demo";
const PASSWORD = "demo-password-123";
const EMAIL = `${USERNAME}@example.com`;
const REPO = "gitgood-demo";

const scratch = mkdtempSync(join(tmpdir(), "gg-seed-"));
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
    for (let bit = 0; bit < 8; bit++) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const length = new Uint8Array(4);
  new DataView(length.buffer).setUint32(0, data.length);
  const typeBytes = new TextEncoder().encode(type);
  const body = new Uint8Array(typeBytes.length + data.length);
  body.set(typeBytes, 0);
  body.set(data, typeBytes.length);
  const crc = new Uint8Array(4);
  new DataView(crc.buffer).setUint32(0, crc32(body));
  const out = new Uint8Array(4 + body.length + 4);
  out.set(length, 0);
  out.set(body, 4);
  out.set(crc, 4 + body.length);
  return out;
}

function makePng(size: number): Uint8Array {
  const raw = new Uint8Array((size * 3 + 1) * size);
  let offset = 0;
  const centre = (size - 1) / 2;
  const maxDistance = Math.hypot(centre, centre);
  for (let y = 0; y < size; y++) {
    raw[offset++] = 0;
    for (let x = 0; x < size; x++) {
      const distance = Math.hypot(x - centre, y - centre) / maxDistance;
      const ring = Math.sin(distance * Math.PI * 3);
      raw[offset++] = Math.round(120 + 110 * ring * (1 - distance));
      raw[offset++] = Math.round(90 + 120 * (1 - distance));
      raw[offset++] = Math.round(200 - 120 * distance);
    }
  }

  const ihdr = new Uint8Array(13);
  const view = new DataView(ihdr.buffer);
  view.setUint32(0, size);
  view.setUint32(4, size);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const compressed = new Uint8Array(deflateSync(raw));

  const parts = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", compressed),
    pngChunk("IEND", new Uint8Array(0)),
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

const README = `# GitGood demo

A repository used to exercise the file viewer, diff viewer and blame view.

## What is here

- \`src/highlight.ts\` — a TypeScript file with comments, strings, numbers and keywords
- \`src/large.ts\` — a generated file that crosses the highlighting threshold
- \`assets/logo.png\` — a real PNG, rendered in the browser rather than shown as bytes
- \`assets/icon.svg\` — an SVG, served with an image content type
- \`scripts/build.sh\` — a shell script

## Viewing tips

1. Open a file to see line numbers and syntax highlighting.
2. Use **Blame** to see which commit last touched each line.
3. Open a commit from the **Commits** tab to see its unified diff.

\`\`\`bash
git clone http://localhost:3000/demo/gitgood-demo.git
\`\`\`

> Files over the highlighting threshold fall back to plain text with line
> numbers rather than blocking the page.
`;

const HIGHLIGHT_TS = `/**
 * A demonstration source file.
 *
 * It contains every construct the highlighter claims to handle, so a rendering
 * regression is visible rather than theoretical.
 */
import { readFile } from "node:fs/promises";

export interface Options {
  readonly traceId: string;
  retries?: number;
  verbose: boolean;
}

const MAX_ATTEMPTS = 3;
const BACKOFF_MS = 250;
const PATTERN = /^[a-z][a-z0-9-]*$/i;
const TEMPLATE = \`attempt \${MAX_ATTEMPTS} of three\`;

export class Loader {
  private attempts = 0;
  private readonly cache = new Map<string, string>();

  constructor(private readonly options: Options) {}

  /**
   * Loads a file, retrying on failure.
   * Block comments spanning lines must stay comments on every line.
   */
  async load(path: string): Promise<string> {
    const cached = this.cache.get(path);
    if (cached !== undefined) return cached;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        const contents = await readFile(path, "utf8");
        this.cache.set(path, contents);
        return contents;
      } catch (error) {
        // A single-quoted string with an escape and punctuation: 'don\\'t fail'
        this.attempts += 1;
        if (attempt === MAX_ATTEMPTS) {
          throw new Error(\`failed after \${attempt} attempts: \${String(error)}\`);
        }
        await new Promise((resolve) => setTimeout(resolve, BACKOFF_MS * 2 ** attempt));
      }
    }
    return "";
  }

  validate(value: string): boolean {
    return PATTERN.test(value) && value.length > 0;
  }

  get stats(): Record<string, number> {
    return { attempts: this.attempts, cached: this.cache.size, limit: MAX_ATTEMPTS };
  }
}

export function describe(options: Options): string {
  return options.verbose ? TEMPLATE : options.traceId;
}

export const singleton = new Loader({ traceId: "root", verbose: true });
`;

const BUILD_SH = `#!/usr/bin/env bash
# Build script used to exercise shell highlighting.
set -euo pipefail

readonly PROJECT_ROOT="\${PROJECT_ROOT:-$(cd "$(dirname "\${BASH_SOURCE[0]}")/.." && pwd)}"
OUTPUT_DIR="\${1:-dist}"

echo "building into $OUTPUT_DIR"

# Iterate over source files and copy them, reporting progress.
for file in "$PROJECT_ROOT"/src/*.ts; do
  name=$(basename "$file" .ts)
  if [[ -z "$name" ]]; then
    continue
  fi
  echo "  processing $name"
  mkdir -p "$OUTPUT_DIR/$name"
done

function cleanup() {
  local exit_code=$?
  rm -rf "$OUTPUT_DIR/tmp"
  exit "$exit_code"
}
trap cleanup EXIT

echo "done"
`;

const APP_JSON = `{
  "name": "gitgood-demo",
  "version": "1.0.0",
  "private": true,
  "scripts": {
    "build": "bun run build.ts",
    "test": "bun test"
  },
  "dependencies": {
    "typescript": "^5.7.0"
  }
}
`;

const ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="64" height="64">
  <rect width="64" height="64" rx="12" fill="#0b0e14"/>
  <circle cx="32" cy="32" r="18" fill="none" stroke="#4f8cff" stroke-width="4"/>
  <path d="M22 32h20M32 22v20" stroke="#3fb950" stroke-width="4" stroke-linecap="round"/>
</svg>
`;

const GUIDE_MD = `# Deployment guide

Added in the second commit so the diff view has an added file to show.

## Steps

1. Install the runtime.
2. Copy the environment file.
3. Start the service.

| Setting | Default |
| --- | --- |
| port | 3000 |
| workers | 1 |
`;

function largeFile(): string {
  const lines: string[] = [];
  lines.push("// Generated file: crosses the highlighting threshold on purpose.");
  lines.push("// The viewer must fall back to plain text with line numbers.");
  lines.push("");
  for (let i = 0; i < 3200; i++) {
    const kind = i % 4;
    if (kind === 0) lines.push(`export const value${i} = ${i};`);
    else if (kind === 1) lines.push(`// comment for entry ${i}`);
    else if (kind === 2) lines.push(`export function compute${i}(input: number): number {`);
    else lines.push(`  return input + ${i}; // trailing note`);
    if (kind === 2) lines.push("}");
  }
  return `${lines.join("\n")}\n`;
}

async function api<T>(
  path: string,
  options: { method?: string; body?: unknown; cookie?: string; token?: string } = {},
): Promise<T> {
  const headers: Record<string, string> = {};
  if (options.cookie) headers.cookie = options.cookie;
  if (options.token) headers.authorization = `Bearer ${options.token}`;
  if (options.body !== undefined) headers["content-type"] = "application/json";
  const response = await fetch(`${BASE}${path}`, {
    method: options.method ?? "GET",
    headers,
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${path} -> ${response.status} ${text.slice(0, 200)}`);
  return text ? (JSON.parse(text) as T) : (null as T);
}

async function main(): Promise<void> {
  const signup = await fetch(`${BASE}/api/auth/signup`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: USERNAME, email: EMAIL, password: PASSWORD }),
  });
  let cookie = (signup.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  if (!signup.ok) {
    const login = await fetch(`${BASE}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: USERNAME, password: PASSWORD }),
    });
    cookie = (login.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  }
  console.log(`signed in as ${USERNAME}`);

  const token = await api<{ token: string }>("/api/tokens", {
    method: "POST",
    body: { name: "seed" },
    cookie,
  });

  const existing = await api<{ items: Array<{ name: string }> }>("/api/repos", { cookie });
  if (!existing.items.some((repo) => repo.name === REPO)) {
    await api("/api/repos", {
      method: "POST",
      body: { name: REPO, description: "Demonstration repository for the file, diff and blame viewers" },
      cookie,
    });
    console.log(`created ${USERNAME}/${REPO}`);
  }

  const remote = `${BASE.replace("http://", `http://${USERNAME}:${token.token}@`)}/${USERNAME}/${REPO}.git`;
  mkdirSync(join(work, "src"), { recursive: true });
  mkdirSync(join(work, "assets"), { recursive: true });
  mkdirSync(join(work, "scripts"), { recursive: true });
  mkdirSync(join(work, "config"), { recursive: true });

  await git(["init", "-q", "-b", "main"], work);
  await git(["remote", "add", "origin", remote], work);

  writeFileSync(join(work, "README.md"), README);
  writeFileSync(join(work, "src", "highlight.ts"), HIGHLIGHT_TS);
  writeFileSync(join(work, "src", "large.ts"), largeFile());
  writeFileSync(join(work, "assets", "logo.png"), makePng(96));
  writeFileSync(join(work, "assets", "icon.svg"), ICON_SVG);
  writeFileSync(join(work, "scripts", "build.sh"), BUILD_SH);
  writeFileSync(join(work, "config", "app.json"), APP_JSON);
  writeFileSync(join(work, ".gitignore"), "node_modules/\ndist/\n*.log\n");
  await git(["add", "-A"], work);
  await git([...identity, "commit", "-q", "-m", "Add source, assets and scripts"], work);
  await git(["push", "-q", "-u", "origin", "main"], work);
  console.log("pushed initial commit");

  const modified = HIGHLIGHT_TS.replace(
    "const MAX_ATTEMPTS = 3;",
    "const MAX_ATTEMPTS = 5;\nconst JITTER_MS = 40;",
  ).replace(
    "export const singleton = new Loader({ traceId: \"root\", verbose: true });",
    `export const singleton = new Loader({ traceId: "root", verbose: true });

/** Added in the second commit, so the diff shows a new export. */
export function jitteredBackoff(attempt: number): number {
  return BACKOFF_MS * 2 ** attempt + Math.random() * JITTER_MS;
}`,
  );
  writeFileSync(join(work, "src", "highlight.ts"), modified);
  mkdirSync(join(work, "docs"), { recursive: true });
  writeFileSync(join(work, "docs", "guide.md"), GUIDE_MD);
  await git(["rm", "-q", "config/app.json"], work);
  await git(["mv", "scripts/build.sh", "scripts/release.sh"], work);
  await git(["add", "-A"], work);
  await git([...identity, "commit", "-q", "-m", "Add retry jitter, a docs guide, and rename the build script"], work);
  await git(["push", "-q", "origin", "main"], work);
  console.log("pushed second commit");

  writeFileSync(
    join(work, "src", "highlight.ts"),
    modified.replace("const BACKOFF_MS = 250;", "const BACKOFF_MS = 400;"),
  );
  await git(["add", "-A"], work);
  await git(
    [...identity, "commit", "-q", "-m", "Increase the backoff window"],
    work,
  );
  await git(["push", "-q", "origin", "main"], work);
  console.log("pushed third commit");

  const head = await git(["rev-parse", "HEAD"], work);
  void head;
  console.log(`\ndone: ${BASE}/${USERNAME}/${REPO}`);
  rmSync(scratch, { recursive: true, force: true });
}

await main();

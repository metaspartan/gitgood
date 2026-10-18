import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BASE = Bun.argv[2] ?? "http://127.0.0.1:3000";

async function api<T>(
  path: string,
  options: { method?: string; body?: unknown; cookie?: string; token?: string } = {},
): Promise<{ status: number; data: T; bytes: number; ms: number }> {
  const headers: Record<string, string> = {};
  if (options.cookie) headers.cookie = options.cookie;
  if (options.token) headers.authorization = `Bearer ${options.token}`;
  if (options.body !== undefined) headers["content-type"] = "application/json";
  const started = performance.now();
  const response = await fetch(`${BASE}${path}`, {
    method: options.method ?? "GET",
    headers,
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
  });
  const text = await response.text();
  const ms = performance.now() - started;
  return {
    status: response.status,
    data: (text ? JSON.parse(text) : null) as T,
    bytes: Buffer.byteLength(text),
    ms,
  };
}

const kb = (bytes: number): string => `${(bytes / 1024).toFixed(1)} KiB`;

async function main(): Promise<void> {
  const name = `listbench${Date.now().toString(36)}`;
  const signup = await fetch(`${BASE}/api/auth/signup`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: name, email: `${name}@bench.local`, password: "benchpassword1" }),
  });
  const cookie = (signup.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  const issued = await api<{ token: string }>("/api/tokens", { method: "POST", body: { name: "bench" }, cookie });
  const token = issued.data.token;
  await api("/api/repos", { method: "POST", body: { name: "lists" }, cookie });

  const BODY_SIZE = 8 * 1024;
  const bigBody = "x".repeat(BODY_SIZE);
  const ISSUES = 10;
  console.log(`seeding ${ISSUES} issues with ${kb(BODY_SIZE)} bodies each`);
  for (let i = 0; i < ISSUES; i++) {
    await api(`/api/repos/${name}/lists/issues`, {
      method: "POST",
      body: { title: `Large issue ${i}`, body: bigBody },
      cookie,
    });
  }

  console.log("\n--- issue list payload ---");
  const list = await api<{ items: Array<{ body?: string; body_preview?: string }>; total: number }>(
    `/api/repos/${name}/lists/issues?state=open`,
  );
  const storedBytes = BODY_SIZE * ISSUES;
  const listed = list.data.items.length;
  const previewBytes = list.data.items.reduce((sum, item) => sum + (item.body_preview?.length ?? 0), 0);

  console.log(`  rows returned:            ${listed}`);
  console.log(`  stored body bytes:        ${kb(storedBytes)}`);
  console.log(`  list response:            ${kb(list.bytes)}`);
  console.log(`  preview bytes in list:    ${kb(previewBytes)}`);
  console.log(`  reduction vs bodies:      ${((1 - list.bytes / (storedBytes + list.bytes)) * 100).toFixed(1)}%`);
  console.log(`  request time:             ${list.ms.toFixed(1)} ms`);
  console.log(`  bodies present in list:   ${list.data.items.filter((item) => item.body !== undefined).length}`);

  const detail = await api<{ body: string }>(`/api/repos/${name}/lists/issues/1`);
  console.log(`  detail still has body:    ${detail.data.body.length === BODY_SIZE}`);

  console.log("\n--- archive download ---");
  const scratch = mkdtempSync(join(tmpdir(), "gg-listbench-"));
  const work = join(scratch, "w");
  mkdirSync(join(work, "src"), { recursive: true });
  const git = async (args: string[]): Promise<void> => {
    const proc = Bun.spawn(["git", ...args], { cwd: work, stdout: "pipe", stderr: "pipe" });
    const code = await proc.exited;
    if (code !== 0) throw new Error(`git ${args.join(" ")} failed: ${await new Response(proc.stderr).text()}`);
  };
  const remote = `${BASE.replace("http://", `http://${name}:${token}@`)}/${name}/lists.git`;
  await git(["init", "-q", "-b", "main"]);
  await git(["remote", "add", "origin", remote]);
  for (let file = 0; file < 40; file++) {
    writeFileSync(join(work, "src", `file-${file}.txt`), `contents of file ${file}\n${"y".repeat(400)}\n`);
  }
  await git(["add", "."]);
  await git(["-c", "user.name=B", "-c", "user.email=b@e.io", "commit", "-q", "-m", "seed"]);
  await git(["push", "-q", "origin", "main"]);

  for (const format of ["tar.gz", "zip"] as const) {
    const started = performance.now();
    const response = await fetch(`${BASE}/api/repos/${name}/lists/archive?ref=main&format=${format}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    const bytes = new Uint8Array(await response.arrayBuffer());
    const ms = performance.now() - started;
    console.log(
      `  ${format.padEnd(7)} status=${response.status} bytes=${kb(bytes.byteLength)} ms=${ms.toFixed(1)} ` +
        `type=${response.headers.get("content-type")} disposition=${response.headers.get("content-disposition")}`,
    );
  }

  rmSync(scratch, { recursive: true, force: true });
  console.log("\ndone");
}

await main();

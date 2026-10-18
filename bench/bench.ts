import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const argv = Bun.argv.slice(2);
const flag = (name: string): boolean => argv.includes(`--${name}`);
const option = (name: string, fallback: number): number => {
  const index = argv.indexOf(`--${name}`);
  if (index === -1) return fallback;
  const value = Number.parseInt(argv[index + 1] ?? "", 10);
  return Number.isFinite(value) ? value : fallback;
};

const QUICK = flag("quick");
const DURATION_MS = option("duration", QUICK ? 1200 : 3000);
const CONCURRENCY = option("concurrency", 32);
const REPO_COUNT = option("repos", 25);
const SEED_COMMITS = option("commits", 25);
const SEED_FILES = option("files", 40);

interface ServerStats {
  counts: Record<string, number>;
  lfs: { objects: number; bytes: number };
  counters: Record<string, number>;
  histograms: Record<string, { count: number; avg: number; p50: number; p90: number; p99: number }>;
  process: {
    rssBytes: number;
    heapUsedBytes: number;
    cpuPercent: number;
    cpuUserMs: number;
    cpuSystemMs: number;
    uptimeSeconds: number;
    eventLoopLagMs: number;
  };
}

interface ScenarioResult {
  name: string;
  requests: number;
  errors: number;
  rps: number;
  p50: number;
  p90: number;
  p99: number;
  max: number;
  cpuUserMs: number;
  cpuSystemMs: number;
  cpuCorePercent: number;
  rssDeltaBytes: number;
  bytesTransferred: number;
}

interface GitBenchmark {
  name: string;
  runs: number;
  concurrency: number;
  totalMs: number;
  perOperationMs: number;
}

const root = dirname(import.meta.dir);
const runId = new Date().toISOString().replace(/[:.]/g, "-");
const dataDir = mkdtempSync(join(tmpdir(), "gitgood-bench-"));
const scratch = mkdtempSync(join(tmpdir(), "gitgood-bench-scratch-"));
const PORT = 3400 + Math.floor(Math.random() * 200);
const BASE = `http://127.0.0.1:${PORT}`;

const results: ScenarioResult[] = [];

const serverRef: { current: Bun.Subprocess<"ignore", "pipe", "pipe"> | null } = { current: null };

const log = (message: string): void => {
  process.stdout.write(`${message}\n`);
};

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] ?? 0;
}

async function serverStats(): Promise<ServerStats> {
  const response = await fetch(`${BASE}/api/stats`);
  if (!response.ok) throw new Error(`/api/stats returned ${response.status}`);
  return (await response.json()) as ServerStats;
}

async function waitForHealth(timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const response = await fetch(`${BASE}/api/health`);
      if (response.ok) return;
    } catch {
    }
    if (Date.now() > deadline) {
      const running = serverRef.current;
      const stderr = running ? await new Response(running.stderr).text() : "";
      throw new Error(`server did not become healthy\n${stderr}`);
    }
    await Bun.sleep(150);
  }
}

let token = "";
let username = "";
const mainRepo = "main";
let issueCount = 0;
const lfsPayload = new Uint8Array(1024 * 1024);
for (let i = 0; i < lfsPayload.length; i++) lfsPayload[i] = i % 251;
const lfsOid = new Bun.CryptoHasher("sha256").update(lfsPayload).digest("hex");

async function seed(): Promise<void> {
  const name = `bench${Date.now().toString(36)}`;
  const signup = await fetch(`${BASE}/api/auth/signup`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: name, email: `${name}@bench.local`, password: "benchpassword1" }),
  });
  const cookie = (signup.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  username = name;

  const tokenResponse = await fetch(`${BASE}/api/tokens`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ name: "bench" }),
  });
  token = ((await tokenResponse.json()) as { token: string }).token;

  const create = (path: string, body: unknown): Promise<Response> =>
    fetch(`${BASE}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify(body),
    });

  log(`seeding ${REPO_COUNT} repositories ...`);
  await create("/api/repos", { name: mainRepo, description: "benchmark repository" });
  for (let i = 0; i < REPO_COUNT - 1; i++) {
    await create("/api/repos", { name: `repo-${i}`, description: `benchmark repository ${i}` });
  }

  log(`seeding ${SEED_COMMITS} commits x ${SEED_FILES} files into ${username}/${mainRepo} ...`);
  const work = join(scratch, "seed");
  mkdirSync(work, { recursive: true });
  const git = async (args: string[]): Promise<void> => {
    const proc = Bun.spawn(["git", ...args], { cwd: work, stdout: "pipe", stderr: "pipe" });
    const code = await proc.exited;
    if (code !== 0) {
      throw new Error(`git ${args.join(" ")} failed: ${await new Response(proc.stderr).text()}`);
    }
  };
  const remote = `${BASE.replace("http://", `http://${username}:${token}@`)}/${username}/${mainRepo}.git`;
  await git(["init", "-q", "-b", "main"]);
  await git(["remote", "add", "origin", remote]);
  mkdirSync(join(work, "src"), { recursive: true });
  for (let commit = 0; commit < SEED_COMMITS; commit++) {
    for (let file = 0; file < SEED_FILES; file++) {
      writeFileSync(
        join(work, "src", `file-${file}.txt`),
        `commit ${commit} file ${file}\n${"x".repeat(200)}\n`,
      );
    }
    writeFileSync(join(work, "README.md"), `# main\n\ncommit ${commit}\n`);
    await git(["add", "."]);
    await git([
      "-c",
      "user.name=Bench",
      "-c",
      "user.email=bench@local",
      "commit",
      "-q",
      "-m",
      `commit ${commit}`,
    ]);
  }
  await git(["push", "-q", "origin", "main"]);
  await git(["tag", "v1.0.0"]);
  await git(["push", "-q", "origin", "v1.0.0"]);

  log("seeding 100 issues ...");
  for (let i = 0; i < 100; i++) {
    const response = await create(`/api/repos/${username}/${mainRepo}/issues`, {
      title: `Seeded issue ${i}`,
      body: `Body for issue ${i}`,
    });
    if (response.ok) issueCount += 1;
  }

  log("seeding one 1 MiB LFS object ...");
  const batch = await fetch(`${BASE}/${username}/${mainRepo}.git/info/lfs/objects/batch`, {
    method: "POST",
    headers: { "content-type": "application/vnd.git-lfs+json", authorization: `Bearer ${token}` },
    body: JSON.stringify({
      operation: "upload",
      transfers: ["basic"],
      objects: [{ oid: lfsOid, size: lfsPayload.length }],
    }),
  });
  const action = (await batch.json()) as { objects: Array<{ actions?: { upload?: { href: string } } }> };
  const href = action.objects[0]?.actions?.upload?.href;
  if (href) {
    await fetch(href, { method: "PUT", headers: { authorization: `Bearer ${token}` }, body: lfsPayload });
  }
}

interface LoadOptions {
  name: string;
  path: string;
  method?: string;
  body?: unknown;
  headers?: Record<string, string>;
  concurrency?: number;
  durationMs?: number;
  iterations?: number;
  dynamic?: () => { path: string; body: Uint8Array };
  binary?: boolean;
}

async function load(options: LoadOptions): Promise<ScenarioResult> {
  const concurrency = options.concurrency ?? CONCURRENCY;
  const durationMs = options.durationMs ?? DURATION_MS;

  const build = (): { url: string; init: RequestInit } => {
    const dynamic = options.dynamic?.();
    const headers: Record<string, string> = { ...(options.headers ?? {}) };
    let body: BodyInit | undefined;
    if (dynamic?.body) {
      body = dynamic.body as unknown as BodyInit;
    } else if (options.body !== undefined) {
      headers["content-type"] = "application/json";
      body = JSON.stringify(options.body);
    }
    return {
      url: `${BASE}${dynamic?.path ?? options.path}`,
      init: { method: options.method ?? "GET", headers, ...(body !== undefined ? { body } : {}) },
    };
  };

  const warm = build();
  await fetch(warm.url, warm.init).catch(() => undefined);

  const before = await serverStats();
  const latencies: number[] = [];
  let requests = 0;
  let errors = 0;
  let bytes = 0;
  const startedAt = performance.now();
  const deadline = startedAt + durationMs;

  const worker = async (): Promise<void> => {
    while (performance.now() < deadline) {
      if (options.iterations !== undefined && requests >= options.iterations) return;
      const request = build();
      const requestStarted = performance.now();
      try {
        const response = await fetch(request.url, request.init);
        if (options.binary) {
          bytes += (await response.arrayBuffer()).byteLength;
        } else {
          bytes += (await response.text()).length;
        }
        if (!response.ok) errors += 1;
      } catch {
        errors += 1;
      }
      requests += 1;
      if (latencies.length < 200_000) latencies.push(performance.now() - requestStarted);
    }
  };

  await Promise.all(Array.from({ length: concurrency }, worker));
  const wallMs = performance.now() - startedAt;
  const after = await serverStats();

  const sorted = latencies.sort((a, b) => a - b);
  const cpuMs = after.process.cpuUserMs + after.process.cpuSystemMs;

  const result: ScenarioResult = {
    name: options.name,
    requests,
    errors,
    rps: Math.round((requests / wallMs) * 1000),
    p50: Math.round(percentile(sorted, 50) * 100) / 100,
    p90: Math.round(percentile(sorted, 90) * 100) / 100,
    p99: Math.round(percentile(sorted, 99) * 100) / 100,
    max: Math.round((sorted[sorted.length - 1] ?? 0) * 100) / 100,
    cpuUserMs: after.process.cpuUserMs,
    cpuSystemMs: after.process.cpuSystemMs,
    cpuCorePercent: Math.round((cpuMs / wallMs) * 10000) / 100,
    rssDeltaBytes: after.process.rssBytes - before.process.rssBytes,
    bytesTransferred: bytes,
  };
  results.push(result);
  log(
    `  ${result.name.padEnd(24)} ${String(result.rps).padStart(7)} req/s  ` +
      `p50 ${String(result.p50).padStart(6)}ms  p99 ${String(result.p99).padStart(8)}ms  ` +
      `cpu ${String(result.cpuCorePercent).padStart(6)}%  err ${result.errors}`,
  );
  return result;
}

async function gitBenchmark(
  name: string,
  runs: number,
  concurrency: number,
  buildArgs: (target: string) => string[],
): Promise<GitBenchmark> {
  const targets: string[] = [];
  for (let i = 0; i < runs; i++) targets.push(join(scratch, `${name}-${i}`));

  const started = performance.now();
  let index = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const current = index++;
      const target = targets[current];
      if (!target) return;
      const proc = Bun.spawn(["git", ...buildArgs(target)], {
        cwd: scratch,
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
        stdout: "pipe",
        stderr: "pipe",
      });
      const code = await proc.exited;
      if (code !== 0) {
        const stderr = await new Response(proc.stderr).text();
        log(`    (git ${name} failed: ${stderr.trim().split("\n")[0] ?? ""})`);
      }
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
  const totalMs = performance.now() - started;
  return {
    name,
    runs,
    concurrency,
    totalMs: Math.round(totalMs),
    perOperationMs: Math.round((totalMs / runs) * 100) / 100,
  };
}

async function main(): Promise<void> {
  mkdirSync(join(root, "bench", "results"), { recursive: true });

  log(`starting server on port ${PORT}`);
  const child = Bun.spawn(["bun", "src/server.ts"], {
    cwd: root,
    env: {
      ...process.env,
      NODE_ENV: "production",
      GITGOOD_PORT: String(PORT),
      GITGOOD_HOST: "127.0.0.1",
      GITGOOD_DATA_DIR: dataDir,
      GITGOOD_BASE_URL: BASE,
      GITGOOD_LOG_LEVEL: "error",
      GITGOOD_RATE_MAX: "1000000",
      GITGOOD_DB_PATH: join(dataDir, "bench.db"),
      GITGOOD_REPO_ROOT: join(dataDir, "repositories"),
      GITGOOD_LFS_ROOT: join(dataDir, "lfs"),
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  serverRef.current = child;

  await waitForHealth();
  const idle = await serverStats();
  log(`server healthy - ${(idle.process.rssBytes / 1024 / 1024).toFixed(1)} MiB RSS idle\n`);

  await seed();
  const seeded = await serverStats();
  const seededUptime = seeded.process.uptimeSeconds;

  log("\nHTTP benchmarks");
  await load({ name: "GET /api/health", path: "/api/health" });
  await load({ name: "GET /api/repos", path: "/api/repos" });
  await load({ name: "GET repo detail", path: `/api/repos/${username}/${mainRepo}` });
  await load({ name: "GET tree", path: `/api/repos/${username}/${mainRepo}/tree`, concurrency: 16 });
  await load({ name: "GET commits", path: `/api/repos/${username}/${mainRepo}/commits`, concurrency: 16 });
  await load({
    name: "GET blob",
    path: `/api/repos/${username}/${mainRepo}/blob?path=src/file-0.txt`,
    concurrency: 16,
  });
  await load({ name: "GET issues", path: `/api/repos/${username}/${mainRepo}/issues?state=all` });
  await load({ name: "GET search", path: "/api/search?q=Seeded", concurrency: 16 });
  await load({
    name: "POST issue",
    path: `/api/repos/${username}/${mainRepo}/issues`,
    method: "POST",
    body: { title: "benchmark issue", body: "created by the benchmark harness" },
    headers: { authorization: `Bearer ${token}` },
    concurrency: 8,
  });
  await load({ name: "GET /api/stats", path: "/api/stats", concurrency: 8 });
  await load({
    name: "PUT LFS 1 MiB (new)",
    path: "/unused",
    method: "PUT",
    headers: { authorization: `Bearer ${token}` },
    iterations: 40,
    concurrency: 4,
    dynamic: () => {
      const payload = new Uint8Array(1024 * 1024);
      crypto.getRandomValues(payload.subarray(0, 64 * 1024));
      const oid = new Bun.CryptoHasher("sha256").update(payload).digest("hex");
      return { path: `/${username}/${mainRepo}.git/info/lfs/objects/${oid}`, body: payload };
    },
  });
  await load({
    name: "PUT LFS dedupe hit",
    path: `/${username}/${mainRepo}.git/info/lfs/objects/${lfsOid}`,
    method: "PUT",
    headers: { authorization: `Bearer ${token}` },
    iterations: 200,
    concurrency: 8,
    dynamic: () => ({
      path: `/${username}/${mainRepo}.git/info/lfs/objects/${lfsOid}`,
      body: lfsPayload,
    }),
  });
  await load({
    name: "GET LFS 1 MiB",
    path: `/${username}/${mainRepo}.git/info/lfs/objects/${lfsOid}`,
    headers: { authorization: `Bearer ${token}` },
    iterations: 120,
    concurrency: 8,
  });
  await load({ name: "GET / (SPA)", path: "/", concurrency: 8, durationMs: 1500 });
  await load({
    name: "GET archive tar.gz",
    path: `/${username}/${mainRepo}/archive?ref=main&format=tar.gz`,
    headers: { authorization: `Bearer ${token}` },
    binary: true,
    iterations: 40,
    concurrency: 4,
  });
  await load({
    name: "GET archive zip",
    path: `/${username}/${mainRepo}/archive?ref=main&format=zip`,
    headers: { authorization: `Bearer ${token}` },
    binary: true,
    iterations: 40,
    concurrency: 4,
  });

  const afterHttp = await serverStats();

  log("\ngit protocol benchmarks");
  const shallow = await gitBenchmark("shallow-clone", 5, 1, (target) => [
    "clone",
    "-q",
    "--depth",
    "1",
    `${BASE}/${username}/${mainRepo}.git`,
    target,
  ]);
  log(`  5 sequential shallow clones:  ${shallow.perOperationMs} ms/op`);
  const full = await gitBenchmark("full-clone", 5, 1, (target) => [
    "clone",
    "-q",
    `${BASE}/${username}/${mainRepo}.git`,
    target,
  ]);
  log(`  5 sequential full clones:     ${full.perOperationMs} ms/op`);
  const parallel = await gitBenchmark("parallel-clones", 16, 8, (target) => [
    "clone",
    "-q",
    "--depth",
    "1",
    `${BASE}/${username}/${mainRepo}.git`,
    target,
  ]);
  log(`  16 shallow clones (c=8):      ${parallel.totalMs} ms total, ${parallel.perOperationMs} ms/op`);

  const final = await serverStats();

  const report = {
    runId,
    environment: {
      bun: Bun.version,
      platform: `${process.platform} ${process.arch}`,
      cpus: navigator.hardwareConcurrency,
    },
    configuration: {
      durationMs: DURATION_MS,
      concurrency: CONCURRENCY,
      repos: REPO_COUNT,
      commits: SEED_COMMITS,
      filesPerCommit: SEED_FILES,
      issues: issueCount,
    },
    memory: {
      idleRssBytes: idle.process.rssBytes,
      afterSeedRssBytes: seeded.process.rssBytes,
      afterHttpLoadRssBytes: afterHttp.process.rssBytes,
      finalRssBytes: final.process.rssBytes,
      heapUsedBytes: final.process.heapUsedBytes,
      eventLoopLagMs: final.process.eventLoopLagMs,
    },
    serverCounts: {
      repos: final.counts.repos,
      issues: final.counts.issues,
      users: final.counts.users,
      lfsObjects: final.lfs.objects,
      lfsBytes: final.lfs.bytes,
      uptimeSeconds: final.process.uptimeSeconds,
      seededUptimeSeconds: seededUptime,
    },
    scenarios: results,
    git: { shallow, full, parallel },
    serverHistograms: final.histograms,
    serverCounters: final.counters,
  };

  writeFileSync(join(root, "bench", "results", `${runId}.json`), JSON.stringify(report, null, 2));
  writeFileSync(join(root, "bench", "results", "latest.json"), JSON.stringify(report, null, 2));

  log("\n--- summary ---");
  log(`idle RSS:           ${(report.memory.idleRssBytes / 1024 / 1024).toFixed(1)} MiB`);
  log(`RSS after seeding:  ${(report.memory.afterSeedRssBytes / 1024 / 1024).toFixed(1)} MiB`);
  log(`RSS after load:     ${(report.memory.finalRssBytes / 1024 / 1024).toFixed(1)} MiB`);
  log(`event loop lag:     ${report.memory.eventLoopLagMs} ms`);
  log(`results written to: bench/results/${runId}.json`);

  child.kill();
  await child.exited;
  rmSync(scratch, { recursive: true, force: true });
  rmSync(dataDir, { recursive: true, force: true });
}

try {
  await main();
} catch (error) {
  log(`benchmark failed: ${error instanceof Error ? error.message : String(error)}`);
  serverRef.current?.kill();
  process.exit(1);
}

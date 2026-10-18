import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

interface Stats {
  process: { rssBytes: number; heapUsedBytes: number };
}

const root = join(import.meta.dir, "..");

async function measure(label: string, webDist: string | null): Promise<void> {
  const dataDir = mkdtempSync(join(tmpdir(), "gg-mem-"));
  const port = 3900 + Math.floor(Math.random() * 90);
  const env: Record<string, string> = {
    ...process.env as Record<string, string>,
    NODE_ENV: "production",
    GITGOOD_PORT: String(port),
    GITGOOD_HOST: "127.0.0.1",
    GITGOOD_DATA_DIR: dataDir,
    GITGOOD_LOG_LEVEL: "error",
    GITGOOD_RATE_MAX: "1000000",
    GITGOOD_WEB_DIST: webDist ?? join(dataDir, "no-prebuilt-here"),
  };

  const child = Bun.spawn(["bun", "src/server.ts"], { cwd: root, env, stdout: "pipe", stderr: "pipe" });

  const deadline = Date.now() + 20_000;
  for (;;) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (response.ok) break;
    } catch {
    }
    if (Date.now() > deadline) {
      child.kill();
      throw new Error(`${label}: server never became healthy`);
    }
    await Bun.sleep(100);
  }

  const stats = async (): Promise<Stats> => (await (await fetch(`http://127.0.0.1:${port}/api/stats`)).json()) as Stats;
  const mb = (bytes: number): string => `${(bytes / 1024 / 1024).toFixed(1)} MiB`;

  const idle = await stats();
  const firstStarted = performance.now();
  await fetch(`http://127.0.0.1:${port}/`).then((r) => r.text());
  const firstPageMs = performance.now() - firstStarted;
  const afterShell = await stats();
  for (let i = 0; i < 50; i++) await fetch(`http://127.0.0.1:${port}/owner/repo/tree/main`).then((r) => r.text());
  const afterBurst = await stats();

  console.log(`${label}`);
  console.log(`  idle:            ${mb(idle.process.rssBytes)}  (heap ${mb(idle.process.heapUsedBytes)})`);
  console.log(`  first page:      ${firstPageMs.toFixed(1)} ms`);
  console.log(`  after one page:  ${mb(afterShell.process.rssBytes)}`);
  console.log(`  after 50 pages:  ${mb(afterBurst.process.rssBytes)}`);

  child.kill();
  await child.exited;
  rmSync(dataDir, { recursive: true, force: true });
}

await measure("runtime bundle (dev / no prebuilt)", null);
await measure("prebuilt bundle (production image)", join(root, "dist", "web"));

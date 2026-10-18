import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { json, jsonFor } from "../../lib/http.ts";
import type { Router } from "../router.ts";
import { config } from "../../config.ts";
import { one, scalar } from "../../db/index.ts";
import { allCounters, allHistograms, processStats, increment, renderPrometheus } from "../../lib/metrics.ts";
import { storeStats } from "../../lfs/store.ts";
import { cacheStats } from "../../lib/cache.ts";
import { gitVersion } from "../../git/run.ts";

const startedAt = Date.now();

export function registerSystemRoutes(router: Router): void {
  router.get("/api/health", (ctx) => {
    const dbOk = (scalar<number>("SELECT 1") ?? 0) === 1;
    return jsonFor(
      ctx.request,
      {
        status: dbOk ? "ok" : "degraded",
        version: "1.0.0",
        uptime_seconds: Math.round((Date.now() - startedAt) / 1000),
        database: dbOk ? "ok" : "error",
      },
      { status: dbOk ? 200 : 503 },
    );
  });

  router.get("/api/ready", async (ctx) => {
    const checks: Array<{ name: string; ok: boolean; detail: string }> = [];

    const dbStarted = performance.now();
    let dbOk = false;
    let dbDetail = "unavailable";
    try {
      dbOk = (scalar<number>("SELECT 1") ?? 0) === 1;
      dbDetail = dbOk ? `${Math.round(performance.now() - dbStarted)} ms` : "query returned no rows";
    } catch (error) {
      dbDetail = error instanceof Error ? error.message : "query failed";
    }
    checks.push({ name: "database", ok: dbOk, detail: dbDetail });

    for (const [name, dir] of [
      ["data_dir", config.dataDir],
      ["repo_root", config.repoRoot],
      ["lfs_root", config.lfsRoot],
    ] as const) {
      let ok = false;
      let detail = "missing";
      try {
        const probe = join(dir, `.ready-${process.pid}`);
        writeFileSync(probe, "ok");
        rmSync(probe, { force: true });
        ok = true;
        detail = "writable";
      } catch (error) {
        detail = error instanceof Error ? error.message : "not writable";
      }
      checks.push({ name, ok, detail });
    }

    const gitStarted = performance.now();
    let gitOk = false;
    let gitDetail = "unavailable";
    try {
      gitDetail = await gitVersion();
      gitOk = gitDetail.includes("git version");
      if (gitOk) gitDetail = `${gitDetail.replace("git version ", "")} (${Math.round(performance.now() - gitStarted)} ms)`;
    } catch (error) {
      gitDetail = error instanceof Error ? error.message : "git failed";
    }
    checks.push({ name: "git", ok: gitOk, detail: gitDetail });

    const ready = checks.every((check) => check.ok);
    return jsonFor(ctx.request, { ready, checks }, { status: ready ? 200 : 503 });
  });

  router.get("/api/version", async (ctx) => {
    const git = await gitVersion().catch(() => "unavailable");
    return jsonFor(ctx.request, {
      version: "1.0.0",
      bun: Bun.version,
      git,
      runtime: `${process.platform}/${process.arch}`,
    });
  });

  router.get("/api/metrics", (ctx) => {
    increment("metrics_scrapes_total");
    return new Response(renderPrometheus(), {
      headers: { "content-type": "text/plain; version=0.0.4; charset=utf-8" },
    });
    void ctx;
  });

  router.get("/api/stats", () => {
    const users = scalar<number>("SELECT COUNT(*) FROM users") ?? 0;
    const repos = scalar<number>("SELECT COUNT(*) FROM repos") ?? 0;
    const issues = scalar<number>("SELECT COUNT(*) FROM issues") ?? 0;
    const pulls = scalar<number>("SELECT COUNT(*) FROM pulls") ?? 0;
    const rowCount = one<{ tables: number }>(
      "SELECT COUNT(*) AS tables FROM sqlite_master WHERE type = 'table'",
    );
    return json({
      counts: { users, repos, issues, pulls, tables: rowCount?.tables ?? 0 },
      lfs: storeStats(),
      cache: cacheStats(),
      git_concurrency: config.gitConcurrency,
      counters: allCounters(),
      histograms: allHistograms(),
      process: processStats(),
      uptime_seconds: Math.round((Date.now() - startedAt) / 1000),
    });
  });
}

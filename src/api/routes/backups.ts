import { themeById } from "../../web/themes.ts";
import { one, changes } from "../../db/index.ts";
import { collectInstanceMetrics } from "../../data/instance-metrics.ts";
import { repositoryDefaultQuota, setRepositoryDefaultQuota } from "../../data/instance-settings.ts";
import { ciRunnerStatus } from "../../ci/policy.ts";
import { schedulerStats } from "../../ci/scheduler.ts";
import { countPendingRuns } from "../../ci/store.ts";
import { config } from "../../config.ts";
import { join } from "node:path";
import { requireAdmin, type Principal } from "../../auth/service.ts";
import { recordAudit } from "../../data/audit.ts";
import { badRequest, conflict, forbidden } from "../../lib/errors.ts";
import { json, readJson } from "../../lib/http.ts";
import { parseBackupDestinations } from "../../lib/backup-destinations.ts";
import * as v from "../../lib/validate.ts";
import type { RouteContext, Router } from "../router.ts";

interface BackupJob {
  id: string;
  destination: string;
  state: "running" | "completed" | "failed";
  started: number;
  finished: number | null;
}
const jobs: BackupJob[] = [];
let active = false;

function authorize(ctx: RouteContext): Principal {
  if (ctx.request.headers.has("authorization")) throw forbidden("Use an administrator browser session");
  const principal = requireAdmin(ctx.auth);
  if (principal.via !== "session") throw forbidden("Use an administrator browser session");
  return principal;
}

export function registerBackupRoutes(router: Router): void {
  const appearance = () => {
    const stored = one<{theme:string}>("SELECT theme FROM instance_appearance WHERE id=1");
    return { theme: themeById(stored?.theme)?.id ?? "midnight" };
  };
  router.get("/api/appearance", () => json(appearance(), { headers: { "cache-control": "no-store" } }));
  router.put("/api/admin/appearance", async ctx => {
    const admin = authorize(ctx);
    const body = await readJson(ctx.request, v.strictObject({ theme: v.string({ min: 1, max: 40 }) }));
    if (!themeById(body.theme)) throw badRequest("Unknown theme");
    recordAudit(admin, "appearance.theme", body.theme, "", ctx.ip);
    changes("INSERT INTO instance_appearance(id,theme) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET theme=excluded.theme", body.theme);
    return json(appearance());
  });

  router.get("/api/admin/metrics", ctx => {
    authorize(ctx);
    return json(collectInstanceMetrics(), { headers: { "cache-control": "no-store" } });
  });

  router.get("/api/admin/storage-policy", ctx => {
    authorize(ctx);
    return json(repositoryDefaultQuota());
  });
  router.put("/api/admin/storage-policy", async ctx => {
    const admin = authorize(ctx);
    const body = await readJson(ctx.request, v.strictObject({ default_repo_quota_bytes: v.number({ int: true, min: 0, max: 1024 ** 5 }) }));
    setRepositoryDefaultQuota(body.default_repo_quota_bytes);
    recordAudit(admin, "storage.default_quota", "instance", `${body.default_repo_quota_bytes} bytes`, ctx.ip);
    return json(repositoryDefaultQuota());
  });

  router.get("/api/admin/runner", ctx => {
    authorize(ctx);
    return json({ runner: ciRunnerStatus(), ...schedulerStats(), pending: countPendingRuns() });
  });
  router.get("/api/admin/backups", ctx => {
    authorize(ctx);
    let destinations;
    try { destinations = parseBackupDestinations(process.env.GITGOOD_BACKUP_DESTINATIONS); }
    catch { throw badRequest("Backup configuration is invalid; check the server environment"); }
    return json({ configuration: {
      signup: config.allowSignup, repositoryCreation: config.allowRepoCreation,
      secureCookies: config.env === "production" || config.baseUrl.startsWith("https"),
      sshConfigured: Boolean(config.sshCommand), privateWebhooks: config.webhookAllowPrivate,
      maxRepoBytes: repositoryDefaultQuota().bytes, maxLfsBytes: config.maxLfsObjectBytes,
      maxBodyBytes: config.maxJsonBodyBytes,
      gitConcurrency: config.gitConcurrency, requestLimit: config.rateLimitMax, requestWindowMs: config.rateLimitWindowMs,
       indexFiles: config.codeIndexMaxFiles,
      indexFileBytes: config.codeIndexMaxFileBytes,
    }, destinations: destinations.map(({ id, name, kind }) => ({ id, name, kind })), jobs, active });
  });
  router.post("/api/admin/backups", async ctx => {
    authorize(ctx);
    const body = await readJson(ctx.request, v.strictObject({ destination: v.string({ min: 1, max: 40 }) }));
    let destinations;
    try { destinations = parseBackupDestinations(process.env.GITGOOD_BACKUP_DESTINATIONS); }
    catch { throw badRequest("Backup configuration is invalid"); }
    if (!destinations.some(d => d.id === body.destination)) throw badRequest("Unknown backup destination");
    if (active) throw conflict("A backup is already running");
    active = true;
    const job: BackupJob = { id: `backup-${crypto.randomUUID()}`, destination: body.destination, state: "running", started: Date.now(), finished: null };
    jobs.unshift(job);
    jobs.splice(20);
    try {
      const child = Bun.spawn([process.execPath, join(import.meta.dir, "../../../tools/backup-job.ts"), body.destination, job.id], {
        env: process.env, stdout: "ignore", stderr: "ignore",
      });
      void child.exited.then(code => { job.state = code === 0 ? "completed" : "failed"; })
        .catch(() => { job.state = "failed"; })
        .finally(() => { job.finished = Date.now(); active = false; });
    } catch {
      job.state = "failed";
      job.finished = Date.now();
      active = false;
    }
    return json(job, { status: 202 });
  });
}

import { themeById } from "../../web/themes.ts";
import { one, changes } from "../../db/index.ts";
import { collectInstanceMetrics } from "../../data/instance-metrics.ts";
import { instanceSettings, repositoryDefaultQuota, setRepositoryDefaultQuota } from "../../data/instance-settings.ts";
import { ciRunnerStatus } from "../../ci/policy.ts";
import { schedulerStats } from "../../ci/scheduler.ts";
import { countPendingRuns } from "../../ci/store.ts";
import { config } from "../../config.ts";
import { requireAdmin, type Principal } from "../../auth/service.ts";
import { recordAudit } from "../../data/audit.ts";
import { badRequest, conflict, forbidden, notFound } from "../../lib/errors.ts";
import { json, readJson } from "../../lib/http.ts";
import { MAX_BACKUP_DESTINATIONS } from "../../lib/backup-destinations.ts";
import {
  createDestination,
  deleteDestination,
  findDestination,
  lastJobs,
  listDestinations,
  listJobs,
  nextSlot,
  updateDestination,
  type BackupJobRow,
  type StoredDestination,
} from "../../data/backups.ts";
import { isBackupRunning, startBackupJob, testDestination } from "../../data/backup-jobs.ts";
import { param } from "../helpers.ts";
import * as v from "../../lib/validate.ts";
import type { RouteContext, Router } from "../router.ts";

const destinationSchema = v.strictObject({
  id: v.string({ min: 1, max: 40 }),
  name: v.string({ min: 1, max: 80 }),
  kind: v.enumOf(["local", "nas", "google-drive"] as const),
  target: v.string({ min: 1, max: 1024 }),
  schedule: v.optional(v.enumOf(["manual", "daily", "weekly"] as const)),
  hour: v.optional(v.number({ int: true, min: 0, max: 23 })),
  weekday: v.optional(v.number({ int: true, min: 0, max: 6 })),
  keep: v.optional(v.number({ int: true, min: 0, max: 365 })),
});

const destinationPatchSchema = v.strictObject({
  name: v.optional(v.string({ min: 1, max: 80 })),
  kind: v.optional(v.enumOf(["local", "nas", "google-drive"] as const)),
  target: v.optional(v.string({ min: 1, max: 1024 })),
  schedule: v.optional(v.enumOf(["manual", "daily", "weekly"] as const)),
  hour: v.optional(v.number({ int: true, min: 0, max: 23 })),
  weekday: v.optional(v.number({ int: true, min: 0, max: 6 })),
  keep: v.optional(v.number({ int: true, min: 0, max: 365 })),
});

function attempt<T>(action: () => T): T {
  try {
    return action();
  } catch (error) {
    if (error instanceof Error && !("status" in error)) throw badRequest(error.message);
    throw error;
  }
}

function destinationJson(destination: StoredDestination, last: BackupJobRow | undefined) {
  return {
    id: destination.id,
    name: destination.name,
    kind: destination.kind,
    source: destination.source,
    ...(destination.source === "admin" ? { target: destination.target } : {}),
    schedule: destination.schedule,
    hour: destination.hour,
    weekday: destination.weekday,
    keep: destination.keep,
    next_run_at: nextSlot(destination, Date.now()),
    last_job: last ? { id: last.id, state: last.state, started_at: last.started_at, finished_at: last.finished_at, error: last.error } : null,
  };
}

function loadDestination(ctx: RouteContext): StoredDestination {
  const destination = findDestination(param(ctx, "id"));
  if (!destination) throw notFound("Destination not found");
  return destination;
}

function configurationJson() {
  return {
    signup: instanceSettings().allowSignup, repositoryCreation: instanceSettings().allowRepoCreation,
    secureCookies: config.env === "production" || config.baseUrl.startsWith("https"),
    sshConfigured: Boolean(config.sshCommand), privateWebhooks: config.webhookAllowPrivate,
    maxRepoBytes: repositoryDefaultQuota().bytes, maxLfsBytes: config.maxLfsObjectBytes,
    maxBodyBytes: config.maxJsonBodyBytes,
    gitConcurrency: config.gitConcurrency, requestLimit: config.rateLimitMax, requestWindowMs: config.rateLimitWindowMs,
    indexFiles: config.codeIndexMaxFiles,
    indexFileBytes: config.codeIndexMaxFileBytes,
  };
}

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
  router.get("/api/admin/configuration", ctx => {
    authorize(ctx);
    return json({ configuration: configurationJson() });
  });

  router.get("/api/admin/backups", ctx => {
    authorize(ctx);
    const last = lastJobs();
    return json({
      configuration: configurationJson(),
      destinations: listDestinations().map((destination) => destinationJson(destination, last.get(destination.id))),
      jobs: listJobs(50).map(({ location, ...job }) => ({ ...job, location: findDestination(job.destination_id)?.source === "admin" ? location : null })),
      active: isBackupRunning(),
      timezone: "UTC",
      max_destinations: MAX_BACKUP_DESTINATIONS,
    });
  });

  router.post("/api/admin/backups", async ctx => {
    const admin = authorize(ctx);
    const body = await readJson(ctx.request, v.strictObject({ destination: v.string({ min: 1, max: 40 }) }));
    const destination = findDestination(body.destination);
    if (!destination) throw badRequest("Unknown backup destination");
    if (isBackupRunning()) throw conflict("A backup is already running");
    const job = startBackupJob(destination, "manual");
    recordAudit(admin, "backup.run", destination.id, "", ctx.ip);
    return json({ id: job.id, destination: destination.id, state: "running" }, { status: 202 });
  });

  router.post("/api/admin/backups/destinations", async ctx => {
    const admin = authorize(ctx);
    const body = await readJson(ctx.request, destinationSchema);
    const created = attempt(() => createDestination({ ...body, schedule: body.schedule ?? "manual", hour: body.hour ?? 3, weekday: body.weekday ?? 0, keep: body.keep ?? 7 }));
    recordAudit(admin, "backup.destination_create", created.id, `${created.kind} ${created.schedule}`, ctx.ip);
    return json(destinationJson(created, undefined), { status: 201 });
  });

  router.patch("/api/admin/backups/destinations/:id", async ctx => {
    const admin = authorize(ctx);
    const current = loadDestination(ctx);
    const body = await readJson(ctx.request, destinationPatchSchema);
    const updated = attempt(() => updateDestination(current.id, body));
    recordAudit(admin, "backup.destination_update", updated.id, Object.keys(body).join(", "), ctx.ip);
    return json(destinationJson(updated, lastJobs().get(updated.id)));
  });

  router.delete("/api/admin/backups/destinations/:id", ctx => {
    const admin = authorize(ctx);
    const current = loadDestination(ctx);
    if (current.source === "environment") throw conflict("This destination is defined by the server environment; remove it from GITGOOD_BACKUP_DESTINATIONS");
    deleteDestination(current.id);
    recordAudit(admin, "backup.destination_delete", current.id, "", ctx.ip);
    return new Response(null, { status: 204 });
  });

  router.post("/api/admin/backups/destinations/:id/test", async ctx => {
    authorize(ctx);
    return json(await testDestination(loadDestination(ctx)));
  });
}

import { requireInstanceAdmin } from "../../auth/service.ts";
import { ciUsesRunners } from "../../ci/policy.ts";
import {
  appendRunnerLog,
  authenticateRunner,
  claimNextRun,
  completeRunnerRun,
  createRunner,
  deleteRunner,
  heartbeatRun,
  listRunners,
  runnerOwnsRun,
  setRunnerPaused,
  sweepStaleRunnerJobs,
  type RunnerRow,
} from "../../ci/runners.ts";
import { readWorkflowAt } from "../../ci/scheduler.ts";
import { parseWorkflow } from "../../ci/workflow.ts";
import { findRepoById, repoDiskPath } from "../../data/repos.ts";
import { archiveStream } from "../../git/archive.ts";
import { notFound, unauthorized } from "../../lib/errors.ts";
import { json, readJson } from "../../lib/http.ts";
import * as v from "../../lib/validate.ts";
import { param, positiveId } from "../helpers.ts";
import { recordAudit } from "../../data/audit.ts";
import type { RouteContext, Router } from "../router.ts";

export const RUNNER_STEP_TIMEOUT_MS = 60 * 60_000;

const createSchema = v.strictObject({ name: v.string({ min: 1, max: 80 }) });
const pauseSchema = v.strictObject({ paused: v.boolean() });
const claimSchema = v.strictObject({ version: v.optional(v.string({ max: 40 })) });
const logSchema = v.strictObject({ lines: v.array(v.string({ max: 20_000, trim: false }), { max: 500 }) });
const finishSchema = v.strictObject({
  status: v.enumOf(["success", "failure"] as const),
  exit_code: v.optional(v.nullable(v.number({ int: true, min: -1, max: 255 }))),
});

function runnerFor(ctx: RouteContext, version: string | null = null): RunnerRow {
  const runner = authenticateRunner(ctx.request.headers.get("authorization"), ctx.ip, version);
  if (!runner) throw unauthorized("Invalid runner token");
  return runner;
}

function ownedRun(ctx: RouteContext, runner: RunnerRow) {
  const run = runnerOwnsRun(runner, positiveId(param(ctx, "id")));
  if (!run) throw notFound("No such running job for this runner");
  return run;
}

export function registerRunnerRoutes(router: Router): void {
  router.get("/api/admin/runners", (ctx) => {
    requireInstanceAdmin(ctx.auth, false);
    return json({ items: listRunners(), mode_uses_runners: ciUsesRunners() });
  });

  router.post("/api/admin/runners", async (ctx) => {
    const admin = requireInstanceAdmin(ctx.auth, true);
    const body = await readJson(ctx.request, createSchema);
    const created = createRunner(body.name, admin.userId);
    recordAudit(admin, "runner.register", body.name, `id ${created.runner.id}`, ctx.ip);
    return json({ runner: created.runner, token: created.token }, { status: 201 });
  });

  router.patch("/api/admin/runners/:id", async (ctx) => {
    const admin = requireInstanceAdmin(ctx.auth, true);
    const body = await readJson(ctx.request, pauseSchema);
    const runner = setRunnerPaused(positiveId(param(ctx, "id")), body.paused);
    if (!runner) throw notFound("Runner not found");
    recordAudit(admin, body.paused ? "runner.pause" : "runner.resume", runner.name, "", ctx.ip);
    return json({ runner });
  });

  router.delete("/api/admin/runners/:id", (ctx) => {
    const admin = requireInstanceAdmin(ctx.auth, true);
    const id = positiveId(param(ctx, "id"));
    if (!deleteRunner(id)) throw notFound("Runner not found");
    recordAudit(admin, "runner.remove", `#${id}`, "", ctx.ip);
    return new Response(null, { status: 204 });
  });

  router.post("/api/runner/claim", async (ctx) => {
    const body = await readJson(ctx.request, claimSchema);
    const runner = runnerFor(ctx, body.version ?? null);
    sweepStaleRunnerJobs();
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const run = claimNextRun(runner);
      if (!run) return new Response(null, { status: 204 });
      const repo = findRepoById(run.repo_id);
      const source = repo ? await readWorkflowAt(repoDiskPath(repo), run.sha) : null;
      const workflow = source === null ? null : (() => { try { return parseWorkflow(source); } catch { return null; } })();
      const job = workflow?.jobs.find((candidate) => candidate.id === run.job_id) ?? null;
      if (!repo || !workflow || !job) {
        appendRunnerLog(run.id, ["\u2717 The workflow or job no longer exists at this commit."]);
        completeRunnerRun(run.id, "failure", 1);
        continue;
      }
      appendRunnerLog(run.id, [`\u23F3 ${workflow.name} / ${job.name} \u2014 ${run.sha.slice(0, 8)} on ${run.ref_name} (runner ${runner.name})`]);
      return json({
        run_id: run.id,
        repository: `${repo.owner_username}/${repo.name}`,
        ref: run.ref_name,
        sha: run.sha,
        workflow: workflow.name,
        job: { id: job.id, name: job.name, runs_on: job.runsOn, steps: job.steps },
        step_timeout_ms: RUNNER_STEP_TIMEOUT_MS,
      });
    }
    return new Response(null, { status: 204 });
  });

  router.get("/api/runner/jobs/:id/source", async (ctx) => {
    const runner = runnerFor(ctx);
    const run = ownedRun(ctx, runner);
    const repo = findRepoById(run.repo_id);
    if (!repo) throw notFound("Repository no longer exists");
    heartbeatRun(run.id);
    const proc = await archiveStream({ cwd: repoDiskPath(repo), ref: run.sha, format: "tar.gz", prefix: "source" });
    return new Response(proc.stdout, {
      status: 200,
      headers: { "content-type": "application/gzip", "cache-control": "no-store" },
    });
  });

  router.post("/api/runner/jobs/:id/log", async (ctx) => {
    const runner = runnerFor(ctx);
    const run = ownedRun(ctx, runner);
    const body = await readJson(ctx.request, logSchema);
    return json(appendRunnerLog(run.id, body.lines));
  });

  router.post("/api/runner/jobs/:id/finish", async (ctx) => {
    const runner = runnerFor(ctx);
    const run = ownedRun(ctx, runner);
    const body = await readJson(ctx.request, finishSchema);
    completeRunnerRun(run.id, body.status, body.exit_code ?? null);
    return new Response(null, { status: 204 });
  });
}

import * as v from "../../lib/validate.ts";
import { badRequest, conflict, notFound, unprocessable } from "../../lib/errors.ts";
import { json, readJson } from "../../lib/http.ts";
import { GIT_REF_PATTERN } from "../../lib/ids.ts";
import { requireWrite } from "../../auth/service.ts";
import { loadReadableRepo, loadWritableRepo, param, requestedRef } from "../helpers.ts";
import type { Router } from "../router.ts";
import { listRunHistory, getRun, readLog, countPendingRuns } from "../../ci/store.ts";
import { ciEnabled, ciRunnerStatus } from "../../ci/policy.ts";
import { onlineRunnerCount } from "../../ci/runners.ts";
import { CI_FILE, parseWorkflow } from "../../ci/workflow.ts";
import { canWrite, repoDiskPath, type RepoRecord } from "../../data/repos.ts";
import { resolveRef } from "../../git/repo.ts";
import {
  enqueueJobs,
  manualDispatchJobs,
  MAX_CONCURRENT,
  MAX_PENDING,
  readWorkflowAt,
  schedulerStats,
} from "../../ci/scheduler.ts";

const dispatchSchema = v.strictObject({
  ref: v.string({ min: 1, max: 255, pattern: GIT_REF_PATTERN }),
});

function runId(raw: string): number {
  const id = /^[1-9]\d*$/.test(raw) ? Number(raw) : NaN;
  if (!Number.isSafeInteger(id)) throw badRequest("Invalid run ID");
  return id;
}

function logOffset(raw: string | null, fallback: number): number {
  if (raw === null) return fallback;
  const value = /^\d+$/.test(raw) ? Number(raw) : NaN;
  if (!Number.isSafeInteger(value)) throw badRequest("Invalid log pagination");
  return value;
}

function runnerPayload(repo: RepoRecord) {
  const runner = ciRunnerStatus();
  const stats = schedulerStats();
  return {
    mode: runner.mode,
    enabled: runner.enabled,
    isolation: runner.isolation,
    notice: runner.notice,
    runnersOnline: runner.mode === "runner" ? onlineRunnerCount(repo) : null,
    active: stats.active,
    queued: stats.queued,
    pending: countPendingRuns(),
    maxConcurrent: MAX_CONCURRENT,
    maxPending: MAX_PENDING,
  };
}

export function registerCiRoutes(router: Router): void {
  router.get("/api/repos/:owner/:name/ci/runs", (ctx) => {
    const repo = loadReadableRepo(ctx);
    const beforeRaw = ctx.url.searchParams.get("before");
    const before = beforeRaw === null ? null : runId(beforeRaw);
    const limit = Math.max(1, Math.min(logOffset(ctx.url.searchParams.get("limit"), 30), 100));
    const page = listRunHistory(repo.id, limit + 1, before);
    const runs = page.slice(0, limit);
    return json({
      items: runs,
      next_before: page.length > limit ? runs[runs.length - 1]!.id : null,
      can_write: canWrite(repo, ctx.auth),
      runner: runnerPayload(repo),
      scheduler: {
        active: schedulerStats().active,
        queued: schedulerStats().queued,
        pending: countPendingRuns(),
        maxConcurrent: MAX_CONCURRENT,
        maxPending: MAX_PENDING,
        started: schedulerStats().started,
        finished: schedulerStats().finished,
      },
    });
  });

  router.get("/api/repos/:owner/:name/ci/workflow", async (ctx) => {
    const repo = loadReadableRepo(ctx);
    const refName = requestedRef(ctx, repo.default_branch);
    const repoPath = repoDiskPath(repo);
    const sha = await resolveRef(repoPath, `refs/heads/${refName}`);
    if (!sha) return json({ error: { code: "not_found", message: "Branch not found" } }, { status: 404 });
    const source = await readWorkflowAt(repoPath, sha);
    const runner = ciRunnerStatus();
    if (source === null) {
      return json({
        path: CI_FILE,
        ref: refName,
        sha,
        present: false,
        jobs: [],
        triggers: [],
        warnings: [],
        can_dispatch: false,
        runner: {
          mode: runner.mode,
          enabled: runner.enabled,
          isolation: runner.isolation,
          notice: runner.notice,
        },
      });
    }
    let workflow;
    try {
      workflow = parseWorkflow(source);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      return json({
        path: CI_FILE,
        ref: refName,
        sha,
        present: true,
        name: "Workflow error",
        jobs: [],
        triggers: [],
        warnings: [message],
        can_dispatch: false,
        runner: {
          mode: runner.mode,
          enabled: runner.enabled,
          isolation: runner.isolation,
          notice: runner.notice,
        },
      });
    }
    const canDispatch =
      workflow.triggers.has("workflow_dispatch") &&
      workflow.warnings.length === 0 &&
      !workflow.parseError &&
      ciEnabled() && repo.actions_enabled !== 0 && canWrite(repo, ctx.auth);
    return json({
      path: CI_FILE,
      ref: refName,
      sha,
      present: true,
      name: workflow.name,
      jobs: workflow.jobs.map((job) => ({
        id: job.id,
        name: job.name,
        runsOn: job.runsOn,
        steps: job.steps.map((step) => ({ name: step.name })),
      })),
      triggers: [...workflow.triggers].sort(),
      warnings: workflow.warnings,
      inputs: [],
      can_dispatch: canDispatch,
      runner: {
        mode: runner.mode,
        enabled: runner.enabled,
        isolation: runner.isolation,
        notice: runner.notice,
      },
    });
  });

  router.post("/api/repos/:owner/:name/ci/dispatch", async (ctx) => {
    const repo = loadWritableRepo(ctx);
    requireWrite(ctx.auth);
    if (!ciEnabled() || repo.actions_enabled === 0) {
      throw conflict("Actions are disabled for this repository. No job was started.");
    }
    const body = await readJson(ctx.request, dispatchSchema);
    const repoPath = repoDiskPath(repo);
    const sha = await resolveRef(repoPath, `refs/heads/${body.ref}`);
    if (!sha) throw notFound("Branch not found");
    const source = await readWorkflowAt(repoPath, sha);
    if (source === null) throw unprocessable(`${CI_FILE} is not present at ${body.ref}`);
    let workflow;
    try {
      workflow = parseWorkflow(source);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      throw unprocessable(message);
    }
    const admitted = manualDispatchJobs(workflow);
    if (admitted.error || admitted.jobs.length === 0) {
      throw unprocessable(admitted.error ?? "workflow has no jobs");
    }
    const result = enqueueJobs(
      repo,
      sha,
      body.ref,
      admitted.jobs.map((job) => ({ job, workflow, event: "workflow_dispatch" as const })),
      null,
    );
    if (result.rejected) throw conflict(result.reason ?? "CI queue is full");
    return json({ items: result.accepted }, { status: 202 });
  });

  router.post("/api/repos/:owner/:name/ci/runs/:id/rerun", async (ctx) => {
    const repo = loadWritableRepo(ctx);
    requireWrite(ctx.auth);
    if (!ciEnabled() || repo.actions_enabled === 0) {
      throw conflict("Actions are disabled for this repository. No job was started.");
    }
    const id = runId(param(ctx, "id"));
    const run = getRun(id);
    if (!run || run.repo_id !== repo.id) throw notFound("Run not found");
    if (run.status === "queued" || run.status === "running") {
      throw conflict("Cannot rerun a run that is still active");
    }
    const repoPath = repoDiskPath(repo);
    const source = await readWorkflowAt(repoPath, run.sha);
    if (source === null) throw unprocessable(`${CI_FILE} is not present at ${run.sha}`);
    let workflow;
    try {
      workflow = parseWorkflow(source);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      throw unprocessable(message);
    }
    const job = workflow.jobs.find((candidate) => candidate.id === run.job_id);
    if (!job) throw unprocessable(`Job ${run.job_id} is not in the workflow at ${run.sha}`);
    if (workflow.warnings.length > 0 || workflow.parseError) {
      const reasons = workflow.parseError ? [workflow.parseError, ...workflow.warnings] : workflow.warnings;
      throw unprocessable(reasons.join("; "));
    }
    const result = enqueueJobs(
      repo,
      run.sha,
      run.ref_name,
      [{ job, workflow, event: "rerun" }],
      run.pull_id,
    );
    if (result.rejected) throw conflict(result.reason ?? "CI queue is full");
    return json({ items: result.accepted }, { status: 202 });
  });

  router.get("/api/repos/:owner/:name/ci/runs/:id", (ctx) => {
    const repo = loadReadableRepo(ctx);
    const id = runId(param(ctx, "id"));
    const run = getRun(id);
    if (!run || run.repo_id !== repo.id) {
      return json({ error: { code: "not_found", message: "Run not found" } }, { status: 404 });
    }
    return json(run);
  });

  router.get("/api/repos/:owner/:name/ci/runs/:id/log", (ctx) => {
    const repo = loadReadableRepo(ctx);
    const id = runId(param(ctx, "id"));
    const run = getRun(id);
    if (!run || run.repo_id !== repo.id) {
      return json({ error: { code: "not_found", message: "Run not found" } }, { status: 404 });
    }
    const after = logOffset(ctx.url.searchParams.get("after"), 0);
    const limit = Math.max(1, Math.min(logOffset(ctx.url.searchParams.get("limit"), 500), 2000));
    const lines = readLog(run.id, after, limit);
    return json({ items: lines, next: lines.length ? (lines[lines.length - 1]?.seq ?? 0) + 1 : after });
  });
}

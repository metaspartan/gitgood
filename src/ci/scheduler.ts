import type { RepoRecord } from "../data/repos.ts";
import { repoDiskPath } from "../data/repos.ts";
import { findOpenPullByHead } from "../data/pulls.ts";
import { ciEnabled, ciRunnerStatus, ciUsesRunners } from "./policy.ts";
import { runJob, type CiJobLike } from "./runner.ts";
import { appendLog, countPendingRuns, createRun, finishRun, getRun, type CiRunRow } from "./store.ts";
import { transaction } from "../db/index.ts";
import { CI_FILE, parseWorkflow, type CiJob, type CiWorkflow } from "./workflow.ts";
import { gitStdout } from "../git/run.ts";

export const MAX_CONCURRENT = 2;
export const MAX_PENDING = 20;

export type CiTriggerEvent = "push" | "workflow_dispatch" | "rerun";

export interface EnqueueJob {
  job: CiJobLike;
  workflow: CiWorkflow;
  event: CiTriggerEvent;
}

export interface EnqueueResult {
  accepted: CiRunRow[];
  rejected: boolean;
  reason?: string;
}

interface QueueItem {
  runId: number;
  repoId: number;
  workflow: CiWorkflow;
  job: CiJobLike;
  sha: string;
  refName: string;
  repoRoot: string;
  pullId: number | null;
  event: CiTriggerEvent;
}

type Worker = (item: QueueItem) => Promise<void>;

let active = 0;
const pending: QueueItem[] = [];
const waiters: Array<() => void> = [];
let workerOverride: Worker | null = null;
let started = 0;
let finished = 0;

function notify(): void {
  for (const waiter of waiters.splice(0)) waiter();
}

export function schedulerStats(): {
  active: number;
  queued: number;
  pending: number;
  maxConcurrent: number;
  maxPending: number;
  started: number;
  finished: number;
} {
  return {
    active,
    queued: pending.length,
    pending: active + pending.length,
    maxConcurrent: MAX_CONCURRENT,
    maxPending: MAX_PENDING,
    started,
    finished,
  };
}

export function resetSchedulerForTests(): void {
  active = 0;
  pending.length = 0;
  waiters.length = 0;
  workerOverride = null;
  started = 0;
  finished = 0;
}

export function setSchedulerWorkerForTests(worker: Worker | null): void {
  workerOverride = worker;
}

export function whenSchedulerIdle(): Promise<void> {
  if (active === 0 && pending.length === 0) return Promise.resolve();
  return new Promise((resolve) => {
    const check = (): void => {
      if (active === 0 && pending.length === 0) resolve();
      else waiters.push(check);
    };
    waiters.push(check);
  });
}

function workflowForEvent(workflow: CiWorkflow, event: CiTriggerEvent): CiWorkflow {
  const triggers = new Set(workflow.triggers);
  triggers.add(event === "rerun" ? "workflow_dispatch" : event);
  if (event === "push") triggers.add("push");
  return { ...workflow, triggers };
}

function isRunnable(entry: EnqueueJob): boolean {
  return entry.job.steps.length > 0 && entry.workflow.warnings.length === 0 && !entry.workflow.parseError;
}

export function enqueueJobs(
  repo: RepoRecord,
  sha: string,
  refName: string,
  jobs: EnqueueJob[],
  pullId: number | null,
): EnqueueResult {
  if (jobs.length === 0) return { accepted: [], rejected: false };
  const pendingCount = countPendingRuns();
  if (pendingCount + jobs.length > MAX_PENDING) {
    return {
      accepted: [],
      rejected: true,
      reason: `CI queue is full (${pendingCount} pending, limit ${MAX_PENDING}); refused ${jobs.length} job(s)`,
    };
  }
  const repoRoot = repoDiskPath(repo);
  const external = jobs.map((entry) => isRunnable(entry) && ciUsesRunners());
  const accepted = transaction(() => {
    const rows: CiRunRow[] = [];
    for (const [index, entry] of jobs.entries()) {
      const prepared = workflowForEvent(entry.workflow, entry.event);
      const runId = createRun({
        repo_id: repo.id,
        workflow_name: prepared.name,
        job_id: entry.job.id,
        ref_name: refName,
        sha,
        pull_id: pullId,
        executor: external[index] ? "runner" : "local",
      });
      const row = getRun(runId);
      if (!row) throw new Error("queued run was not persisted");
      rows.push(row);
    }
    return rows;
  });
  for (let i = 0; i < jobs.length; i++) {
    const entry = jobs[i];
    const row = accepted[i];
    if (!entry || !row || external[i]) continue;
    pending.push({
      runId: row.id,
      repoId: repo.id,
      workflow: workflowForEvent(entry.workflow, entry.event),
      job: entry.job,
      sha,
      refName,
      repoRoot,
      pullId,
      event: entry.event,
    });
  }
  pump();
  return { accepted, rejected: false };
}

function pump(): void {
  while (active < MAX_CONCURRENT && pending.length > 0) {
    const item = pending.shift();
    if (!item) break;
    active += 1;
    started += 1;
    let execution: Promise<void>;
    try { execution = workerOverride ? workerOverride(item) : defaultWorker(item); }
    catch (cause) { execution = Promise.reject(cause); }
    const run = execution.catch(() => {
      try { appendLog(item.runId, 4001, "CI worker failed unexpectedly"); }
      finally { finishRun(item.runId, "failure", 1); }
    });
    void run.catch(() => {}).finally(() => {
      active -= 1;
      finished += 1;
      notify();
      pump();
    });
  }
}

async function defaultWorker(item: QueueItem): Promise<void> {
  await runJob(
    item.repoId,
    item.workflow,
    item.job,
    item.sha,
    item.refName,
    item.repoRoot,
    item.pullId,
    item.runId,
  );
}

export async function readWorkflowAt(repoPath: string, ref: string): Promise<string | null> {
  const spec = `${ref}:${CI_FILE}`;
  const result = await gitStdout(["cat-file", "blob", spec], { cwd: repoPath });
  return result === "" ? null : result;
}

function parseFailureWorkflow(message: string): CiWorkflow {
  return {
    name: "Workflow error",
    triggers: new Set(["push"]),
    jobs: [],
    warnings: [],
    parseError: message,
  };
}

function blockedWorkflow(workflow: CiWorkflow): CiWorkflow {
  const status = ciRunnerStatus();
  const warnings = !ciEnabled()
    ? [`CI mode ${status.mode}: ${status.notice}`, ...workflow.warnings]
    : workflow.warnings;
  return { ...workflow, warnings, jobs: [] };
}

export async function admitPush(repo: RepoRecord, refName: string, sha: string): Promise<EnqueueResult> {
  if (repo.actions_enabled === 0) return { accepted: [], rejected: false };
  const repoPath = repoDiskPath(repo);
  const source = await readWorkflowAt(repoPath, sha);
  if (source === null) return { accepted: [], rejected: false };
  const openPull = findOpenPullByHead(repo.id, refName);
  const pullId = openPull ? openPull.id : null;
  let workflow: CiWorkflow;
  try {
    workflow = parseWorkflow(source);
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    const job: CiJobLike = { id: "parse", name: "Parse workflow", runsOn: "host", steps: [] };
    const workflow = parseFailureWorkflow(message);
    if (countPendingRuns() >= MAX_PENDING) return recordRejectedPush(repo, sha, refName, workflow, pullId, "queue full; invalid workflow");
    return enqueueJobs(repo, sha, refName, [{ job, workflow, event: "push" }], pullId);
  }
  if (!workflow.triggers.has("push")) return { accepted: [], rejected: false };
  if (!ciEnabled() || workflow.warnings.length > 0) {
    const job: CiJobLike = { id: "workflow", name: workflow.name, runsOn: "host", steps: [] };
    const blocked = blockedWorkflow(workflow);
    if (countPendingRuns() + 1 > MAX_PENDING) {
      return recordRejectedPush(repo, sha, refName, blocked, pullId, "queue full");
    }
    return enqueueJobs(repo, sha, refName, [{ job, workflow: blocked, event: "push" }], pullId);
  }
  const jobs = workflow.jobs.map((job) => ({ job, workflow, event: "push" as const }));
  const result = enqueueJobs(repo, sha, refName, jobs, pullId);
  if (result.rejected) return recordRejectedPush(repo, sha, refName, workflow, pullId, result.reason ?? "queue full");
  return result;
}

function recordRejectedPush(
  repo: RepoRecord,
  sha: string,
  refName: string,
  workflow: CiWorkflow,
  pullId: number | null,
  reason: string,
): EnqueueResult {
  const runId = createRun({
    repo_id: repo.id,
    workflow_name: workflow.name,
    job_id: "rejected",
    ref_name: refName,
    sha,
    pull_id: pullId,
  });
  finishRun(runId, "failure", 1);
  appendLog(runId, 1, `push rejected: ${reason}`);
  const row = getRun(runId);
  return { accepted: row ? [row] : [], rejected: true, reason };
}

export function manualDispatchJobs(workflow: CiWorkflow): { jobs: CiJob[]; error?: string } {
  if (!workflow.triggers.has("workflow_dispatch")) {
    return { jobs: [], error: "workflow does not opt in to workflow_dispatch" };
  }
  if (workflow.warnings.length > 0 || workflow.parseError) {
    const reasons = workflow.parseError ? [workflow.parseError, ...workflow.warnings] : workflow.warnings;
    return { jobs: [], error: reasons.join("; ") };
  }
  return { jobs: workflow.jobs };
}

import { transaction, all, db, now, one } from "../db/index.ts";

export type CiRunStatus = "queued" | "running" | "success" | "failure";

export interface CiRunRow {
  id: number;
  repo_id: number;
  workflow_name: string;
  job_id: string;
  ref_name: string;
  sha: string;
  pull_id: number | null;
  status: CiRunStatus;
  exit_code: number | null;
  started_at: number;
  finished_at: number | null;
}

export interface CreateCiRunInput {
  repo_id: number;
  workflow_name: string;
  job_id: string;
  ref_name: string;
  sha: string;
  pull_id?: number | null;
  executor?: "local" | "runner";
}

export function createRun(input: CreateCiRunInput): number {
  const result = db
    .prepare(
      `INSERT INTO ci_runs (repo_id, workflow_name, job_id, ref_name, sha, pull_id, status, started_at, executor)
       VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, ?)`,
    )
    .run(
      input.repo_id,
      input.workflow_name,
      input.job_id,
      input.ref_name,
      input.sha,
      input.pull_id ?? null,
      now(),
      input.executor ?? "local",
    );
  return Number(result.lastInsertRowid);
}

export function markRunRunning(id: number): void {
  db.prepare(`UPDATE ci_runs SET status = 'running' WHERE id = ?`).run(id);
}

export function finishRun(id: number, status: CiRunStatus, exitCode: number | null): void {
  db.prepare(`UPDATE ci_runs SET status = ?, exit_code = ?, finished_at = ? WHERE id = ?`).run(
    status,
    exitCode,
    now(),
    id,
  );
}

export function getRun(id: number): CiRunRow | null {
  return one<CiRunRow>(`SELECT * FROM ci_runs WHERE id = ?`, id);
}

export function countPendingRuns(): number {
  const row = one<{ n: number }>(
    `SELECT COUNT(*) AS n FROM ci_runs WHERE status IN ('queued', 'running')`,
  );
  return row?.n ?? 0;
}

export function listRunHistory(repoId: number, limit: number, before: number | null): CiRunRow[] {
  return before === null
    ? all<CiRunRow>("SELECT * FROM ci_runs WHERE repo_id = ? ORDER BY id DESC LIMIT ?", repoId, limit)
    : all<CiRunRow>("SELECT * FROM ci_runs WHERE repo_id = ? AND id < ? ORDER BY id DESC LIMIT ?", repoId, before, limit);
}

export function listRunsForRepo(repoId: number, limit = 30): CiRunRow[] {
  return all<CiRunRow>(
    `SELECT * FROM ci_runs WHERE repo_id = ? ORDER BY id DESC LIMIT ?`,
    repoId,
    limit,
  );
}

export function latestRunForSha(repoId: number, sha: string): CiRunRow | null {
  return one<CiRunRow>(
    `SELECT * FROM ci_runs WHERE repo_id = ? AND sha = ? ORDER BY id DESC LIMIT 1`,
    repoId,
    sha,
  );
}

export function latestRunForPull(repoId: number, pullId: number, sha: string | null): CiRunRow | null {
  if (sha === null) return null;
  const exact = one<CiRunRow>(
    `SELECT * FROM ci_runs WHERE repo_id = ? AND pull_id = ? AND sha = ? ORDER BY id DESC LIMIT 1`,
    repoId,
    pullId,
    sha,
  );
  if (exact) return exact;
  return one<CiRunRow>(
    `SELECT * FROM ci_runs WHERE repo_id = ? AND pull_id = ? ORDER BY id DESC LIMIT 1`,
    repoId,
    pullId,
  );
}

export function pullChecksStatus(
  repoId: number,
  pullId: number,
  sha: string | null,
  state: "open" | "closed" | "merged",
): { status: "success" | "failure" | "pending" | "neutral"; runId: number | null } {
  if (state !== "open" || sha === null) return { status: "neutral", runId: null };
  const run = latestRunForPull(repoId, pullId, sha);
  if (!run) return { status: "pending", runId: null };
  if (run.status === "success") return { status: "success", runId: run.id };
  if (run.status === "failure") return { status: "failure", runId: run.id };
  return { status: "pending", runId: run.id };
}

export interface HeadChecksVerdict {
  ok: boolean;
  reason: "no_checks" | "pending" | "failure" | "stale" | null;
  jobs: number;
}

export function headChecksVerdict(repoId: number, headSha: string): HeadChecksVerdict {
  const runs = all<CiRunRow>(
    `SELECT * FROM ci_runs WHERE id IN (SELECT MAX(id) FROM ci_runs WHERE repo_id = ? AND sha = ? GROUP BY workflow_name, job_id) ORDER BY id DESC`,
    repoId,
    headSha,
  );
  const latestByJob = new Map<string, CiRunRow>();
  for (const run of runs) {
    const key = JSON.stringify([run.workflow_name, run.job_id]);
    if (!latestByJob.has(key)) latestByJob.set(key, run);
  }
  if (latestByJob.size === 0) return { ok: false, reason: "no_checks", jobs: 0 };
  for (const run of latestByJob.values()) {
    if (run.status === "failure") return { ok: false, reason: "failure", jobs: latestByJob.size };
    if (run.status !== "success") return { ok: false, reason: "pending", jobs: latestByJob.size };
  }
  return { ok: true, reason: null, jobs: latestByJob.size };
}

export function listRunsForPull(repoId: number, pullId: number, limit = 20): CiRunRow[] {
  return all<CiRunRow>(
    `SELECT * FROM ci_runs WHERE repo_id = ? AND pull_id = ? ORDER BY id DESC LIMIT ?`,
    repoId,
    pullId,
    limit,
  );
}

export function appendLog(runId: number, seq: number, text: string): void {
  db.prepare(`INSERT INTO ci_run_logs (run_id, seq, text) VALUES (?, ?, ?)`).run(runId, seq, text);
}

export function readLog(runId: number, offset: number, limit: number): Array<{ seq: number; text: string }> {
  return all<{ seq: number; text: string }>(
    `SELECT seq, text FROM ci_run_logs WHERE run_id = ? AND seq >= ? ORDER BY seq ASC LIMIT ?`,
    runId,
    offset,
    limit,
  );
}

export function failInterruptedRuns(): number {
  return transaction(() => {
    const interrupted = all<{ id: number }>("SELECT id FROM ci_runs WHERE executor = 'local' AND status IN ('queued', 'running')");
    for (const run of interrupted) {
      const last = one<{ seq: number }>("SELECT COALESCE(MAX(seq), -1) AS seq FROM ci_run_logs WHERE run_id = ?", run.id);
      appendLog(run.id, (last?.seq ?? -1) + 1, "Job interrupted by server restart. No automatic retry was performed.");
      finishRun(run.id, "failure", 1);
    }
    return interrupted.length;
  });
}

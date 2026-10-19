import { randomBytes } from "node:crypto";
import { all, changes, now, one, run, transaction } from "../db/index.ts";
import { sha256Hex } from "../lib/ids.ts";
import { appendLog, finishRun, getRun, type CiRunRow } from "./store.ts";

export const RUNNER_TOKEN_PREFIX = "ggr_";
export const RUNNER_ONLINE_MS = 60_000;
export const RUNNER_STALE_JOB_MS = 15 * 60_000;
export const RUNNER_MAX_LOG_LINES = 4000;
export const RUNNER_MAX_LINE_CHARS = 2000;

export const MAX_SCOPED_RUNNERS = 20;

export type RunnerScope = { kind: "instance" } | { kind: "user"; userId: number } | { kind: "repo"; repoId: number };

export interface RunnerRow {
  id: number;
  name: string;
  scope: "instance" | "user" | "repo";
  owner_user_id: number | null;
  repo_id: number | null;
  token_hash: string;
  token_prefix: string;
  created_by: number | null;
  created_at: number;
  last_seen_at: number | null;
  last_ip: string | null;
  version: string | null;
  paused: number;
}

export interface RunnerSummary {
  id: number;
  name: string;
  token_prefix: string;
  created_at: number;
  last_seen_at: number | null;
  last_ip: string | null;
  version: string | null;
  paused: boolean;
  online: boolean;
  active_jobs: number;
  scope: "instance" | "user" | "repo";
  scope_label: string;
}

function scopeLabel(row: RunnerRow): string {
  if (row.scope === "user" && row.owner_user_id !== null) {
    return one<{ username: string }>("SELECT username FROM users WHERE id = ?", row.owner_user_id)?.username ?? "deleted user";
  }
  if (row.scope === "repo" && row.repo_id !== null) {
    const repo = one<{ owner: string; name: string }>(
      "SELECT COALESCE(o.name, u.username) AS owner, r.name FROM repos r JOIN users u ON u.id = r.owner_id LEFT JOIN orgs o ON o.id = r.org_id WHERE r.id = ?",
      row.repo_id,
    );
    return repo ? `${repo.owner}/${repo.name}` : "deleted repository";
  }
  return "All repositories";
}

function scopeWhere(scope: RunnerScope): { sql: string; args: number[] } {
  if (scope.kind === "user") return { sql: "scope = 'user' AND owner_user_id = ?", args: [scope.userId] };
  if (scope.kind === "repo") return { sql: "scope = 'repo' AND repo_id = ?", args: [scope.repoId] };
  return { sql: "scope = 'instance'", args: [] };
}

export function runnerSummary(row: RunnerRow, activeJobs = 0): RunnerSummary {
  return {
    id: row.id,
    name: row.name,
    scope: row.scope,
    scope_label: scopeLabel(row),
    token_prefix: row.token_prefix,
    created_at: row.created_at,
    last_seen_at: row.last_seen_at,
    last_ip: row.last_ip,
    version: row.version,
    paused: row.paused === 1,
    online: row.last_seen_at !== null && now() - row.last_seen_at < RUNNER_ONLINE_MS,
    active_jobs: activeJobs,
  };
}

export function listRunners(scope: RunnerScope | null = null): RunnerSummary[] {
  const active = new Map(
    all<{ runner_id: number; n: number }>(
      "SELECT runner_id, COUNT(*) AS n FROM ci_runs WHERE status = 'running' AND runner_id IS NOT NULL GROUP BY runner_id",
    ).map((r) => [r.runner_id, r.n]),
  );
  const filter = scope ? scopeWhere(scope) : null;
  const rows = filter
    ? all<RunnerRow>(`SELECT * FROM ci_runners WHERE ${filter.sql} ORDER BY id`, ...filter.args)
    : all<RunnerRow>("SELECT * FROM ci_runners ORDER BY id");
  return rows.map((row) => runnerSummary(row, active.get(row.id) ?? 0));
}

export function findScopedRunner(id: number, scope: RunnerScope): RunnerRow | null {
  const filter = scopeWhere(scope);
  return one<RunnerRow>(`SELECT * FROM ci_runners WHERE id = ? AND ${filter.sql}`, id, ...filter.args);
}

export function countScopedRunners(scope: RunnerScope): number {
  const filter = scopeWhere(scope);
  return one<{ n: number }>(`SELECT COUNT(*) AS n FROM ci_runners WHERE ${filter.sql}`, ...filter.args)?.n ?? 0;
}

export function onlineRunnerCount(repo: { id: number; owner_id: number; org_id: number | null } | null = null): number {
  const since = now() - RUNNER_ONLINE_MS;
  if (!repo) return one<{ n: number }>("SELECT COUNT(*) AS n FROM ci_runners WHERE paused = 0 AND last_seen_at >= ?", since)?.n ?? 0;
  return (
    one<{ n: number }>(
      `SELECT COUNT(*) AS n FROM ci_runners WHERE paused = 0 AND last_seen_at >= ?
         AND (scope = 'instance' OR (scope = 'repo' AND repo_id = ?) OR (scope = 'user' AND owner_user_id = ? AND ? = 1))`,
      since,
      repo.id,
      repo.owner_id,
      repo.org_id === null ? 1 : 0,
    )?.n ?? 0
  );
}

export function createRunner(name: string, createdBy: number | null, scope: RunnerScope = { kind: "instance" }): { runner: RunnerSummary; token: string } {
  const token = `${RUNNER_TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
  const id = run(
    "INSERT INTO ci_runners (name, token_hash, token_prefix, created_by, created_at, scope, owner_user_id, repo_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    name,
    sha256Hex(token),
    token.slice(0, 10),
    createdBy,
    now(),
    scope.kind,
    scope.kind === "user" ? scope.userId : null,
    scope.kind === "repo" ? scope.repoId : null,
  );
  const row = one<RunnerRow>("SELECT * FROM ci_runners WHERE id = ?", id);
  if (!row) throw new Error("runner was not persisted");
  return { runner: runnerSummary(row), token };
}

export function deleteRunner(id: number): boolean {
  return transaction(() => {
    for (const job of all<{ id: number }>("SELECT id FROM ci_runs WHERE runner_id = ? AND status = 'running'", id)) {
      failRunnerJob(job.id, "The runner was removed while this job was running.");
    }
    return changes("DELETE FROM ci_runners WHERE id = ?", id) > 0;
  });
}

export function setRunnerPaused(id: number, paused: boolean): RunnerSummary | null {
  changes("UPDATE ci_runners SET paused = ? WHERE id = ?", paused ? 1 : 0, id);
  const row = one<RunnerRow>("SELECT * FROM ci_runners WHERE id = ?", id);
  return row ? runnerSummary(row) : null;
}

export function authenticateRunner(header: string | null, ip: string, version: string | null): RunnerRow | null {
  if (!header) return null;
  const match = /^Bearer\s+(ggr_[A-Za-z0-9_-]{20,})$/.exec(header.trim());
  if (!match) return null;
  const row = one<RunnerRow>("SELECT * FROM ci_runners WHERE token_hash = ?", sha256Hex(match[1]!));
  if (!row) return null;
  changes("UPDATE ci_runners SET last_seen_at = ?, last_ip = ?, version = COALESCE(?, version) WHERE id = ?", now(), ip, version, row.id);
  return row;
}

function nextSeq(runId: number): number {
  return (one<{ seq: number }>("SELECT COALESCE(MAX(seq), -1) AS seq FROM ci_run_logs WHERE run_id = ?", runId)?.seq ?? -1) + 1;
}

function failRunnerJob(runId: number, message: string): void {
  appendLog(runId, nextSeq(runId), message);
  finishRun(runId, "failure", 1);
}

export function sweepStaleRunnerJobs(): number {
  const stale = all<{ id: number }>(
    "SELECT id FROM ci_runs WHERE executor = 'runner' AND status = 'running' AND COALESCE(heartbeat_at, started_at) < ?",
    now() - RUNNER_STALE_JOB_MS,
  );
  for (const job of stale) failRunnerJob(job.id, "Runner stopped reporting progress; job marked failed.");
  return stale.length;
}

export function claimNextRun(runner: RunnerRow): CiRunRow | null {
  if (runner.paused === 1) return null;
  return transaction(() => {
    const next =
      runner.scope === "repo"
        ? one<{ id: number }>("SELECT id FROM ci_runs WHERE executor = 'runner' AND status = 'queued' AND repo_id = ? ORDER BY id LIMIT 1", runner.repo_id ?? -1)
        : runner.scope === "user"
          ? one<{ id: number }>(
              `SELECT c.id FROM ci_runs c JOIN repos r ON r.id = c.repo_id
                WHERE c.executor = 'runner' AND c.status = 'queued' AND r.owner_id = ? AND r.org_id IS NULL
                ORDER BY c.id LIMIT 1`,
              runner.owner_user_id ?? -1,
            )
          : one<{ id: number }>("SELECT id FROM ci_runs WHERE executor = 'runner' AND status = 'queued' ORDER BY id LIMIT 1");
    if (!next) return null;
    const claimed = changes(
      "UPDATE ci_runs SET status = 'running', runner_id = ?, heartbeat_at = ? WHERE id = ? AND status = 'queued'",
      runner.id,
      now(),
      next.id,
    );
    return claimed === 1 ? getRun(next.id) : null;
  });
}

export function runnerOwnsRun(runner: RunnerRow, runId: number): CiRunRow | null {
  const row = one<CiRunRow & { runner_id: number | null }>("SELECT * FROM ci_runs WHERE id = ?", runId);
  if (!row || row.runner_id !== runner.id || row.status !== "running") return null;
  return row;
}

export function appendRunnerLog(runId: number, lines: readonly string[]): { accepted: number; truncated: boolean } {
  return transaction(() => {
    let seq = nextSeq(runId);
    let accepted = 0;
    let truncated = false;
    for (const raw of lines) {
      if (seq >= RUNNER_MAX_LOG_LINES) {
        if (seq === RUNNER_MAX_LOG_LINES) {
          appendLog(runId, seq, "\u2026 log truncated");
          seq += 1;
        }
        truncated = true;
        break;
      }
      const text = String(raw).replace(/\u001b\[[0-9;]*[A-Za-z]/g, "").slice(0, RUNNER_MAX_LINE_CHARS);
      appendLog(runId, seq, text);
      seq += 1;
      accepted += 1;
    }
    changes("UPDATE ci_runs SET heartbeat_at = ? WHERE id = ?", now(), runId);
    return { accepted, truncated };
  });
}

export function heartbeatRun(runId: number): void {
  changes("UPDATE ci_runs SET heartbeat_at = ? WHERE id = ?", now(), runId);
}

export function completeRunnerRun(runId: number, status: "success" | "failure", exitCode: number | null): void {
  finishRun(runId, status, exitCode);
}

import { all, now, run } from "../db/index.ts";
import { gitStdout } from "../git/run.ts";

const SHA = /^[0-9a-f]{40,64}$/;
const DAY_MS = 86_400_000;
export const CONTRIBUTION_DAYS = 371;

export async function countPushedCommits(
  repoPath: string,
  before: ReadonlyMap<string, string>,
  after: ReadonlyMap<string, string>,
): Promise<number> {
  const tips = [...new Set([...after.values()])].filter((sha) => SHA.test(sha) && ![...before.values()].includes(sha));
  if (tips.length === 0) return 0;
  const exclude = [...new Set(before.values())].filter((sha) => SHA.test(sha)).map((sha) => `^${sha}`);
  const output = await gitStdout(["rev-list", "--count", "--max-count=100000", "--stdin"], {
    cwd: repoPath,
    input: `${[...tips, ...exclude].join("\n")}\n`,
    timeoutMs: 30_000,
  });
  const count = Number.parseInt(output.trim(), 10);
  return Number.isFinite(count) ? count : 0;
}

export function recordPush(repoId: number, userId: number, commits: number): void {
  if (commits <= 0) return;
  run("INSERT INTO push_events (repo_id, user_id, commits, created_at) VALUES (?, ?, ?, ?)", repoId, userId, commits, now());
}

export interface ContributionDay {
  date: string;
  count: number;
}

export interface ContributionBreakdown {
  commits: number;
  issues: number;
  pulls: number;
  comments: number;
}

export function dayKey(timestamp: number, offsetMinutes: number): string {
  return new Date(timestamp + offsetMinutes * 60_000).toISOString().slice(0, 10);
}

export function contributionCalendar(
  userId: number,
  canReadRepo: (repoId: number) => boolean,
  offsetMinutes: number,
  at = now(),
): { days: ContributionDay[]; total: number; breakdown: ContributionBreakdown } {
  const since = at - CONTRIBUTION_DAYS * DAY_MS;
  const rows = all<{ kind: keyof ContributionBreakdown; repo_id: number; created_at: number; weight: number }>(
    `SELECT 'commits' AS kind, repo_id, created_at, commits AS weight FROM push_events WHERE user_id = ? AND created_at >= ?
     UNION ALL SELECT 'issues', repo_id, created_at, 1 FROM issues WHERE author_id = ? AND created_at >= ?
     UNION ALL SELECT 'pulls', repo_id, created_at, 1 FROM pulls WHERE author_id = ? AND created_at >= ?
     UNION ALL SELECT 'comments', repo_id, created_at, 1 FROM comments WHERE author_id = ? AND created_at >= ?`,
    userId, since, userId, since, userId, since, userId, since,
  );
  const readable = new Map<number, boolean>();
  const counts = new Map<string, number>();
  const breakdown: ContributionBreakdown = { commits: 0, issues: 0, pulls: 0, comments: 0 };
  for (const row of rows) {
    let ok = readable.get(row.repo_id);
    if (ok === undefined) {
      ok = canReadRepo(row.repo_id);
      readable.set(row.repo_id, ok);
    }
    if (!ok) continue;
    const key = dayKey(row.created_at, offsetMinutes);
    counts.set(key, (counts.get(key) ?? 0) + row.weight);
    breakdown[row.kind] += row.weight;
  }
  const days: ContributionDay[] = [];
  for (let i = CONTRIBUTION_DAYS - 1; i >= 0; i -= 1) {
    const key = dayKey(at - i * DAY_MS, offsetMinutes);
    days.push({ date: key, count: counts.get(key) ?? 0 });
  }
  const total = breakdown.commits + breakdown.issues + breakdown.pulls + breakdown.comments;
  return { days, total, breakdown };
}

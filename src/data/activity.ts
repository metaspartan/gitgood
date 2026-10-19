import { all, one } from "../db/index.ts";
import { cached } from "../lib/cache.ts";
import { git } from "../git/run.ts";
import { repoDiskPath, type RepoRecord } from "./repos.ts";

const DAY_MS = 86_400_000;
const MAX_COMMITS_PER_REPO = 50_000;
const MAX_REPOS_SCANNED = 300;
const COMMIT_CACHE_MS = 3_600_000;

export interface ContributionDay {
  date: string;
  count: number;
}

export interface ContributionBreakdown {
  commits: number;
  issues: number;
  pulls: number;
  comments: number;
  repositories: number;
  private: number;
}

export interface MonthActivity {
  month: string;
  commits: { repo: string; count: number }[];
  repositories: { repo: string; created_at: number }[];
  issues: { repo: string; count: number }[];
  pulls: { repo: string; count: number }[];
  private: number;
}

export interface ContributionReport {
  year: number | null;
  years: number[];
  from: string;
  to: string;
  days: ContributionDay[];
  total: number;
  breakdown: ContributionBreakdown;
  months: MonthActivity[];
  joined_at: number;
}

export function dayKey(timestamp: number, offsetMinutes: number): string {
  return new Date(timestamp + offsetMinutes * 60_000).toISOString().slice(0, 10);
}

function utcDay(key: string): number {
  return Date.parse(`${key}T00:00:00Z`);
}

function addDays(key: string, days: number): string {
  return new Date(utcDay(key) + days * DAY_MS).toISOString().slice(0, 10);
}

export function reportRange(year: number | null, offsetMinutes: number, at: number): { from: string; to: string } {
  if (year !== null) return { from: `${year}-01-01`, to: `${year}-12-31` };
  const today = dayKey(at, offsetMinutes);
  const weekday = new Date(utcDay(today)).getUTCDay();
  return { from: addDays(today, -weekday - 52 * 7), to: today };
}

export async function authoredCommitTimes(repo: RepoRecord, emails: readonly string[]): Promise<number[]> {
  if (emails.length === 0) return [];
  const normalized = [...new Set(emails.map((email) => email.toLowerCase()))].sort();
  const key = `activity:${repo.id}:${repo.updated_at}:${normalized.join(",")}`;
  return cached(key, COMMIT_CACHE_MS, async () => {
    try {
      const result = await git(
        ["log", "--all", "--fixed-strings", "--regexp-ignore-case", ...normalized.map((email) => `--author=<${email}>`), `--max-count=${MAX_COMMITS_PER_REPO}`, "--format=%at"],
        { cwd: repoDiskPath(repo), timeoutMs: 30_000 },
      );
      if (result.exitCode !== 0) return [];
      return result.stdout.split("\n").map((line) => Number(line) * 1000).filter((value) => Number.isFinite(value) && value > 0);
    } catch {
      return [];
    }
  });
}

export function contributedRepoIds(userId: number): number[] {
  return all<{ id: number }>(
    `SELECT r.id FROM repos r
      WHERE r.fork_of IS NULL AND (
        (r.owner_id = ? AND r.org_id IS NULL)
        OR r.id IN (SELECT repo_id FROM repo_collaborators WHERE user_id = ?)
        OR r.org_id IN (SELECT org_id FROM org_members WHERE user_id = ?)
      )
      ORDER BY r.updated_at DESC
      LIMIT ?`,
    userId,
    userId,
    userId,
    MAX_REPOS_SCANNED,
  ).map((row) => row.id);
}

interface ActivityEvent {
  kind: "commits" | "issues" | "pulls" | "comments" | "repositories";
  repo: string;
  at: number;
  hidden: boolean;
}

export interface ActivityInput {
  user: { id: number; created_at: number };
  emails: readonly string[];
  repos: RepoRecord[];
  hiddenRepoIds?: ReadonlySet<number>;
  year: number | null;
  offsetMinutes: number;
  at: number;
}

export async function contributionReport(input: ActivityInput): Promise<ContributionReport> {
  const { user, emails, repos, year, offsetMinutes, at } = input;
  const hidden = input.hiddenRepoIds ?? new Set<number>();
  const byId = new Map(repos.map((repo) => [repo.id, repo]));
  const fullName = (repo: RepoRecord) => `${repo.owner_username}/${repo.name}`;
  const events: ActivityEvent[] = [];

  const commitLists = await Promise.all(repos.map(async (repo) => ({ repo, times: await authoredCommitTimes(repo, emails) })));
  for (const { repo, times } of commitLists) for (const time of times) events.push({ kind: "commits", repo: fullName(repo), at: time, hidden: hidden.has(repo.id) });

  const ids = [...byId.keys()];
  if (ids.length > 0) {
    const placeholders = ids.map(() => "?").join(",");
    const rows = all<{ kind: ActivityEvent["kind"]; repo_id: number; created_at: number }>(
      `SELECT 'issues' AS kind, repo_id, created_at FROM issues WHERE author_id = ? AND repo_id IN (${placeholders})
       UNION ALL SELECT 'pulls', repo_id, created_at FROM pulls WHERE author_id = ? AND repo_id IN (${placeholders})
       UNION ALL SELECT 'comments', repo_id, created_at FROM comments WHERE author_id = ? AND repo_id IN (${placeholders})`,
      user.id, ...ids, user.id, ...ids, user.id, ...ids,
    );
    for (const row of rows) events.push({ kind: row.kind, repo: fullName(byId.get(row.repo_id)!), at: row.created_at, hidden: hidden.has(row.repo_id) });
  }
  for (const repo of repos) {
    if (repo.owner_id === user.id && repo.org_id === null) events.push({ kind: "repositories", repo: fullName(repo), at: repo.created_at, hidden: hidden.has(repo.id) });
  }

  const currentYear = Number(dayKey(at, offsetMinutes).slice(0, 4));
  let earliestYear = Number(dayKey(user.created_at, offsetMinutes).slice(0, 4));
  for (const event of events) earliestYear = Math.min(earliestYear, Number(dayKey(event.at, offsetMinutes).slice(0, 4)));
  earliestYear = Math.max(earliestYear, currentYear - 30);
  const years: number[] = [];
  for (let y = currentYear; y >= earliestYear; y -= 1) years.push(y);

  const { from, to } = reportRange(year, offsetMinutes, at);
  const counts = new Map<string, number>();
  const breakdown: ContributionBreakdown = { commits: 0, issues: 0, pulls: 0, comments: 0, repositories: 0, private: 0 };
  const months = new Map<string, { commits: Map<string, number>; repositories: { repo: string; created_at: number }[]; issues: Map<string, number>; pulls: Map<string, number>; private: number }>();
  for (const event of events) {
    const key = dayKey(event.at, offsetMinutes);
    if (key < from || key > to) continue;
    counts.set(key, (counts.get(key) ?? 0) + 1);
    const month = key.slice(0, 7);
    const bucketFor = () => {
      let bucket = months.get(month);
      if (!bucket) {
        bucket = { commits: new Map(), repositories: [], issues: new Map(), pulls: new Map(), private: 0 };
        months.set(month, bucket);
      }
      return bucket;
    };
    if (event.hidden) {
      breakdown.private += 1;
      bucketFor().private += 1;
      continue;
    }
    breakdown[event.kind] += 1;
    if (event.kind === "comments") continue;
    const bucket = bucketFor();
    if (event.kind === "repositories") bucket.repositories.push({ repo: event.repo, created_at: event.at });
    else bucket[event.kind].set(event.repo, (bucket[event.kind].get(event.repo) ?? 0) + 1);
  }

  const days: ContributionDay[] = [];
  for (let key = from; key <= to; key = addDays(key, 1)) days.push({ date: key, count: counts.get(key) ?? 0 });
  const sorted = (map: Map<string, number>) => [...map].map(([repo, count]) => ({ repo, count })).sort((a, b) => b.count - a.count || a.repo.localeCompare(b.repo));

  return {
    year,
    years,
    from,
    to,
    days,
    total: breakdown.commits + breakdown.issues + breakdown.pulls + breakdown.comments + breakdown.repositories + breakdown.private,
    breakdown,
    months: [...months]
      .sort((a, b) => b[0].localeCompare(a[0]))
      .map(([month, bucket]) => ({
        month,
        commits: sorted(bucket.commits),
        repositories: bucket.repositories.sort((a, b) => b.created_at - a.created_at),
        issues: sorted(bucket.issues),
        pulls: sorted(bucket.pulls),
        private: bucket.private,
      })),
    joined_at: user.created_at,
  };
}

export interface EmailSuggestion {
  email: string;
  name: string;
  commits: number;
}

const SUGGESTION_LIMIT = 10;

export async function suggestCommitEmails(repos: readonly RepoRecord[], exclude: (email: string) => boolean): Promise<EmailSuggestion[]> {
  const totals = new Map<string, EmailSuggestion>();
  for (const repo of repos.slice(0, 50)) {
    const authors = await cached(`authors:${repo.id}:${repo.updated_at}`, COMMIT_CACHE_MS, async () => {
      try {
        const result = await git(["log", "--all", `--max-count=${MAX_COMMITS_PER_REPO}`, "--format=%aE%x09%aN"], { cwd: repoDiskPath(repo), timeoutMs: 30_000 });
        return result.exitCode === 0 ? result.stdout : "";
      } catch {
        return "";
      }
    });
    for (const line of authors.split("\n")) {
      const [email, name = ""] = line.split("\t");
      if (!email || !email.includes("@")) continue;
      const key = email.toLowerCase();
      const entry = totals.get(key) ?? { email, name, commits: 0 };
      entry.commits += 1;
      totals.set(key, entry);
    }
  }
  return [...totals.values()]
    .filter((entry) => !exclude(entry.email))
    .sort((a, b) => b.commits - a.commits || a.email.localeCompare(b.email))
    .slice(0, SUGGESTION_LIMIT);
}

export function profileReadmeRepo(userId: number, username: string): number | null {
  return one<{ id: number }>("SELECT id FROM repos WHERE owner_id = ? AND org_id IS NULL AND fork_of IS NULL AND name = ? COLLATE NOCASE", userId, username)?.id ?? null;
}

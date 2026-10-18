import { all, changes, now, one, run, scalar } from "../db/index.ts";
import { notFound } from "../lib/errors.ts";
import type { RepoRecord } from "./repos.ts";

export type MilestoneState = "open" | "closed";

export interface MilestoneRow {
  id: number;
  repo_id: number;
  number: number;
  title: string;
  description: string;
  state: MilestoneState;
  due_on: number | null;
  created_at: number;
  updated_at: number;
  closed_at: number | null;
  creator_id: number;
}

export interface MilestoneWithCounts extends MilestoneRow {
  creator_username: string;
  open_issues: number;
  closed_issues: number;
  open_pulls: number;
  merged_pulls: number;
  closed_pulls: number;
}

export interface CreateMilestoneInput {
  title: string;
  description?: string;
  dueOn?: number | null;
}

const SELECT_MILESTONE_WITH_COUNTS = `
  SELECT m.*,
    u.username AS creator_username,
    COALESCE(ic.open_c, 0)  AS open_issues,
    COALESCE(ic.closed_c, 0) AS closed_issues,
    COALESCE(pc.open_c, 0)  AS open_pulls,
    COALESCE(pc.merged_c, 0) AS merged_pulls,
    COALESCE(pc.closed_c, 0) AS closed_pulls
  FROM milestones m
  JOIN users u ON u.id = m.creator_id
  LEFT JOIN (
    SELECT milestone_id,
           SUM(state = 'open')  AS open_c,
           SUM(state = 'closed') AS closed_c
      FROM issues WHERE milestone_id IS NOT NULL GROUP BY milestone_id
  ) ic ON ic.milestone_id = m.id
  LEFT JOIN (
    SELECT milestone_id,
           SUM(state = 'open')   AS open_c,
           SUM(state = 'merged') AS merged_c,
           SUM(state = 'closed') AS closed_c
      FROM pulls WHERE milestone_id IS NOT NULL GROUP BY milestone_id
  ) pc ON pc.milestone_id = m.id`;

export function listMilestones(repoId: number, state: MilestoneState | "all" = "open"): MilestoneWithCounts[] {
  const where = state === "all" ? "WHERE m.repo_id = ?" : "WHERE m.repo_id = ? AND m.state = ?";
  const params = state === "all" ? [repoId] : [repoId, state];
  return all<MilestoneWithCounts>(
    `${SELECT_MILESTONE_WITH_COUNTS} ${where}
      ORDER BY (m.due_on IS NULL), m.due_on ASC, m.number ASC`,
    ...params,
  );
}

export function findMilestoneByNumber(repoId: number, number: number): MilestoneWithCounts | null {
  return one<MilestoneWithCounts>(`${SELECT_MILESTONE_WITH_COUNTS} WHERE m.repo_id = ? AND m.number = ?`, repoId, number);
}

export function requireMilestoneByNumber(repoId: number, number: number): MilestoneWithCounts {
  const milestone = findMilestoneByNumber(repoId, number);
  if (!milestone) throw notFound("Milestone not found");
  return milestone;
}

export function createMilestone(repo: RepoRecord, creatorId: number, input: CreateMilestoneInput): MilestoneWithCounts {
  const timestamp = now();
  const number = nextMilestoneNumber(repo.id);
  const id = run(
    `INSERT INTO milestones (repo_id, number, title, description, state, due_on, created_at, updated_at, creator_id)
     VALUES (?, ?, ?, ?, 'open', ?, ?, ?, ?)`,
    repo.id,
    number,
    input.title.trim(),
    input.description ?? "",
    input.dueOn ?? null,
    timestamp,
    timestamp,
    creatorId,
  );
  const created = one<MilestoneWithCounts>(`${SELECT_MILESTONE_WITH_COUNTS} WHERE m.id = ?`, id);
  if (!created) throw notFound("Milestone not found after creation");
  return created;
}

function nextMilestoneNumber(repoId: number): number {
  const highest = scalar<number | null>(
    `SELECT MAX(n) FROM (
       SELECT MAX(number) AS n FROM issues    WHERE repo_id = ?
       UNION ALL SELECT MAX(number) FROM pulls  WHERE repo_id = ?
       UNION ALL SELECT MAX(number) FROM milestones WHERE repo_id = ?
     )`,
    repoId,
    repoId,
    repoId,
  );
  return (highest ?? 0) + 1;
}

export interface UpdateMilestoneInput {
  title?: string;
  description?: string;
  state?: MilestoneState;
  dueOn?: number | null;
}

export function updateMilestone(milestone: MilestoneRow, input: UpdateMilestoneInput): MilestoneWithCounts {
  const timestamp = now();
  const sets: string[] = [];
  const params: Array<string | number | null> = [];
  if (input.title !== undefined) {
    sets.push("title = ?");
    params.push(input.title.trim());
  }
  if (input.description !== undefined) {
    sets.push("description = ?");
    params.push(input.description);
  }
  if (input.dueOn !== undefined) {
    sets.push("due_on = ?");
    params.push(input.dueOn);
  }
  if (input.state !== undefined) {
    sets.push("state = ?");
    params.push(input.state);
    sets.push("closed_at = ?");
    params.push(input.state === "closed" ? (milestone.closed_at ?? timestamp) : null);
  }
  if (sets.length === 0) return requireMilestoneByNumber(milestone.repo_id, milestone.number);
  sets.push("updated_at = ?");
  params.push(timestamp, milestone.id);
  changes(`UPDATE milestones SET ${sets.join(", ")} WHERE id = ?`, ...params);
  return requireMilestoneByNumber(milestone.repo_id, milestone.number);
}

export function deleteMilestone(repoId: number, number: number): boolean {
  const milestone = one<{ id: number; open_items: number }>(
    `SELECT m.id,
            (SELECT COUNT(*) FROM issues WHERE milestone_id = m.id AND state = 'open') +
            (SELECT COUNT(*) FROM pulls  WHERE milestone_id = m.id AND state = 'open') AS open_items
       FROM milestones m WHERE m.repo_id = ? AND m.number = ?`,
    repoId,
    number,
  );
  if (!milestone) return false;
  if (milestone.open_items > 0) {
    throw notFound("Close or move the open issues and pull requests first");
  }
  return changes("DELETE FROM milestones WHERE id = ?", milestone.id) > 0;
}

export function milestoneBelongsTo(milestoneId: number, repoId: number): boolean {
  return scalar<number>("SELECT 1 FROM milestones WHERE id = ? AND repo_id = ?", milestoneId, repoId) !== null;
}

export function setIssueMilestone(issueId: number, milestoneId: number | null): void {
  changes("UPDATE issues SET milestone_id = ? WHERE id = ?", milestoneId, issueId);
}

export function setPullMilestone(pullId: number, milestoneId: number | null): void {
  changes("UPDATE pulls SET milestone_id = ? WHERE id = ?", milestoneId, pullId);
}

export function milestoneTitle(repoId: number, milestoneId: number | null): string | null {
  if (milestoneId === null) return null;
  return (
    one<{ title: string }>(
      "SELECT title FROM milestones WHERE id = ? AND repo_id = ?",
      milestoneId,
      repoId,
    )?.title ?? null
  );
}

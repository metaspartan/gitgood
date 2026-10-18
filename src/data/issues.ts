import { all, changes, now, one, run, scalar, transaction } from "../db/index.ts";
import { notFound } from "../lib/errors.ts";
import type { RepoRecord } from "./repos.ts";

export type IssueState = "open" | "closed";

export const BODY_PREVIEW_LENGTH = 200;

export interface IssueRow {
  id: number;
  repo_id: number;
  number: number;
  title: string;
  body: string;
  state: IssueState;
  author_id: number;
  created_at: number;
  updated_at: number;
  closed_at: number | null;
  milestone_id?: number | null;
}

export interface IssueWithAuthor extends IssueRow {
  author_username: string;
  author_display: string;
  author_hue: number;
  comment_count: number;
}

export interface IssueSummary extends Omit<IssueWithAuthor, "body"> {
  body_preview: string;
}

const AUTHOR_COLUMNS = `
  u.username AS author_username, u.display_name AS author_display, u.avatar_hue AS author_hue`;

const SELECT_ISSUE = `
  SELECT i.*, ${AUTHOR_COLUMNS}, COALESCE(cc.c, 0) AS comment_count
  FROM issues i
  JOIN users u ON u.id = i.author_id
  LEFT JOIN (
    SELECT target_id, COUNT(*) AS c FROM comments WHERE target_type = 'issue' GROUP BY target_id
  ) cc ON cc.target_id = i.id`;

const SELECT_ISSUE_SUMMARY = `
  SELECT i.id, i.repo_id, i.number, i.title, i.state, i.author_id, i.created_at, i.updated_at, i.closed_at,
    substr(i.body, 1, ${BODY_PREVIEW_LENGTH}) AS body_preview,
    ${AUTHOR_COLUMNS}, COALESCE(cc.c, 0) AS comment_count
  FROM issues i
  JOIN users u ON u.id = i.author_id
  LEFT JOIN (
    SELECT target_id, COUNT(*) AS c FROM comments WHERE target_type = 'issue' GROUP BY target_id
  ) cc ON cc.target_id = i.id`;

export function nextNumber(repoId: number, kind: "issue" | "pull"): number {
  return transaction(() => {
    const row = one<{ next_value: number }>(
      "SELECT next_value FROM repo_counters WHERE repo_id = ? AND kind = ?",
      repoId,
      kind,
    );
    if (!row) {
      run("INSERT INTO repo_counters (repo_id, kind, next_value) VALUES (?, ?, 2)", repoId, kind);
      return 1;
    }
    changes(
      "UPDATE repo_counters SET next_value = next_value + 1 WHERE repo_id = ? AND kind = ?",
      repoId,
      kind,
    );
    return row.next_value;
  });
}

export interface CreateIssueInput {
  title: string;
  body?: string;
}

export function createIssue(repo: RepoRecord, authorId: number, input: CreateIssueInput): IssueWithAuthor {
  const number = nextNumber(repo.id, "issue");
  const timestamp = now();
  const id = run(
    `INSERT INTO issues (repo_id, number, title, body, state, author_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'open', ?, ?, ?)`,
    repo.id,
    number,
    input.title.trim(),
    input.body ?? "",
    authorId,
    timestamp,
    timestamp,
  );
  return requireIssueById(id);
}

export function findIssueByNumber(repoId: number, number: number): IssueWithAuthor | null {
  return one<IssueWithAuthor>(`${SELECT_ISSUE} WHERE i.repo_id = ? AND i.number = ?`, repoId, number);
}

export function requireIssueById(id: number): IssueWithAuthor {
  const issue = one<IssueWithAuthor>(`${SELECT_ISSUE} WHERE i.id = ?`, id);
  if (!issue) throw notFound("Issue not found");
  return issue;
}

export function requireIssue(repoId: number, number: number): IssueWithAuthor {
  const issue = findIssueByNumber(repoId, number);
  if (!issue) throw notFound(`Issue #${number} not found`);
  return issue;
}

export interface ListIssuesOptions {
  state?: IssueState | "all";
  limit: number;
  offset: number;
  assigneeId?: number | null;
}

function assigneePredicate(options: ListIssuesOptions): { sql: string; params: number[] } {
  if (options.assigneeId === undefined) return { sql: "", params: [] };
  if (options.assigneeId === null) {
    return { sql: "AND NOT EXISTS (SELECT 1 FROM issue_assignees a WHERE a.issue_id = i.id)", params: [] };
  }
  return {
    sql: "AND EXISTS (SELECT 1 FROM issue_assignees a WHERE a.issue_id = i.id AND a.user_id = ?)",
    params: [options.assigneeId],
  };
}

export function listIssues(repoId: number, options: ListIssuesOptions): IssueSummary[] {
  const state = options.state ?? "open";
  const filter = assigneePredicate(options);
  if (state === "all") {
    return all<IssueSummary>(
      `${SELECT_ISSUE_SUMMARY} WHERE i.repo_id = ? ${filter.sql} ORDER BY i.number DESC LIMIT ? OFFSET ?`,
      repoId,
      ...filter.params,
      options.limit,
      options.offset,
    );
  }
  return all<IssueSummary>(
    `${SELECT_ISSUE_SUMMARY} WHERE i.repo_id = ? AND i.state = ? ${filter.sql} ORDER BY i.number DESC LIMIT ? OFFSET ?`,
    repoId,
    state,
      ...filter.params,
    options.limit,
    options.offset,
  );
}

export function countIssues(
  repoId: number,
  state?: IssueState | "all",
  assigneeId?: number | null,
): number {
  const filter = assigneePredicate({ state: state ?? "open", limit: 0, offset: 0, ...(assigneeId !== undefined ? { assigneeId } : {}) });
  if (!state || state === "all") {
    return (
      scalar<number>(`SELECT COUNT(*) FROM issues i WHERE i.repo_id = ? ${filter.sql}`, repoId, ...filter.params) ?? 0
    );
  }
  return (
    scalar<number>(
      `SELECT COUNT(*) FROM issues i WHERE i.repo_id = ? AND i.state = ? ${filter.sql}`,
      repoId,
      state,
      ...filter.params,
    ) ?? 0
  );
}

export interface UpdateIssueInput {
  title?: string;
  body?: string;
  state?: IssueState;
}

export function updateIssue(issue: IssueWithAuthor, input: UpdateIssueInput): IssueWithAuthor {
  const fields: string[] = [];
  const values: Array<string | number | null> = [];
  if (input.title !== undefined) {
    fields.push("title = ?");
    values.push(input.title.trim());
  }
  if (input.body !== undefined) {
    fields.push("body = ?");
    values.push(input.body);
  }
  if (input.state !== undefined) {
    fields.push("state = ?");
    values.push(input.state);
    fields.push("closed_at = ?");
    values.push(input.state === "closed" ? now() : null);
  }
  if (fields.length === 0) return issue;
  fields.push("updated_at = ?");
  values.push(now());
  values.push(issue.id);
  changes(`UPDATE issues SET ${fields.join(", ")} WHERE id = ?`, ...values);
  return requireIssueById(issue.id);
}

import { all, changes, now, one, run, scalar } from "../db/index.ts";
import { conflict, notFound, unprocessable } from "../lib/errors.ts";
import * as gitRepo from "../git/repo.ts";
import { BODY_PREVIEW_LENGTH, nextNumber } from "./issues.ts";
import { repoDiskPath, type RepoRecord  } from "./repos.ts";

export type PullState = "open" | "closed" | "merged";

export interface PullRow {
  id: number;
  repo_id: number;
  number: number;
  title: string;
  body: string;
  state: PullState;
  author_id: number;
  head_ref: string;
  base_ref: string;
  merged_sha: string | null;
  merge_comparison?: string | null;
  created_at: number;
  updated_at: number;
  merged_at: number | null;
  milestone_id?: number | null;
}

export interface PullWithAuthor extends PullRow {
  author_username: string;
  author_display: string;
  author_hue: number;
  comment_count: number;
}

export interface PullSummary extends Omit<PullWithAuthor, "body"> {
  body_preview: string;
}

const AUTHOR_COLUMNS = `
  u.username AS author_username, u.display_name AS author_display, u.avatar_hue AS author_hue`;

const SELECT_PULL = `
  SELECT p.*, ${AUTHOR_COLUMNS}, COALESCE(cc.c, 0) AS comment_count
  FROM pulls p
  JOIN users u ON u.id = p.author_id
  LEFT JOIN (
    SELECT target_id, COUNT(*) AS c FROM comments WHERE target_type = 'pull' GROUP BY target_id
  ) cc ON cc.target_id = p.id`;

const SELECT_PULL_SUMMARY = `
  SELECT p.id, p.repo_id, p.number, p.title, p.state, p.author_id, p.head_ref, p.base_ref,
    p.merged_sha, p.created_at, p.merged_at, p.updated_at,
    substr(p.body, 1, ${BODY_PREVIEW_LENGTH}) AS body_preview,
    ${AUTHOR_COLUMNS}, COALESCE(cc.c, 0) AS comment_count
  FROM pulls p
  JOIN users u ON u.id = p.author_id
  LEFT JOIN (
    SELECT target_id, COUNT(*) AS c FROM comments WHERE target_type = 'pull' GROUP BY target_id
  ) cc ON cc.target_id = p.id`;

export interface CreatePullInput {
  title: string;
  body?: string;
  head: string;
  base: string;
}

export async function createPull(
  repo: RepoRecord,
  authorId: number,
  input: CreatePullInput,
): Promise<PullWithAuthor> {
  const path = repoDiskPath(repo);
  const headSha = await gitRepo.resolveRef(path, `refs/heads/${input.head}`);
  if (!headSha) throw unprocessable(`Source branch "${input.head}" does not exist`);
  const baseSha = await gitRepo.resolveRef(path, `refs/heads/${input.base}`);
  if (!baseSha) throw unprocessable(`Target branch "${input.base}" does not exist`);

  const number = nextNumber(repo.id, "pull");
  const timestamp = now();
  const id = run(
    `INSERT INTO pulls (repo_id, number, title, body, state, author_id, head_ref, base_ref, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'open', ?, ?, ?, ?, ?)`,
    repo.id,
    number,
    input.title.trim(),
    input.body ?? "",
    authorId,
    input.head,
    input.base,
    timestamp,
    timestamp,
  );
  return requirePullById(id);
}

export function findPullByNumber(repoId: number, number: number): PullWithAuthor | null {
  return one<PullWithAuthor>(`${SELECT_PULL} WHERE p.repo_id = ? AND p.number = ?`, repoId, number);
}

export function findOpenPullByHead(repoId: number, headRef: string): PullRow | null {
  return one<PullRow>(
    `SELECT * FROM pulls WHERE repo_id = ? AND state = 'open' AND head_ref = ? ORDER BY id DESC LIMIT 1`,
    repoId,
    headRef,
  );
}



export function requirePullById(id: number): PullWithAuthor {
  const pull = one<PullWithAuthor>(`${SELECT_PULL} WHERE p.id = ?`, id);
  if (!pull) throw notFound("Pull request not found");
  return pull;
}

export function requirePull(repoId: number, number: number): PullWithAuthor {
  const pull = findPullByNumber(repoId, number);
  if (!pull) throw notFound(`Pull request #${number} not found`);
  return pull;
}

export interface ListPullsOptions {
  state?: PullState | "all";
  limit: number;
  offset: number;
  assigneeId?: number | null;
}

function assigneePredicate(options: ListPullsOptions): { sql: string; params: number[] } {
  if (options.assigneeId === undefined) return { sql: "", params: [] };
  if (options.assigneeId === null) {
    return { sql: "AND NOT EXISTS (SELECT 1 FROM pull_assignees a WHERE a.pull_id = p.id)", params: [] };
  }
  return {
    sql: "AND EXISTS (SELECT 1 FROM pull_assignees a WHERE a.pull_id = p.id AND a.user_id = ?)",
    params: [options.assigneeId],
  };
}

export function listPulls(repoId: number, options: ListPullsOptions): PullSummary[] {
  const state = options.state ?? "open";
  const filter = assigneePredicate(options);
  if (state === "all") {
    return all<PullSummary>(
      `${SELECT_PULL_SUMMARY} WHERE p.repo_id = ? ${filter.sql} ORDER BY p.number DESC LIMIT ? OFFSET ?`,
      repoId,
      ...filter.params,
      options.limit,
      options.offset,
    );
  }
  return all<PullSummary>(
    `${SELECT_PULL_SUMMARY} WHERE p.repo_id = ? AND p.state = ? ${filter.sql} ORDER BY p.number DESC LIMIT ? OFFSET ?`,
    repoId,
    state,
    ...filter.params,
    options.limit,
    options.offset,
  );
}

export function countPulls(
  repoId: number,
  state?: PullState | "all",
  assigneeId?: number | null,
): number {
  const filter = assigneePredicate({
    state: state ?? "open",
    limit: 0,
    offset: 0,
    ...(assigneeId !== undefined ? { assigneeId } : {}),
  });
  if (!state || state === "all") {
    return (
      scalar<number>(`SELECT COUNT(*) FROM pulls p WHERE p.repo_id = ? ${filter.sql}`, repoId, ...filter.params) ?? 0
    );
  }
  return (
    scalar<number>(
      `SELECT COUNT(*) FROM pulls p WHERE p.repo_id = ? AND p.state = ? ${filter.sql}`,
      repoId,
      state,
      ...filter.params,
    ) ?? 0
  );
}

export interface UpdatePullInput {
  title?: string;
  body?: string;
  state?: PullState;
}

export function updatePull(pull: PullWithAuthor, input: UpdatePullInput): PullWithAuthor {
  if (pull.state === "merged" && input.state !== undefined) throw conflict("Merged pull requests cannot be reopened or closed");
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
  }
  if (fields.length === 0) return pull;
  fields.push("updated_at = ?");
  values.push(now());
  values.push(pull.id);
  changes(`UPDATE pulls SET ${fields.join(", ")} WHERE id = ?`, ...values);
  return requirePullById(pull.id);
}

export interface MergePullResult {
  sha: string;
  fastForward: boolean;
  pull: PullWithAuthor;
}

export async function mergePull(
  repo: RepoRecord,
  pull: PullWithAuthor,
  merger: { name: string; email: string },
  pinnedHeadSha?: string,
): Promise<MergePullResult> {
  if (pull.state === "merged") throw conflict("This pull request is already merged");
  if (pull.state === "closed") throw conflict("Reopen this pull request before merging it");

  const path = repoDiskPath(repo);
  const headSha = await gitRepo.resolveRef(path, `refs/heads/${pull.head_ref}`);
  if (!headSha) throw unprocessable(`Source branch "${pull.head_ref}" no longer exists`);
  if (pinnedHeadSha && pinnedHeadSha !== headSha) {
    throw conflict("The pull request head moved; review the new commit before merging");
  }

  let result: gitRepo.MergeResult;
  try {
    result = await gitRepo.mergeRefs(
      path,
      `refs/heads/${pull.base_ref}`,
      `refs/heads/${pull.head_ref}`,
      `Merge pull request #${pull.number} from ${pull.head_ref}`,
      merger,
      { pinnedHeadSha: pinnedHeadSha ?? headSha, captureComparison: true },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Merge failed";
    if (message.includes("moved during merge") || message.includes("changed during merge")) {
      throw conflict(message);
    }
    if (message.startsWith("Merge conflict")) throw unprocessable(message);
    if (message.startsWith("Unknown ref")) throw unprocessable(message);
    throw error;
  }

  const timestamp = now();
  changes(
    `UPDATE pulls SET state = 'merged', merged_sha = ?, merged_at = ?, updated_at = ?, merge_comparison = ? WHERE id = ?`,
    result.sha,
    timestamp,
    timestamp,
    result.comparison ? JSON.stringify(result.comparison) : null,
    pull.id,
  );
  return { sha: result.sha, fastForward: result.fastForward, pull: requirePullById(pull.id) };
}

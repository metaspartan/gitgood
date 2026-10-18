import { all, changes, now, one, run } from "../db/index.ts";
import { conflict, forbidden } from "../lib/errors.ts";
import type { Auth, Principal } from "../auth/service.ts";
import { canWrite, type RepoRecord } from "./repos.ts";

export type ReviewEvent = "APPROVE" | "REQUEST_CHANGES" | "COMMENT";

export interface PullReviewRow {
  id: number;
  repo_id: number;
  pull_id: number;
  user_id: number;
  event: ReviewEvent;
  body: string;
  commit_id: string;
  created_at: number;
  username: string;
}

export interface PullMergePolicy {
  branch: string;
  required_approvals: number;
  require_checks: boolean;
}

const DEFAULT_POLICY: PullMergePolicy = {
  branch: "",
  required_approvals: 0,
  require_checks: false,
};

const SELECT_REVIEW = `
  SELECT r.id, r.repo_id, r.pull_id, r.user_id, r.event, r.body, r.commit_id, r.created_at,
         u.username AS username
    FROM pull_reviews r
    JOIN users u ON u.id = r.user_id`;

export function listReviews(pullId: number, limit = 100): PullReviewRow[] {
  return all<PullReviewRow>(
    `${SELECT_REVIEW} WHERE r.pull_id = ? ORDER BY r.id DESC LIMIT ?`,
    pullId,
    limit,
  );
}

export function addReview(input: {
  repoId: number;
  pullId: number;
  userId: number;
  event: ReviewEvent;
  body: string;
  headSha: string;
  expectedCommitId: string;
}): PullReviewRow {
  if (input.expectedCommitId !== input.headSha) {
    throw conflict(
      "The pull request head moved; review the current commit and submit again",
    );
  }
  const id = run(
    `INSERT INTO pull_reviews (repo_id, pull_id, user_id, event, body, commit_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    input.repoId,
    input.pullId,
    input.userId,
    input.event,
    input.body,
    input.headSha,
    now(),
  );
  const created = one<PullReviewRow>(`${SELECT_REVIEW} WHERE r.id = ?`, id);
  if (!created) throw conflict("Review was not stored");
  return created;
}

export function getMergePolicy(repoId: number, branch: string): PullMergePolicy {
  const row = one<{
    branch: string;
    required_approvals: number;
    require_checks: number;
  }>(
    `SELECT branch, required_approvals, require_checks
       FROM pull_merge_policies WHERE repo_id = ? AND branch = ?`,
    repoId,
    branch,
  );
  if (!row) return { ...DEFAULT_POLICY, branch };
  return {
    branch: row.branch,
    required_approvals: row.required_approvals,
    require_checks: row.require_checks === 1,
  };
}

export function canManageMergePolicy(repo: RepoRecord, auth: Auth): boolean {
  if (auth.kind !== "user") return false;
  try {
    assertPolicyAdmin(repo, auth);
    return true;
  } catch {
    return false;
  }
}

export function listMergePolicies(repoId: number): PullMergePolicy[] {
  return all<{ branch: string; required_approvals: number; require_checks: number }>(
    `SELECT branch, required_approvals, require_checks
       FROM pull_merge_policies WHERE repo_id = ?
       ORDER BY branch COLLATE NOCASE ASC`,
    repoId,
  ).map((row) => ({
    branch: row.branch,
    required_approvals: row.required_approvals,
    require_checks: row.require_checks === 1,
  }));
}

export function deleteMergePolicy(repoId: number, branch: string): boolean {
  return changes("DELETE FROM pull_merge_policies WHERE repo_id = ? AND branch = ?", repoId, branch) > 0;
}

export function putMergePolicy(
  repoId: number,
  branch: string,
  requiredApprovals: number,
  requireChecks: boolean,
): PullMergePolicy {
  const timestamp = now();
  const updated = changes(
    `UPDATE pull_merge_policies
        SET required_approvals = ?, require_checks = ?, updated_at = ?
      WHERE repo_id = ? AND branch = ?`,
    requiredApprovals,
    requireChecks ? 1 : 0,
    timestamp,
    repoId,
    branch,
  );
  if (updated === 0) {
    run(
      `INSERT INTO pull_merge_policies (repo_id, branch, required_approvals, require_checks, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
      repoId,
      branch,
      requiredApprovals,
      requireChecks ? 1 : 0,
      timestamp,
    );
  }
  return getMergePolicy(repoId, branch);
}

function latestDecisiveByUser(pullId: number): PullReviewRow[] {
  const rows = all<PullReviewRow>(
    `${SELECT_REVIEW}
      WHERE r.pull_id = ? AND r.event IN ('APPROVE', 'REQUEST_CHANGES')
        AND r.id = (SELECT MAX(latest.id) FROM pull_reviews latest
          WHERE latest.pull_id = r.pull_id AND latest.user_id = r.user_id
          AND latest.event IN ('APPROVE', 'REQUEST_CHANGES'))
      ORDER BY r.user_id ASC, r.id DESC`,
    pullId,
  );
  const latest: PullReviewRow[] = [];
  let previousUser = -1;
  for (const row of rows) {
    if (row.user_id === previousUser) continue;
    previousUser = row.user_id;
    latest.push(row);
  }
  return latest;
}

export interface ReviewSummary {
  approvals: number;
  changes_requested: number;
}

export function summarizeReviews(
  pullId: number,
  headSha: string,
  authorId: number,
  eligibleUserIds: ReadonlySet<number> | null,
): ReviewSummary {
  let approvals = 0;
  let changesRequested = 0;
  for (const review of latestDecisiveByUser(pullId)) {
    if (review.user_id === authorId) continue;
    if (eligibleUserIds && !eligibleUserIds.has(review.user_id)) continue;
    if (review.event === "APPROVE") {

      if (review.commit_id === headSha) approvals += 1;
      continue;
    }

    changesRequested += 1;
  }
  return { approvals, changes_requested: changesRequested };
}

export function eligibleReviewerIds(repo: RepoRecord, authorId: number): Set<number> {
  const ids = new Set<number>();
  const consider = (userId: number, isAdmin: boolean): void => {
    if (userId === authorId) return;
    const auth: Auth = {
      kind: "user",
      userId,
      username: "",
      isAdmin,
      scopes: ["read", "write"],
      via: "session",
    };
    if (canWrite(repo, auth)) ids.add(userId);
  };

  if (repo.org_id !== null) {
    const members = all<{ user_id: number; role: string }>(
      `SELECT user_id, role FROM org_members WHERE org_id = ? AND role IN ('owner', 'admin')`,
      repo.org_id,
    );
    for (const member of members) consider(member.user_id, false);
  } else {
    consider(repo.owner_id, false);
  }

  const admins = all<{ id: number }>(`SELECT id FROM users WHERE is_admin = 1`);
  for (const admin of admins) consider(admin.id, true);
  return ids;
}

export function assertPolicyAdmin(repo: RepoRecord, principal: Principal): void {
  if (
    principal.via === "token" &&
    !principal.scopes.includes("write") &&
    !principal.scopes.includes("admin")
  ) {
    throw forbidden("This token does not have write scope");
  }
  if (principal.isAdmin) return;
  if (repo.org_id !== null) {
    const role = one<{ role: string }>(
      `SELECT role FROM org_members WHERE org_id = ? AND user_id = ?`,
      repo.org_id,
      principal.userId,
    );
    if (role?.role === "owner" || role?.role === "admin") return;
    throw forbidden("Only an organisation owner or admin can change merge policy");
  }
  if (principal.userId === repo.owner_id) return;
  throw forbidden("Only the repository owner can change merge policy");
}

export function canSubmitDecisiveReview(
  repo: RepoRecord,
  auth: Auth,
  authorId: number,
): boolean {
  if (auth.kind !== "user") return false;
  if (auth.userId === authorId) return false;
  return canWrite(repo, auth);
}

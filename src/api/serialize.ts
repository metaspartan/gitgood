import type { PublicUser, UserRow } from "../auth/service.ts";
import type { RepoRecord } from "../data/repos.ts";
import type { IssueRow, IssueWithAuthor } from "../data/issues.ts";
import type { PullRow, PullWithAuthor } from "../data/pulls.ts";
import type { CommentWithAuthor, CommentRow } from "../data/comments.ts";
import type { LabelRow } from "../data/labels.ts";
import type { DeliveryRow, WebhookRow, WebhookWithStats } from "../data/webhooks.ts";
import type { AccessTokenRow, CreatedToken } from "../auth/service.ts";
import type { OrgRow, OrgWithCounts, OrgMemberWithUser } from "../data/orgs.ts";
import type { NotificationRow } from "../data/notifications.ts";
import type { SshKeyRow } from "../ssh/keys.ts";
import type {
  GitBranch,
  GitCommit,
  GitCommitDetail,
  GitFileChange,
  GitTag,
  GitTreeEntry,
} from "../git/types.ts";
import type { LockWithOwner } from "../lfs/locks.ts";
import type { BlameResult, DiffResult } from "../git/diff.ts";
import { languageForPath } from "../lib/file-types.ts";
import { config } from "../config.ts";
import { BODY_PREVIEW_LENGTH } from "../data/issues.ts";
import type { IssueSummary } from "../data/issues.ts";
import type { PullSummary } from "../data/pulls.ts";

export function userJson(row: UserRow | PublicUser): Record<string, unknown> {
  if ("email" in row) {
    return {
      id: row.id,
      username: row.username,
      display_name: row.display_name,
      avatar_hue: row.avatar_hue,
      is_admin: row.is_admin === 1,
      created_at: row.created_at,
    };
  }
  return {
    id: row.id,
    username: row.username,
    display_name: row.display_name,
    avatar_hue: row.avatar_hue,
    is_admin: row.is_admin,
    created_at: row.created_at,
  };
}

export function profileFieldsJson(row: UserRow): Record<string, string> {
  return { bio: row.bio ?? "", company: row.company ?? "", location: row.location ?? "", website: row.website ?? "" };
}

export function selfUserJson(row: UserRow): Record<string, unknown> {
  return { ...userJson(row), ...profileFieldsJson(row), email: row.email, show_private_contributions: row.show_private_contributions === 1 };
}

export function repoJson(repo: RepoRecord): Record<string, unknown> {
  return {
    id: repo.id,
    owner: repo.owner_username,
    name: repo.name,
    full_name: `${repo.owner_username}/${repo.name}`,
    description: repo.description,
    visibility: repo.visibility,
    default_branch: repo.default_branch,
    lfs_enabled: repo.lfs_enabled === 1,
    actions_enabled: repo.actions_enabled !== 0,
    archived: repo.archived === 1,
    owner_kind: repo.owner_kind,
    created_at: repo.created_at,
    updated_at: repo.updated_at,
    clone_url: `/${repo.owner_username}/${repo.name}.git`,
    ssh_url: config.sshCommand
      ? `git@${sshHost()}:${repo.owner_username}/${repo.name}.git`
      : null,
    fork_of: repo.fork_of,
    quota_bytes: repo.quota_bytes,
    over_quota: repo.over_quota_at !== null,
  };
}

function sshHost(): string {
  const base = config.baseUrl;
  const withoutScheme = base.includes("://") ? base.slice(base.indexOf("://") + 3) : base;
  return withoutScheme.replace(/\/.*$/, "");
}

export function orgJson(org: OrgRow | OrgWithCounts): Record<string, unknown> {
  const base: Record<string, unknown> = {
    id: org.id,
    name: org.name,
    display_name: org.display_name,
    description: org.description,
    avatar_hue: org.avatar_hue,
    created_at: org.created_at,
    updated_at: org.updated_at,
  };
  if ("viewer_role" in org && org.viewer_role !== undefined) {
    base.viewer_role = org.viewer_role;
  }
  if ("repo_count" in org) {
    base.repo_count = org.repo_count;
    base.member_count = org.member_count;
  }
  return base;
}

export function orgMemberJson(member: OrgMemberWithUser): Record<string, unknown> {
  return {
    user: {
      id: member.user_id,
      username: member.username,
      display_name: member.display_name,
      avatar_hue: member.avatar_hue,
    },
    role: member.role,
    created_at: member.created_at,
  };
}

export function notificationJson(row: NotificationRow): Record<string, unknown> {
  return {
    id: row.id,
    kind: row.kind,
    repository: row.repo_full_name || null,
    subject: row.subject_type
      ? {
          type: row.subject_type,
          id: row.subject_id,
          number: row.subject_number,
          title: row.subject_title,
        }
      : null,
    actor: row.actor_username || null,
    unread: row.read_at === null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function sshKeyJson(key: SshKeyRow): Record<string, unknown> {
  return {
    id: key.id,
    title: key.title,
    algorithm: key.public_key.split(" ")[0] ?? "",
    fingerprint: key.fingerprint,
    created_at: key.created_at,
  };
}

export function issueJson(issue: IssueRow | IssueWithAuthor): Record<string, unknown> {
  const base: Record<string, unknown> = {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    created_at: issue.created_at,
    updated_at: issue.updated_at,
    closed_at: issue.closed_at,
    milestone_id: issue.milestone_id ?? null,
  };
  if ("author_username" in issue) {
    base.author = {
      id: issue.author_id,
      username: issue.author_username,
      display_name: issue.author_display,
      avatar_hue: issue.author_hue,
    };
    base.comment_count = issue.comment_count;
  }
  return base;
}

export function issueSummaryJson(issue: IssueSummary | (Omit<IssueWithAuthor, "body"> & { body_preview?: string })): Record<string, unknown> {
  const preview = "body_preview" in issue ? issue.body_preview : undefined;
  const base: Record<string, unknown> = {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    state: issue.state,
    created_at: issue.created_at,
    updated_at: issue.updated_at,
    closed_at: issue.closed_at,
    body_preview: preview ?? "",
    body_truncated: typeof preview === "string" && preview.length >= BODY_PREVIEW_LENGTH,
  };
  if ("author_username" in issue) {
    base.author = {
      id: issue.author_id,
      username: issue.author_username,
      display_name: issue.author_display,
      avatar_hue: issue.author_hue,
    };
    base.comment_count = issue.comment_count;
  }
  return base;
}

export function pullJson(pull: PullRow | PullWithAuthor, checks?: { status: string; runId: number | null }): Record<string, unknown> {
  const base: Record<string, unknown> = {
    id: pull.id,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    head: pull.head_ref,
    base: pull.base_ref,
    merged_sha: pull.merged_sha,
    ...(checks ? { checks } : {}),
    created_at: pull.created_at,
    updated_at: pull.updated_at,
    merged_at: pull.merged_at,
    milestone_id: pull.milestone_id ?? null,
  };
  if ("author_username" in pull) {
    base.author = {
      id: pull.author_id,
      username: pull.author_username,
      display_name: pull.author_display,
      avatar_hue: pull.author_hue,
    };
    base.comment_count = pull.comment_count;
  }
  return base;
}

export function pullSummaryJson(pull: PullSummary | (Omit<PullWithAuthor, "body"> & { body_preview?: string })): Record<string, unknown> {
  const preview = "body_preview" in pull ? pull.body_preview : undefined;
  const base: Record<string, unknown> = {
    id: pull.id,
    number: pull.number,
    title: pull.title,
    state: pull.state,
    head: pull.head_ref,
    base: pull.base_ref,
    merged_sha: pull.merged_sha,
    created_at: pull.created_at,
    updated_at: pull.updated_at,
    merged_at: pull.merged_at,
    body_preview: preview ?? "",
    body_truncated: typeof preview === "string" && preview.length >= BODY_PREVIEW_LENGTH,
  };
  if ("author_username" in pull) {
    base.author = {
      id: pull.author_id,
      username: pull.author_username,
      display_name: pull.author_display,
      avatar_hue: pull.author_hue,
    };
    base.comment_count = pull.comment_count;
  }
  return base;
}

export function commentJson(comment: CommentRow | CommentWithAuthor): Record<string, unknown> {
  const base: Record<string, unknown> = {
    id: comment.id,
    body: comment.body,
    created_at: comment.created_at,
    updated_at: comment.updated_at ?? null,
  };
  if ("author_username" in comment) {
    base.author = {
      id: comment.author_id,
      username: comment.author_username,
      display_name: comment.author_display,
      avatar_hue: comment.author_hue,
    };
  }
  return base;
}

export function labelJson(label: LabelRow): Record<string, unknown> {
  return { id: label.id, name: label.name, color: label.color };
}

export function webhookJson(hook: WebhookRow | WebhookWithStats): Record<string, unknown> {
  const base: Record<string, unknown> = {
    id: hook.id,
    url: hook.url,
    events: hook.events.split(","),
    active: hook.active === 1,
    created_at: hook.created_at,
  };
  if ("delivery_count" in hook) {
    base.delivery_count = hook.delivery_count;
    base.last_status = hook.last_status;
    base.last_error = hook.last_error;
    base.last_at = hook.last_at;
  }
  return base;
}

export function deliveryJson(delivery: DeliveryRow): Record<string, unknown> {
  return {
    id: delivery.id,
    event: delivery.event,
    status_code: delivery.status_code,
    error: delivery.error,
    attempts: delivery.attempts,
    duration_ms: delivery.duration_ms,
    created_at: delivery.created_at,
  };
}

export function tokenJson(token: AccessTokenRow): Record<string, unknown> {
  return {
    id: token.id,
    name: token.name,
    scopes: token.scopes.split(","),
    repo_id: token.repo_id ?? null,
    repository: token.repo_name ?? null,
    last_used_at: token.last_used_at,
    created_at: token.created_at,
  };
}

export function createdTokenJson(token: CreatedToken): Record<string, unknown> {
  return {
    id: token.id,
    name: token.name,
    scopes: token.scopes.split(","),
    repo_id: token.repo_id,
    repository: token.repo_id === null ? null : token.repo_name ?? `repository #${token.repo_id}`,
    token: token.plaintext,
    created_at: token.created_at,
  };
}

export function branchJson(branch: GitBranch): Record<string, unknown> {
  return { name: branch.name, sha: branch.sha, updated_at: branch.updatedAt };
}

export function tagJson(tag: GitTag): Record<string, unknown> {
  return { name: tag.name, sha: tag.sha };
}

export function commitJson(commit: GitCommit | GitCommitDetail): Record<string, unknown> {
  const base: Record<string, unknown> = {
    sha: commit.sha,
    short_sha: commit.shortSha,
    message: commit.subject,
    author: { name: commit.authorName, email: commit.authorEmail },
    authored_at: commit.authoredAt,
    parents: commit.parents,
  };
  if (commit.body) base.body = commit.body;
  if ("stats" in commit) {
    base.body = commit.body;
    base.stats = commit.stats;
    base.files = commit.files.map(fileChangeJson);
  }
  return base;
}

export function fileChangeJson(change: GitFileChange): Record<string, unknown> {
  return {
    path: change.path,
    additions: change.additions,
    deletions: change.deletions,
    binary: change.binary,
    status: change.status,
  };
}

export function treeEntryJson(entry: GitTreeEntry): Record<string, unknown> {
  return {
    name: entry.name,
    path: entry.path,
    type: entry.type,
    mode: entry.mode,
    sha: entry.sha,
    size: entry.size,
  };
}

export function diffJson(result: DiffResult): Record<string, unknown> {
  return {
    files: result.files.map((file) => ({
      path: file.path,
      old_path: file.oldPath,
      status: file.status,
      binary: file.binary,
      additions: file.additions,
      deletions: file.deletions,
      omitted: file.omitted ?? null,
      language: languageForPath(file.path),
      hunks: file.hunks.map((hunk) => ({
        header: hunk.header,
        old_start: hunk.oldStart,
        new_start: hunk.newStart,
        lines: hunk.lines.map((line) => ({
          kind: line.kind,
          text: line.text,
          old_line: line.oldLine,
          new_line: line.newLine,
        })),
      })),
    })),
    additions: result.additions,
    deletions: result.deletions,
    truncated: result.truncated,
  };
}

export function blameJson(result: BlameResult): Record<string, unknown> {
  return {
    lines: result.lines.map((line) => ({
      line: line.line,
      sha: line.sha,
      short_sha: line.shortSha,
      author: line.authorName,
      authored_at: line.authoredAt,
      original_line: line.originalLine,
      group: line.group,
      text: line.text,
    })),
    total_lines: result.totalLines,
    truncated: result.truncated,
  };
}

export function lockJson(lock: LockWithOwner): Record<string, unknown> {
  return {
    id: lock.id,
    path: lock.path,
    owner: lock.owner_username,
    created_at: lock.created_at,
  };
}

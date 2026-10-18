import { all } from "../db/index.ts";
import { notify, notifyMany } from "./notifications.ts";
import { watcherIds } from "./stars.ts";
import type { RepoRecord } from "./repos.ts";
import type { Principal } from "../auth/service.ts";

export interface EventContext {
  repo: RepoRecord;
  actor: Principal;
  ownerUserIds: number[];
}

export function notifiableOwnerIds(repo: RepoRecord): number[] {
  if (repo.org_id === null) return [repo.owner_id];
  const rows = all<{ user_id: number }>(
    "SELECT user_id FROM org_members WHERE org_id = ? AND role IN ('owner', 'admin')",
    repo.org_id,
  );
  return rows.length > 0 ? rows.map((row) => row.user_id) : [repo.owner_id];
}

function fullName(repo: RepoRecord): string {
  return `${repo.owner_username}/${repo.name}`;
}

function threadParticipants(
  repoId: number,
  subjectType: "issue" | "pull",
  subjectId: number,
): number[] {
  const rows = all<{ user_id: number }>(
    `SELECT author_id AS user_id FROM issues WHERE id = ? AND ? = 'issue'
     UNION
     SELECT author_id AS user_id FROM pulls WHERE id = ? AND ? = 'pull'
     UNION
     SELECT author_id AS user_id FROM comments
       WHERE repo_id = ? AND target_type = ? AND target_id = ?`,
    subjectId,
    subjectType,
    subjectId,
    subjectType,
    repoId,
    subjectType,
    subjectId,
  );
  return rows.map((row) => row.user_id);
}

export interface ThreadEventInput {
  repo: RepoRecord;
  actor: Principal;
  ownerUserIds: number[];
  subjectId: number;
  subjectNumber: number;
  subjectTitle: string;
  authorId: number;
}

export function notifyIssueOpened(input: ThreadEventInput): number {
  return notifyMany(
    [...input.ownerUserIds, input.authorId, ...watcherIds(input.repo.id)],
    {
    kind: "issue_opened",
    repoId: input.repo.id,
    repoFullName: fullName(input.repo),
    subjectType: "issue",
    subjectId: input.subjectId,
    subjectNumber: input.subjectNumber,
    subjectTitle: input.subjectTitle,
    actorId: input.actor.userId,
    actorUsername: input.actor.username,
    dedupeKey: `issue:${input.subjectId}:opened`,
    },
  );
}

export function notifyPullOpened(input: ThreadEventInput): number {
  return notifyMany(
    [...input.ownerUserIds, input.authorId, ...watcherIds(input.repo.id)],
    {
    kind: "pull_opened",
    repoId: input.repo.id,
    repoFullName: fullName(input.repo),
    subjectType: "pull",
    subjectId: input.subjectId,
    subjectNumber: input.subjectNumber,
    subjectTitle: input.subjectTitle,
    actorId: input.actor.userId,
    actorUsername: input.actor.username,
    dedupeKey: `pull:${input.subjectId}:opened`,
    },
  );
}

export function notifyComment(
  ctx: EventContext,
  subjectType: "issue" | "pull",
  input: ThreadEventInput,
): number {
  const recipients = [
    ...threadParticipants(ctx.repo.id, subjectType, input.subjectId),
    ...input.ownerUserIds,
    ...watcherIds(ctx.repo.id),
  ];
  return notifyMany(recipients, {
    kind: subjectType === "issue" ? "issue_commented" : "pull_commented",
    repoId: ctx.repo.id,
    repoFullName: fullName(ctx.repo),
    subjectType,
    subjectId: input.subjectId,
    subjectNumber: input.subjectNumber,
    subjectTitle: input.subjectTitle,
    actorId: ctx.actor.userId,
    actorUsername: ctx.actor.username,
    dedupeKey: `${subjectType}:${input.subjectId}:comment:${ctx.actor.userId}`,
  });
}

export function notifyStateChange(
  ctx: EventContext,
  subjectType: "issue" | "pull",
  state: "closed" | "merged",
  input: ThreadEventInput,
): number {
  const recipients = [
    ...threadParticipants(ctx.repo.id, subjectType, input.subjectId),
    ...input.ownerUserIds,
  ];
  return notifyMany(recipients, {
    kind:
      subjectType === "issue"
        ? "issue_closed"
        : state === "merged"
          ? "pull_merged"
          : "pull_closed",
    repoId: ctx.repo.id,
    repoFullName: fullName(ctx.repo),
    subjectType,
    subjectId: input.subjectId,
    subjectNumber: input.subjectNumber,
    subjectTitle: input.subjectTitle,
    actorId: ctx.actor.userId,
    actorUsername: ctx.actor.username,
    dedupeKey: `${subjectType}:${input.subjectId}:${state}`,
  });
}

export function notifyPush(repo: RepoRecord, actor: Principal | null, commits: number): number {
  const recipients = watcherIds(repo.id);
  if (recipients.length === 0) return 0;
  return notifyMany(recipients, {
    kind: "push",
    repoId: repo.id,
    repoFullName: fullName(repo),
    subjectType: "repository",
    subjectId: repo.id,
    subjectTitle: repo.name,
    actorId: actor?.userId ?? null,
    actorUsername: actor?.username ?? "",
    dedupeKey: `push:${repo.id}:${actor?.userId ?? 0}`,
  }) + (commits >= 0 ? 0 : 0);
}

export function notifyOverQuota(repo: RepoRecord, ownerUserId: number, used: number, limit: number): void {
  notify({
    userId: ownerUserId,
    kind: "repository_over_quota",
    repoId: repo.id,
    repoFullName: fullName(repo),
    subjectType: "repository",
    subjectId: repo.id,
    subjectTitle: repo.name,
    dedupeKey: `quota:${repo.id}`,
    actorId: null,
    actorUsername: "",
  });
  void used;
  void limit;
}

export function notifyAssigned(
  ctx: EventContext,
  subjectType: "issue" | "pull",
  subject: { id: number; number: number; title: string },
  userIds: readonly number[],
): number {
  return notifyMany([...userIds], {
    kind: subjectType === "issue" ? "issue_assigned" : "pull_assigned",
    repoId: ctx.repo.id,
    repoFullName: fullName(ctx.repo),
    subjectType,
    subjectId: subject.id,
    subjectNumber: subject.number,
    subjectTitle: subject.title,
    actorId: ctx.actor.userId,
    actorUsername: ctx.actor.username,
    dedupeKey: `${subjectType}:${subject.id}:assigned:${ctx.actor.userId}`,
  });
}

import { all, changes, now, one, run, scalar } from "../db/index.ts";

export type NotificationKind =
  | "issue_opened"
  | "issue_closed"
  | "issue_commented"
  | "issue_assigned"
  | "pull_opened"
  | "pull_merged"
  | "pull_closed"
  | "pull_commented"
  | "pull_assigned"
  | "push"
  | "repository_over_quota";

export interface NotificationRow {
  id: number;
  user_id: number;
  kind: NotificationKind;
  repo_id: number | null;
  repo_full_name: string;
  subject_type: string;
  subject_id: number | null;
  subject_number: number | null;
  subject_title: string;
  actor_id: number | null;
  actor_username: string;
  dedupe_key: string;
  read_at: number | null;
  created_at: number;
  updated_at: number;
}

export interface CreateNotificationInput {
  userId: number;
  kind: NotificationKind;
  repoId?: number | null;
  repoFullName?: string;
  subjectType?: string;
  subjectId?: number | null;
  subjectNumber?: number | null;
  subjectTitle?: string;
  actorId?: number | null;
  actorUsername?: string;
  dedupeKey?: string;
}

export function notify(input: CreateNotificationInput): number {
  if (input.repoId != null && scalar<number>(
    "SELECT 1 FROM watches WHERE repo_id = ? AND user_id = ? AND level = 'ignore'",
    input.repoId,
    input.userId,
  )) return 0;
  const timestamp = now();
  run(
    `INSERT INTO notifications
       (user_id, kind, repo_id, repo_full_name, subject_type, subject_id, subject_number,
        subject_title, actor_id, actor_username, dedupe_key, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id, dedupe_key) WHERE dedupe_key <> ''
     DO UPDATE SET
       updated_at = excluded.updated_at,
       read_at = NULL,
       actor_username = excluded.actor_username,
       subject_title = excluded.subject_title`,
    input.userId,
    input.kind,
    input.repoId ?? null,
    input.repoFullName ?? "",
    input.subjectType ?? "",
    input.subjectId ?? null,
    input.subjectNumber ?? null,
    input.subjectTitle ?? "",
    input.actorId ?? null,
    input.actorUsername ?? "",
    input.dedupeKey ?? "",
    timestamp,
    timestamp,
  );
  return scalar<number>(
    "SELECT id FROM notifications WHERE user_id = ? AND dedupe_key = ?",
    input.userId,
    input.dedupeKey ?? "",
  ) ?? 0;
}

export function notifyMany(
  userIds: readonly number[],
  base: Omit<CreateNotificationInput, "userId">,
): number {
  const seen = new Set<number>();
  for (const userId of userIds) {
    if (userId === base.actorId) continue;
    if (seen.has(userId)) continue;
    seen.add(userId);
    notify({ ...base, userId });
  }
  return seen.size;
}

export interface ListOptions {
  unreadOnly?: boolean;
  limit?: number;
  offset?: number;
}

export function listNotifications(userId: number, options: ListOptions = {}): NotificationRow[] {
  const limit = options.limit ?? 50;
  const offset = options.offset ?? 0;
  const filter = options.unreadOnly ? "AND read_at IS NULL" : "";
  return all<NotificationRow>(
    `SELECT * FROM notifications
      WHERE user_id = ? ${filter}
      ORDER BY updated_at DESC
      LIMIT ? OFFSET ?`,
    userId,
    limit,
    offset,
  );
}

export function countUnread(userId: number): number {
  return scalar<number>(
    "SELECT COUNT(*) FROM notifications WHERE user_id = ? AND read_at IS NULL",
    userId,
  ) ?? 0;
}

export function countNotifications(userId: number, unreadOnly = false): number {
  const filter = unreadOnly ? "AND read_at IS NULL" : "";
  return scalar<number>(
    `SELECT COUNT(*) FROM notifications WHERE user_id = ? ${filter}`,
    userId,
  ) ?? 0;
}

export function markRead(userId: number, id: number): boolean {
  return changes(
    "UPDATE notifications SET read_at = ? WHERE id = ? AND user_id = ? AND read_at IS NULL",
    now(),
    id,
    userId,
  ) > 0;
}

export function markAllRead(userId: number): number {
  return changes(
    "UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL",
    now(),
    userId,
  );
}

export function deleteNotification(userId: number, id: number): boolean {
  return changes("DELETE FROM notifications WHERE id = ? AND user_id = ?", id, userId) > 0;
}

export function clearAll(userId: number): number {
  return changes("DELETE FROM notifications WHERE user_id = ?", userId);
}

export function unreadByRepo(userId: number): Array<{ repo_full_name: string; c: number }> {
  return all<{ repo_full_name: string; c: number }>(
    `SELECT repo_full_name, COUNT(*) AS c
       FROM notifications
      WHERE user_id = ? AND read_at IS NULL AND repo_full_name <> ''
      GROUP BY repo_full_name
      ORDER BY c DESC
      LIMIT 20`,
    userId,
  );
}

export function clearSubject(
  repoId: number,
  subjectType: string,
  subjectId: number,
): number {
  return changes(
    "DELETE FROM notifications WHERE repo_id = ? AND subject_type = ? AND subject_id = ?",
    repoId,
    subjectType,
    subjectId,
  );
}

export function markUnread(userId: number, id: number): boolean {
  return changes(
    "UPDATE notifications SET read_at = NULL WHERE id = ? AND user_id = ?",
    id,
    userId,
  ) > 0;
}

export function findNotification(userId: number, id: number): NotificationRow | null {
  return one<NotificationRow>(
    "SELECT * FROM notifications WHERE id = ? AND user_id = ?",
    id,
    userId,
  );
}

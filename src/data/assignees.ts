import { all, changes, now, one } from "../db/index.ts";
import { canRead, type RepoRecord } from "./repos.ts";
import type { Auth } from "../auth/service.ts";

export interface Assignee {
  id: number;
  username: string;
  display_name: string;
  avatar_hue: number;
  assigned_at: number;
}

type Subject = "issue" | "pull";

function subject(kind: Subject): { table: string; key: string; item: string } {
  return kind === "issue"
    ? { table: "issue_assignees", key: "issue_id", item: "issues" }
    : { table: "pull_assignees", key: "pull_id", item: "pulls" };
}

function assigneesFor(kind: Subject, itemId: number): Assignee[] {
  const { table, key } = subject(kind);
  return all<Assignee>(
    `SELECT u.id AS id, u.username AS username, u.display_name AS display_name,
            u.avatar_hue AS avatar_hue, a.assigned_at AS assigned_at
       FROM ${table} a
       JOIN users u ON u.id = a.user_id
      WHERE a.${key} = ?
      ORDER BY u.username ASC`,
    itemId,
  );
}

export function assigneesForItems(kind: Subject, itemIds: readonly number[]): Map<number, Assignee[]> {
  const result = new Map<number, Assignee[]>(itemIds.map((id) => [id, []]));
  if (itemIds.length === 0) return result;
  const { table, key } = subject(kind);
  const placeholders = itemIds.map(() => "?").join(",");
  const rows = all<{ item_id: number; id: number; username: string; display_name: string; avatar_hue: number; assigned_at: number }>(
    `SELECT a.${key} AS item_id, u.id AS id, u.username AS username,
            u.display_name AS display_name, u.avatar_hue AS avatar_hue, a.assigned_at AS assigned_at
       FROM ${table} a
       JOIN users u ON u.id = a.user_id
      WHERE a.${key} IN (${placeholders})
      ORDER BY u.username ASC`,
    ...itemIds,
  );
  for (const row of rows) {
    const { item_id: itemId, ...assignee } = row;
    result.get(itemId)?.push(assignee);
  }
  return result;
}

export function assignableUserIds(repo: RepoRecord, auth: Auth): number[] {
  if (auth.kind !== "user") return [];
  const ids = new Set<number>([repo.owner_id]);
  for (const row of all<{ user_id: number }>(
    "SELECT user_id FROM repo_collaborators WHERE repo_id = ?",
    repo.id,
  )) {
    ids.add(row.user_id);
  }
  if (repo.org_id !== null) {
    for (const row of all<{ user_id: number }>(
      "SELECT user_id FROM org_members WHERE org_id = ?",
      repo.org_id,
    )) {
      ids.add(row.user_id);
    }
  }
  if (auth.isAdmin) {
    if (repo.org_id === null) {
      for (const row of all<{ id: number }>("SELECT id FROM users")) ids.add(row.id);
    }
  }
  return [...ids].filter((id) => canRead(repo, { ...auth, userId: id }));
}

export function assignableUsers(repo: RepoRecord, auth: Auth): Assignee[] {
  const ids = assignableUserIds(repo, auth);
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => "?").join(",");
  return all<Omit<Assignee, "assigned_at"> & { assigned_at: number }>(
    `SELECT id, username, display_name, avatar_hue, 0 AS assigned_at
       FROM users WHERE id IN (${placeholders}) ORDER BY username ASC`,
    ...ids,
  );
}

export function isAssignable(repo: RepoRecord, auth: Auth, userId: number): boolean {
  return assignableUserIds(repo, auth).includes(userId);
}

export function addAssignees(
  kind: Subject,
  itemId: number,
  userIds: readonly number[],
  assignedBy: number,
): number {
  const { table, key } = subject(kind);
  const timestamp = now();
  let added = 0;
  for (const userId of new Set(userIds)) {
    added += changes(
      `INSERT OR IGNORE INTO ${table} (${key}, user_id, assigned_at, assigned_by) VALUES (?, ?, ?, ?)`,
      itemId,
      userId,
      timestamp,
      assignedBy,
    );
  }
  return added;
}

export function removeAssignees(kind: Subject, itemId: number, userIds: readonly number[]): number {
  const { table, key } = subject(kind);
  let removed = 0;
  for (const userId of new Set(userIds)) {
    removed += changes(
      `DELETE FROM ${table} WHERE ${key} = ? AND user_id = ?`,
      itemId,
      userId,
    );
  }
  return removed;
}

export function removeAssignee(kind: Subject, itemId: number, userId: number): boolean {
  const { table, key } = subject(kind);
  return changes(`DELETE FROM ${table} WHERE ${key} = ? AND user_id = ?`, itemId, userId) > 0;
}

export function setAssignees(
  kind: Subject,
  itemId: number,
  userIds: readonly number[],
  assignedBy: number,
): Assignee[] {
  const { table, key } = subject(kind);
  changes(`DELETE FROM ${table} WHERE ${key} = ?`, itemId);
  addAssignees(kind, itemId, userIds, assignedBy);
  return assigneesFor(kind, itemId);
}

export function issueAssignees(issueId: number): Assignee[] {
  return assigneesFor("issue", issueId);
}

export function pullAssignees(pullId: number): Assignee[] {
  return assigneesFor("pull", pullId);
}

export function userAsAssignee(userId: number): Assignee | null {
  const row = one<{ id: number; username: string; display_name: string; avatar_hue: number }>(
    "SELECT id, username, display_name, avatar_hue FROM users WHERE id = ?",
    userId,
  );
  if (!row) return null;
  return { ...row, assigned_at: now() };
}

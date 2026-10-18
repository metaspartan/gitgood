import { all, now, run } from "../db/index.ts";

export type ThreadKind = "issue" | "pull";

export type ThreadEventKind =
  | "closed"
  | "reopened"
  | "labeled"
  | "unlabeled"
  | "assigned"
  | "unassigned"
  | "milestone_changed"
  | "commented"
  | "merged"
  | "review_approved"
  | "review_requested";

export interface ThreadEventRow {
  id: number;
  repo_id: number;
  target_type: ThreadKind;
  target_id: number;
  actor_id: number | null;
  actor_name: string;
  kind: ThreadEventKind;
  detail: string;
  created_at: number;
}

export interface ThreadEvent extends Omit<ThreadEventRow, "detail" | "actor_id"> {
  detail: Record<string, unknown>;
  actor: { id: number | null; username: string; display_name: string | null } | null;
}

function parseDetail(raw: string): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

const ACTOR_BATCH = 200;

export function record(input: {
  repoId: number;
  targetType: ThreadKind;
  targetId: number;
  kind: ThreadEventKind;
  actor?: { id: number; username: string } | null;
  detail?: Record<string, unknown>;
  createdAt?: number;
}): number {
  return run(
    `INSERT INTO thread_events
       (repo_id, target_type, target_id, actor_id, actor_name, kind, detail, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    input.repoId,
    input.targetType,
    input.targetId,
    input.actor?.id ?? null,
    input.actor?.username ?? "",
    input.kind,
    JSON.stringify(input.detail ?? {}),
    input.createdAt ?? now(),
  );
}

function attachActors(rows: ThreadEventRow[]): ThreadEvent[] {
  const ids = [...new Set(rows.map((row) => row.actor_id).filter((id): id is number => id !== null))];
  const profiles = new Map<number, { username: string; display_name: string | null }>();
  if (ids.length > 0 && ids.length <= ACTOR_BATCH) {
    const placeholders = ids.map(() => "?").join(",");
    for (const user of all<{ id: number; username: string; display_name: string }>(
      `SELECT id, username, display_name FROM users WHERE id IN (${placeholders})`,
      ...ids,
    )) {
      profiles.set(user.id, { username: user.username, display_name: user.display_name || null });
    }
  }
  return rows.map((row) => {
    if (row.actor_id === null && row.actor_name === "") {
      return { ...row, detail: parseDetail(row.detail), actor: null };
    }
    const profile = row.actor_id === null ? undefined : profiles.get(row.actor_id);
    return {
      ...row,
      detail: parseDetail(row.detail),
      actor: {
        id: row.actor_id,
        username: profile?.username ?? row.actor_name,
        display_name: profile?.display_name ?? null,
      },
    };
  });
}

export function listEvents(
  repoId: number,
  targetType: ThreadKind,
  targetId: number,
  options: { limit?: number; offset?: number } = {},
): ThreadEvent[] {
  const limit = Math.max(1, Math.min(options.limit ?? 50, 200));
  const offset = Math.max(0, options.offset ?? 0);
  return attachActors(
    all<ThreadEventRow>(
      `SELECT * FROM thread_events
        WHERE repo_id = ? AND target_type = ? AND target_id = ?
        ORDER BY id ASC LIMIT ? OFFSET ?`,
      repoId,
      targetType,
      targetId,
      limit,
      offset,
    ),
  );
}

export function countEvents(repoId: number, targetType: ThreadKind, targetId: number): number {
  return all<{ n: number }>(
    `SELECT COUNT(*) AS n FROM thread_events
      WHERE repo_id = ? AND target_type = ? AND target_id = ?`,
    repoId,
    targetType,
    targetId,
  )[0]?.n ?? 0;
}

export function recordLabelChange(
  repoId: number,
  targetType: ThreadKind,
  targetId: number,
  before: readonly string[],
  after: readonly string[],
  actor: { id: number; username: string } | null,
): void {
  const previous = new Set(before);
  const next = new Set(after);
  for (const name of after) {
    if (previous.has(name)) continue;
    record({ repoId, targetType, targetId, kind: "labeled", actor, detail: { label: name } });
  }
  for (const name of before) {
    if (next.has(name)) continue;
    record({ repoId, targetType, targetId, kind: "unlabeled", actor, detail: { label: name } });
  }
}

export function recordAssigneeChange(
  repoId: number,
  targetType: ThreadKind,
  targetId: number,
  before: readonly string[],
  after: readonly string[],
  actor: { id: number; username: string } | null,
): void {
  const previous = new Set(before);
  const next = new Set(after);
  for (const name of after) {
    if (previous.has(name)) continue;
    record({ repoId, targetType, targetId, kind: "assigned", actor, detail: { assignee: name } });
  }
  for (const name of before) {
    if (next.has(name)) continue;
    record({ repoId, targetType, targetId, kind: "unassigned", actor, detail: { assignee: name } });
  }
}

export function recordMilestoneChange(
  repoId: number,
  targetType: ThreadKind,
  targetId: number,
  before: string | null,
  after: string | null,
  actor: { id: number; username: string } | null,
): void {
  if (before === after) return;
  record({
    repoId,
    targetType,
    targetId,
    kind: "milestone_changed",
    actor,
    detail: { from: before, to: after },
  });
}

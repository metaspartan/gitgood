import { all, changes, now, run } from "../db/index.ts";

export const REACTIONS = ["+1", "-1", "laugh", "hooray", "confused", "heart", "rocket", "eyes"] as const;
export type ReactionContent = (typeof REACTIONS)[number];

export interface ReactionSummary {
  content: ReactionContent;
  count: number;
  me: boolean;
}

export function addReaction(commentId: number, userId: number, content: ReactionContent): void {
  run("INSERT OR IGNORE INTO reactions (comment_id, user_id, content, created_at) VALUES (?, ?, ?, ?)", commentId, userId, content, now());
}

export function removeReaction(commentId: number, userId: number, content: ReactionContent): void {
  changes("DELETE FROM reactions WHERE comment_id = ? AND user_id = ? AND content = ?", commentId, userId, content);
}

export function reactionSummaries(commentIds: readonly number[], viewerId: number | null): Map<number, ReactionSummary[]> {
  const result = new Map<number, ReactionSummary[]>();
  if (commentIds.length === 0) return result;
  const placeholders = commentIds.map(() => "?").join(",");
  const rows = all<{ comment_id: number; content: ReactionContent; count: number; me: number }>(
    `SELECT comment_id, content, COUNT(*) AS count, MAX(user_id = ?) AS me
       FROM reactions WHERE comment_id IN (${placeholders})
      GROUP BY comment_id, content`,
    viewerId ?? -1,
    ...commentIds,
  );
  for (const row of rows) {
    const list = result.get(row.comment_id) ?? [];
    list.push({ content: row.content, count: row.count, me: row.me === 1 });
    result.set(row.comment_id, list);
  }
  for (const list of result.values()) list.sort((a, b) => REACTIONS.indexOf(a.content) - REACTIONS.indexOf(b.content));
  return result;
}

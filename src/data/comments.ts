import { all, changes, now, one, run, scalar } from "../db/index.ts";
import { notFound } from "../lib/errors.ts";

export type CommentTarget = "issue" | "pull";

export interface CommentRow {
  id: number;
  repo_id: number;
  target_type: CommentTarget;
  target_id: number;
  author_id: number;
  body: string;
  created_at: number;
  updated_at?: number | null;
}

export interface CommentWithAuthor extends CommentRow {
  author_username: string;
  author_display: string;
  author_hue: number;
}

const SELECT_COMMENT = `
  SELECT c.*, u.username AS author_username, u.display_name AS author_display, u.avatar_hue AS author_hue
  FROM comments c JOIN users u ON u.id = c.author_id`;

export function addComment(
  repoId: number,
  targetType: CommentTarget,
  targetId: number,
  authorId: number,
  body: string,
): CommentWithAuthor {
  const id = run(
    `INSERT INTO comments (repo_id, target_type, target_id, author_id, body, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    repoId,
    targetType,
    targetId,
    authorId,
    body.trim(),
    now(),
  );
  const created = one<CommentWithAuthor>(`${SELECT_COMMENT} WHERE c.id = ?`, id);
  if (!created) throw notFound("Comment not found after creation");
  return created;
}

export function listComments(
  repoId: number,
  targetType: CommentTarget,
  targetId: number,
): CommentWithAuthor[] {
  return all<CommentWithAuthor>(
    `${SELECT_COMMENT} WHERE c.repo_id = ? AND c.target_type = ? AND c.target_id = ? ORDER BY c.id ASC`,
    repoId,
    targetType,
    targetId,
  );
}

export function findComment(repoId: number, commentId: number): CommentWithAuthor | null {
  return one<CommentWithAuthor>(`${SELECT_COMMENT} WHERE c.id = ? AND c.repo_id = ?`, commentId, repoId);
}

export function updateComment(commentId: number, body: string): void {
  changes("UPDATE comments SET body = ?, updated_at = ? WHERE id = ?", body.trim(), now(), commentId);
}

export function removeComment(commentId: number): boolean {
  return changes("DELETE FROM comments WHERE id = ?", commentId) > 0;
}

export function countComments(targetType: CommentTarget, targetId: number): number {
  return (
    scalar<number>(
      "SELECT COUNT(*) FROM comments WHERE target_type = ? AND target_id = ?",
      targetType,
      targetId,
    ) ?? 0
  );
}

export function deleteComment(commentId: number, authorId: number): boolean {
  return changes("DELETE FROM comments WHERE id = ? AND author_id = ?", commentId, authorId) > 0;
}

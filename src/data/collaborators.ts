import { all, changes, one, scalar } from "../db/index.ts";

export type CollaboratorPermission = "read" | "write";

export interface Collaborator {
  user_id: number;
  username: string;
  display_name: string;
  avatar_hue: number;
  permission: CollaboratorPermission;
  created_at: number;
}

export function collaboratorPermission(repoId: number, userId: number): CollaboratorPermission | null {
  const row = one<{ permission: CollaboratorPermission }>(
    "SELECT permission FROM repo_collaborators WHERE repo_id = ? AND user_id = ?",
    repoId,
    userId,
  );
  return row?.permission ?? null;
}

export function listCollaborators(repoId: number): Collaborator[] {
  return all<Collaborator>(
    `SELECT c.user_id AS user_id, u.username AS username, u.display_name AS display_name,
            u.avatar_hue AS avatar_hue, c.permission AS permission, c.created_at AS created_at
       FROM repo_collaborators c
       JOIN users u ON u.id = c.user_id
      WHERE c.repo_id = ?
      ORDER BY u.username ASC`,
    repoId,
  );
}

export function addCollaborator(repoId: number, userId: number, permission: CollaboratorPermission): void {
  changes(
    `INSERT INTO repo_collaborators (repo_id, user_id, permission, created_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT (repo_id, user_id) DO UPDATE SET permission = excluded.permission`,
    repoId,
    userId,
    permission,
    Date.now(),
  );
}

export function removeCollaborator(repoId: number, userId: number): boolean {
  return changes("DELETE FROM repo_collaborators WHERE repo_id = ? AND user_id = ?", repoId, userId) > 0;
}

export function collaboratorCount(repoId: number): number {
  return Number(scalar<number>("SELECT COUNT(*) FROM repo_collaborators WHERE repo_id = ?", repoId) ?? 0);
}

import { all, changes, now, one, run, scalar } from "../db/index.ts";
import { conflict, notFound } from "../lib/errors.ts";

export interface LockRow {
  id: number;
  repo_id: number;
  path: string;
  user_id: number;
  created_at: number;
}

export interface LockWithOwner extends LockRow {
  owner_username: string;
}

const SELECT_LOCK = `
  SELECT l.*, u.username AS owner_username
  FROM lfs_locks l JOIN users u ON u.id = l.user_id`;

export function createLock(repoId: number, path: string, userId: number): LockWithOwner {
  const existing = one<LockWithOwner>(`${SELECT_LOCK} WHERE l.repo_id = ? AND l.path = ?`, repoId, path);
  if (existing) {
    if (existing.user_id === userId) return existing;
    throw conflict(`Path "${path}" is already locked by ${existing.owner_username}`);
  }
  const id = run(
    "INSERT INTO lfs_locks (repo_id, path, user_id, created_at) VALUES (?, ?, ?, ?)",
    repoId,
    path,
    userId,
    now(),
  );
  const created = one<LockWithOwner>(`${SELECT_LOCK} WHERE l.id = ?`, id);
  if (!created) throw notFound("Lock not found after creation");
  return created;
}

export function listLocks(repoId: number, options: { path?: string; id?: number } = {}): LockWithOwner[] {
  if (options.id !== undefined) {
    return all<LockWithOwner>(`${SELECT_LOCK} WHERE l.repo_id = ? AND l.id = ?`, repoId, options.id);
  }
  if (options.path !== undefined) {
    return all<LockWithOwner>(`${SELECT_LOCK} WHERE l.repo_id = ? AND l.path = ?`, repoId, options.path);
  }
  return all<LockWithOwner>(`${SELECT_LOCK} WHERE l.repo_id = ? ORDER BY l.id DESC`, repoId);
}

export function deleteLock(repoId: number, id: number, userId: number | null): LockWithOwner | null {
  const lock = one<LockWithOwner>(`${SELECT_LOCK} WHERE l.repo_id = ? AND l.id = ?`, repoId, id);
  if (!lock) return null;
  if (userId !== null && lock.user_id !== userId) return null;
  changes("DELETE FROM lfs_locks WHERE id = ?", id);
  return lock;
}

export function countLocks(repoId: number): number {
  return scalar<number>("SELECT COUNT(*) FROM lfs_locks WHERE repo_id = ?", repoId) ?? 0;
}

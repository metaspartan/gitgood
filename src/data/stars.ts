import { all, changes, now, one, run, scalar } from "../db/index.ts";
import { repoCountsProjection, type RepoWithCounts } from "./repos.ts";

export interface StargazerHit {
  username: string;
  display_name: string;
  avatar_hue: number;
  starred_at: number;
}

export function isStarred(repoId: number, userId: number | null): boolean {
  if (userId === null) return false;
  const row = one<{ c: number }>(
    "SELECT COUNT(*) AS c FROM stars WHERE repo_id = ? AND user_id = ?",
    repoId,
    userId,
  );
  return (row?.c ?? 0) > 0;
}

export function starCount(repoId: number): number {
  return scalar<number>("SELECT COUNT(*) FROM stars WHERE repo_id = ?", repoId) ?? 0;
}

export function star(repoId: number, userId: number): void {
  run(
    "INSERT OR IGNORE INTO stars (user_id, repo_id, created_at) VALUES (?, ?, ?)",
    userId,
    repoId,
    now(),
  );
}

export function unstar(repoId: number, userId: number): void {
  changes("DELETE FROM stars WHERE repo_id = ? AND user_id = ?", repoId, userId);
}

export function listStargazers(repoId: number, limit = 100): StargazerHit[] {
  return all<StargazerHit>(
    `SELECT u.username, u.display_name, u.avatar_hue, s.created_at AS starred_at
       FROM stars s JOIN users u ON u.id = s.user_id
      WHERE s.repo_id = ?
      ORDER BY s.created_at DESC, s.rowid DESC
      LIMIT ?`,
    repoId,
    limit,
  );
}

export function listStarredByUser(userId: number, limit = 100): RepoWithCounts[] {
  return all<RepoWithCounts>(
    `${repoCountsProjection()}
       JOIN stars st ON st.repo_id = r.id
      WHERE st.user_id = ?
      ORDER BY st.created_at DESC, st.rowid DESC
      LIMIT ?`,
    userId,
    limit,
  );
}

export const WATCH_LEVELS = ["participating", "all", "ignore"] as const;
export type WatchLevel = (typeof WATCH_LEVELS)[number];

export function watchLevel(repoId: number, userId: number | null): WatchLevel {
  if (userId === null) return "participating";
  const row = one<{ level: string }>("SELECT level FROM watches WHERE repo_id = ? AND user_id = ?", repoId, userId);
  return row?.level === "ignore" ? "ignore" : row ? "all" : "participating";
}

export function isWatching(repoId: number, userId: number | null): boolean {
  return watchLevel(repoId, userId) === "all";
}

export function isIgnoring(repoId: number, userId: number): boolean {
  return watchLevel(repoId, userId) === "ignore";
}

export function setWatchLevel(repoId: number, userId: number, level: WatchLevel): void {
  if (level === "participating") {
    changes("DELETE FROM watches WHERE repo_id = ? AND user_id = ?", repoId, userId);
    return;
  }
  run(
    `INSERT INTO watches (user_id, repo_id, created_at, level) VALUES (?, ?, ?, ?)
     ON CONFLICT(user_id, repo_id) DO UPDATE SET level = excluded.level`,
    userId,
    repoId,
    now(),
    level,
  );
}

export function watch(repoId: number, userId: number): void {
  setWatchLevel(repoId, userId, "all");
}

export function unwatch(repoId: number, userId: number): void {
  setWatchLevel(repoId, userId, "participating");
}

export function watcherCount(repoId: number): number {
  return scalar<number>("SELECT COUNT(*) FROM watches WHERE repo_id = ? AND level = 'all'", repoId) ?? 0;
}

export function watcherIds(repoId: number): number[] {
  return all<{ user_id: number }>("SELECT user_id FROM watches WHERE repo_id = ? AND level = 'all'", repoId).map(
    (row) => row.user_id,
  );
}

export function listWatchers(repoId: number, limit = 100): StargazerHit[] {
  return all<StargazerHit>(
    `SELECT u.username, u.display_name, u.avatar_hue, w.created_at AS starred_at
       FROM watches w JOIN users u ON u.id = w.user_id
      WHERE w.repo_id = ? AND w.level = 'all'
      ORDER BY w.created_at DESC, w.rowid DESC
      LIMIT ?`,
    repoId,
    limit,
  );
}

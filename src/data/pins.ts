import { all, changes, run, transaction } from "../db/index.ts";

export const MAX_PINS = 6;

export function pinnedRepoIds(userId: number): number[] {
  return all<{ repo_id: number }>("SELECT repo_id FROM user_pins WHERE user_id = ? ORDER BY position", userId).map((row) => row.repo_id);
}

export function setPins(userId: number, repoIds: readonly number[]): void {
  transaction(() => {
    changes("DELETE FROM user_pins WHERE user_id = ?", userId);
    repoIds.forEach((repoId, position) => run("INSERT INTO user_pins (user_id, repo_id, position) VALUES (?, ?, ?)", userId, repoId, position));
  });
}

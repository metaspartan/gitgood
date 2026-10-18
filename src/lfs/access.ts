import { one } from "../db/index.ts";
import type { RepoRecord } from "../data/repos.ts";

const MAX_FORK_HOPS = 16;

export function repoCanAccessObject(repo: Pick<RepoRecord, "id">, oid: string): boolean {
  let current: number | null = repo.id;
  for (let hop = 0; current !== null && hop < MAX_FORK_HOPS; hop += 1) {
    if (one<{ ok: number }>("SELECT 1 AS ok FROM lfs_repo_objects WHERE repo_id = ? AND oid = ?", current, oid)) return true;
    current = one<{ fork_of: number | null }>("SELECT fork_of FROM repos WHERE id = ?", current)?.fork_of ?? null;
  }
  return false;
}

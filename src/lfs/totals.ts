import { all } from "../db/index.ts";

export interface LfsTotals {
  lfsObjects: number;
  lfsBytes: number;
}

const TTL_MS = 5 * 60 * 1000;
const EMPTY: LfsTotals = Object.freeze({ lfsObjects: 0, lfsBytes: 0 });

let cache: Map<number, LfsTotals> | null = null;
let computedAt = 0;

function load(): Map<number, LfsTotals> {
  const now = Date.now();
  if (cache && now - computedAt < TTL_MS) return cache;
  const rows = all<{ repo_id: number; c: number; b: number }>(
    `SELECT ro.repo_id, COUNT(*) AS c, SUM(o.size) AS b
       FROM lfs_repo_objects ro JOIN lfs_objects o ON o.oid = ro.oid
      GROUP BY ro.repo_id`,
  );
  const next = new Map<number, LfsTotals>();
  for (const row of rows) next.set(row.repo_id, { lfsObjects: row.c, lfsBytes: row.b ?? 0 });
  cache = next;
  computedAt = now;
  return next;
}

export function lfsTotalsFor(repoId: number): LfsTotals {
  return load().get(repoId) ?? EMPTY;
}

export function invalidateLfsTotals(): void {
  cache = null;
}

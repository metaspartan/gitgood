import { all, changes, now, one, run } from "../db/index.ts";
import { gitBytes, gitStdout } from "../git/run.ts";
import { log } from "../lib/logger.ts";
import { findRepoById, repoDiskPath } from "../data/repos.ts";
import { isValidOid } from "./store.ts";
import { parseLfsPointer } from "./pointer.ts";
import { invalidateLfsTotals } from "./totals.ts";

export interface LfsUsage {
  objects: number;
  bytes: number;
}

export function recordRepoObject(repoId: number, oid: string): void {
  if (!isValidOid(oid)) return;
  run("INSERT OR IGNORE INTO lfs_repo_objects (repo_id, oid, created_at) VALUES (?, ?, ?)", repoId, oid, now());
  invalidateLfsTotals();
}

export function repoLfsUsage(repoId: number): LfsUsage {
  const row = one<{ objects: number; bytes: number }>(
    `SELECT COUNT(*) AS objects, COALESCE(SUM(o.size), 0) AS bytes
       FROM lfs_repo_objects ro JOIN lfs_objects o ON o.oid = ro.oid
      WHERE ro.repo_id = ?`,
    repoId,
  );
  return { objects: row?.objects ?? 0, bytes: row?.bytes ?? 0 };
}

const MAX_POINTER_BYTES = 1024;
const MIN_POINTER_BYTES = 100;

export async function scanRepoPointers(repoId: number, diskPath: string): Promise<number> {
  const listing = await gitStdout(
    ["cat-file", "--batch-all-objects", "--unordered", "--batch-check=%(objecttype) %(objectsize) %(objectname)"],
    { cwd: diskPath, timeoutMs: 120_000 },
  );
  const candidates: string[] = [];
  for (const line of listing.split("\n")) {
    if (!line.startsWith("blob ")) continue;
    const [, sizeText, name] = line.split(" ");
    const size = Number(sizeText);
    if (name && size >= MIN_POINTER_BYTES && size <= MAX_POINTER_BYTES) candidates.push(name);
  }

  const oids = new Set<string>();
  const BATCH = 2000;
  for (let start = 0; start < candidates.length; start += BATCH) {
    const names = candidates.slice(start, start + BATCH);
    const output = await gitBytes(["cat-file", "--batch"], {
      cwd: diskPath,
      input: `${names.join("\n")}\n`,
      timeoutMs: 120_000,
    });
    for (const content of splitBatchOutput(output)) {
      const pointer = parseLfsPointer(content);
      if (pointer && isValidOid(pointer.oid)) oids.add(pointer.oid);
    }
  }

  const stamp = now();
  for (const oid of oids) {
    run("INSERT OR IGNORE INTO lfs_repo_objects (repo_id, oid, created_at) VALUES (?, ?, ?)", repoId, oid, stamp);
  }
  invalidateLfsTotals();
  run(
    "INSERT OR REPLACE INTO lfs_repo_scans (repo_id, scanned_at, pointers) VALUES (?, ?, ?)",
    repoId,
    stamp,
    oids.size,
  );
  return oids.size;
}

export function splitBatchOutput(output: Uint8Array): Uint8Array[] {
  const records: Uint8Array[] = [];
  const decoder = new TextDecoder();
  let offset = 0;
  while (offset < output.length) {
    const headerEnd = output.indexOf(0x0a, offset);
    if (headerEnd === -1) break;
    const header = decoder.decode(output.subarray(offset, headerEnd));
    offset = headerEnd + 1;
    const parts = header.split(" ");
    if (parts[1] === "missing" || parts.length < 3) continue;
    const size = Number(parts[2]);
    if (!Number.isFinite(size) || size < 0 || offset + size > output.length) break;
    records.push(output.subarray(offset, offset + size));
    offset += size + 1;
  }
  return records;
}

let backfillRunning = false;

export async function backfillLfsUsage(): Promise<{ scanned: number; failed: number }> {
  if (backfillRunning) return { scanned: 0, failed: 0 };
  backfillRunning = true;
  let scanned = 0;
  let failed = 0;
  try {
    const pending = all<{ id: number }>(
      `SELECT r.id FROM repos r
        WHERE NOT EXISTS (SELECT 1 FROM lfs_repo_scans s WHERE s.repo_id = r.id)
        ORDER BY r.id`,
    );
    for (const repo of pending) {
      try {
        const record = findRepoById(repo.id);
        if (!record) continue;
        await scanRepoPointers(repo.id, repoDiskPath(record));
        scanned += 1;
      } catch (error) {
        failed += 1;
        log.warn("lfs usage backfill skipped a repository", {
          repo_id: repo.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  } finally {
    backfillRunning = false;
  }
  if (scanned > 0 || failed > 0) log.info("lfs usage backfill finished", { scanned, failed });
  return { scanned, failed };
}

export function resetLfsScans(): number {
  return changes("DELETE FROM lfs_repo_scans");
}

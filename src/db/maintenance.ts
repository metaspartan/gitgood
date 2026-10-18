import { config } from "../config.ts";
import { log } from "../lib/logger.ts";
import { gaugeValue, increment, setGauge } from "../lib/metrics.ts";
import { db, one } from "./index.ts";

export interface DatabaseHealth {
  pageBytes: number;
  pageCount: number;
  freePages: number;
  walBytes: number;
  walBusy: boolean;
  analyzed: boolean;
}

export function databaseHealth(): DatabaseHealth {
  const pageSize = one<{ page_size: number }>("PRAGMA page_size")?.page_size ?? 4096;
  const pageCount = one<{ page_count: number }>("PRAGMA page_count")?.page_count ?? 0;
  const freePages = one<{ freelist_count: number }>("PRAGMA freelist_count")?.freelist_count ?? 0;

  let walBytes = 0;
  let walBusy = false;
  try {
    const row = one<{ busy: number; log: number }>("PRAGMA wal_checkpoint(PASSIVE)");
    walBytes = (row?.log ?? 0) * pageSize;
    walBusy = (row?.busy ?? 0) !== 0;
  } catch {
  }

  const analyzed =
    (one<{ c: number }>(
      "SELECT COUNT(*) AS c FROM sqlite_master WHERE type = 'table' AND name = 'sqlite_stat1'",
    )?.c ?? 0) > 0;

  return {
    pageBytes: pageCount * pageSize,
    pageCount,
    freePages,
    walBytes,
    walBusy,
    analyzed,
  };
}

export function checkpoint(force = false): { checkpointed: boolean; walBytes: number } {
  const before = databaseHealth();
  const threshold = 16 * 1024 * 1024;
  if (!force && before.walBytes < threshold) {
    return { checkpointed: false, walBytes: before.walBytes };
  }

  try {
    const row = one<{ busy: number }>("PRAGMA wal_checkpoint(TRUNCATE)");
    const busy = (row?.busy ?? 0) !== 0;
    const after = databaseHealth();
    setGauge("sqlite_wal_bytes", after.walBytes);
    if (busy) {
      increment("sqlite_checkpoints_blocked_total");
    } else {
      increment("sqlite_checkpoints_total");
    }
    return { checkpointed: !busy, walBytes: after.walBytes };
  } catch (error) {
    log.warn("wal checkpoint failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    return { checkpointed: false, walBytes: before.walBytes };
  }
}

export function analyze(): void {
  try {
    db.exec("ANALYZE");
    increment("sqlite_analyze_total");
    log.info("sqlite statistics refreshed");
  } catch (error) {
    log.warn("sqlite analyze failed", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

let timer: ReturnType<typeof setInterval> | null = null;

export function startDatabaseMaintenance(): void {
  if (timer !== null) return;
  const intervalMs = Math.max(60_000, config.dbMaintenanceIntervalMs);
  let passes = 0;

  timer = setInterval(() => {
    passes += 1;
    const result = checkpoint();
    setGauge("sqlite_wal_bytes", result.walBytes);
    setGauge("sqlite_page_bytes", databaseHealth().pageBytes);
    if (passes % 8 === 0) analyze();
  }, intervalMs);
}

export function stopDatabaseMaintenance(): void {
  if (timer !== null) {
    clearInterval(timer);
    timer = null;
  }
}

export function reportDatabaseHealth(): DatabaseHealth {
  const health = databaseHealth();
  setGauge("sqlite_page_bytes", health.pageBytes);
  setGauge("sqlite_wal_bytes", health.walBytes);
  setGauge("sqlite_free_pages", health.freePages);
  void gaugeValue;
  return health;
}

import { join } from "node:path";
import { config } from "../config.ts";
import type { FilesystemSample, StorageWorkerResult } from "./storage-worker.ts";
import type { StorageRoots, StorageScanReport } from "./storage-scan.ts";

export const STORAGE_CACHE_MS = 5 * 60 * 1000;
export const STORAGE_SCAN_TIMEOUT_MS = 60_000;

export type StorageStatus = "scanning" | "current" | "stale" | "error";

export interface StorageOverview {
  status: StorageStatus;
  sampledAt: number | null;
  scanning: boolean;
  stale: boolean;
  error: string | null;
  repositories: StorageScanReport["repositories"] | null;
  lfs: StorageScanReport["lfs"] | null;
  releaseAssets: StorageScanReport["releaseAssets"] | null;
  database: StorageScanReport["database"] | null;
  trackedBytes: number | null;
  trackedFiles: number | null;
  truncated: boolean;
  filesystems: FilesystemSample[];
  filesystemsAdditive: boolean;
  quota: null;
  readiness: null;
  labels: {
    quota: "No storage quota is configured or enforced by this overview";
    readiness: "This overview does not report instance readiness";
    measurement: "Logical file bytes inside configured storage roots; symbolic links are not followed";
  };
}

interface CacheState {
  value: StorageWorkerResult | null;
  error: string | null;
  failedAt: number;
  flight: Promise<void> | null;
}

export interface StorageScanner {
  snapshot(): StorageOverview;
  reset(): void;
}

interface ScannerOptions {
  now?: () => number;
  spawn?: (roots: StorageRoots, timeoutMs: number) => Promise<StorageWorkerResult>;
  cacheMs?: number;
  timeoutMs?: number;
  roots?: StorageRoots;
}

function rootsFromConfig(): StorageRoots {
  return {
    repoRoot: config.repoRoot,
    lfsRoot: config.lfsRoot,
    releasesRoot: join(config.dataDir, "releases"),
    dbPath: config.dbPath,
  };
}

function emptyOverview(status: StorageStatus, scanning: boolean, error: string | null): StorageOverview {
  return {
    status,
    sampledAt: null,
    scanning,
    stale: false,
    error,
    repositories: null,
    lfs: null,
    releaseAssets: null,
    database: null,
    trackedBytes: null,
    trackedFiles: null,
    truncated: false,
    filesystems: [],
    filesystemsAdditive: false,
    quota: null,
    readiness: null,
    labels: {
      quota: "No storage quota is configured or enforced by this overview",
      readiness: "This overview does not report instance readiness",
      measurement: "Logical file bytes inside configured storage roots; symbolic links are not followed",
    },
  };
}

function present(value: StorageWorkerResult, status: StorageStatus, scanning: boolean, error: string | null, now: number, cacheMs: number): StorageOverview {
  const stale = now - value.sampledAt > cacheMs;
  return {
    status: stale && status === "current" ? "stale" : status,
    sampledAt: value.sampledAt,
    scanning,
    stale,
    error,
    repositories: value.scan.repositories,
    lfs: value.scan.lfs,
    releaseAssets: value.scan.releaseAssets,
    database: value.scan.database,
    trackedBytes: value.scan.trackedBytes,
    trackedFiles: value.scan.trackedFiles,
    truncated: value.scan.truncated,
    filesystems: value.filesystems.map((sample) => ({ id: sample.additive && value.filesystems.length === 1 ? "shared" : "distinct", totalBytes: sample.totalBytes, availableBytes: sample.availableBytes, additive: value.filesystems.length === 1 && sample.additive })),
    filesystemsAdditive: value.filesystems.length === 1 && value.filesystems.every((sample) => sample.additive),
    quota: null,
    readiness: null,
    labels: {
      quota: "No storage quota is configured or enforced by this overview",
      readiness: "This overview does not report instance readiness",
      measurement: "Logical file bytes inside configured storage roots; symbolic links are not followed",
    },
  };
}

export async function runStorageWorker(roots: StorageRoots, timeoutMs: number): Promise<StorageWorkerResult> {
  const child = Bun.spawn([process.execPath, join(import.meta.dir, "storage-worker.ts"), JSON.stringify(roots)], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
  try {
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    if (code !== 0) throw new Error(stderr.trim() || "Storage scan failed");
    return JSON.parse(stdout) as StorageWorkerResult;
  } finally {
    clearTimeout(timer);
  }
}

export function createStorageScanner(options: ScannerOptions = {}): StorageScanner {
  const now = options.now ?? (() => Date.now());
  const spawn = options.spawn ?? runStorageWorker;
  const cacheMs = options.cacheMs ?? STORAGE_CACHE_MS;
  const timeoutMs = options.timeoutMs ?? STORAGE_SCAN_TIMEOUT_MS;
  const roots = options.roots ?? rootsFromConfig();
  const state: CacheState = { value: null, error: null, failedAt: 0, flight: null };

  const start = (): void => {
    if (state.flight) return;
    const current = now();
    const fresh = state.value !== null && current - state.value.sampledAt < cacheMs && state.error === null;
    const coolingDown = state.error !== null && current - state.failedAt < cacheMs;
    if (fresh || coolingDown) return;
    state.flight = spawn(roots, timeoutMs)
      .then((result) => {
        state.value = result;
        state.error = null;
        state.failedAt = 0;
      })
      .catch(() => {
        state.error = "Storage scan failed or timed out; previous sample retained when available";
        state.failedAt = now();
      })
      .finally(() => {
        state.flight = null;
      });
  };

  return {
    snapshot(): StorageOverview {
      start();
      if (state.value) {
        const status: StorageStatus = state.flight ? "scanning" : state.error ? "stale" : "current";
        return present(state.value, status, state.flight !== null, state.error, now(), cacheMs);
      }
      if (state.flight) return emptyOverview("scanning", true, null);
      return emptyOverview("error", false, state.error ?? "Storage scan has not completed");
    },
    reset(): void {
      state.value = null;
      state.error = null;
      state.failedAt = 0;
      state.flight = null;
    },
  };
}

let shared: StorageScanner | null = null;

export function storageOverview(): StorageOverview {
  shared ??= createStorageScanner();
  return shared.snapshot();
}

export function resetStorageOverview(): void {
  shared?.reset();
  shared = null;
}

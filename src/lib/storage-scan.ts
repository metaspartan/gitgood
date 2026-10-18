import { lstatSync, opendirSync, type Stats } from "node:fs";
import { resolve, sep } from "node:path";

export const STORAGE_SCAN_LIMITS = {
  maxFiles: 250_000,
  maxDepth: 48,
  maxEntriesPerDirectory: 20_000,
  maxEntries: 1_000_000,
};

export interface StorageCategory {
  bytes: number;
  files: number;
}

export interface StorageScanReport {
  repositories: StorageCategory;
  lfs: StorageCategory;
  releaseAssets: StorageCategory;
  database: StorageCategory;
  trackedBytes: number;
  trackedFiles: number;
  truncated: boolean;
}

export interface StorageRoots {
  repoRoot: string;
  lfsRoot: string;
  releasesRoot: string;
  dbPath: string;
}

interface MutableCategory {
  bytes: number;
  files: number;
}

interface WalkState {
  truncated: boolean;
  seen: Set<string>;
  entries: number;
}

function emptyCategory(): MutableCategory {
  return { bytes: 0, files: 0 };
}

function withinRoot(root: string, candidate: string): boolean {
  const base = resolve(root);
  const target = resolve(candidate);
  return target === base || target.startsWith(base.endsWith(sep) ? base : base + sep);
}

function recordFile(category: MutableCategory, stats: Stats): void {
  category.files += 1;
  category.bytes += stats.size;
}

function walkDirectory(root: string, category: MutableCategory, state: WalkState, limits: typeof STORAGE_SCAN_LIMITS, depth = 0): void {
  if (depth > limits.maxDepth || state.entries >= limits.maxEntries) { state.truncated = true; return; }
  try {
    const stats = lstatSync(root);
    if (stats.isSymbolicLink()) { state.truncated = true; return; }
    if (!stats.isDirectory()) { state.truncated = true; return; }
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== "ENOENT") state.truncated = true;
    return;
  }
  const dir = opendirSync(root);
  let count = 0;
  try {
    for (let entry = dir.readSync(); entry; entry = dir.readSync()) {
      if (count++ >= limits.maxEntriesPerDirectory || category.files >= limits.maxFiles || state.entries++ >= limits.maxEntries) { state.truncated = true; break; }
      const path = resolve(root, entry.name);
      if (!withinRoot(root, path) || state.seen.has(path)) continue;
      state.seen.add(path);
      let stats: Stats;
      try { stats = lstatSync(path); }
      catch { state.truncated = true; continue; }
      if (stats.isSymbolicLink()) continue;
      if (stats.isDirectory()) walkDirectory(path, category, state, limits, depth + 1);
      else if (stats.isFile()) recordFile(category, stats);
    }
  } finally { dir.closeSync(); }
}

function measureFiles(paths: readonly string[], category: MutableCategory): void {
  for (const path of paths) {
    try {
      const stats = lstatSync(path);
      if (stats.isSymbolicLink() || !stats.isFile()) continue;
      recordFile(category, stats);
    } catch {
      continue;
    }
  }
}

export function scanStorage(roots: StorageRoots, limits: typeof STORAGE_SCAN_LIMITS = STORAGE_SCAN_LIMITS): StorageScanReport {
  const repositories = emptyCategory();
  const lfs = emptyCategory();
  const releaseAssets = emptyCategory();
  const database = emptyCategory();
  const state: WalkState = { truncated: false, seen: new Set(), entries: 0 };
  walkDirectory(roots.repoRoot, repositories, state, limits);
  walkDirectory(roots.lfsRoot, lfs, state, limits);
  walkDirectory(roots.releasesRoot, releaseAssets, state, limits);
  measureFiles([roots.dbPath, `${roots.dbPath}-wal`, `${roots.dbPath}-shm`], database);
  return {
    repositories,
    lfs,
    releaseAssets,
    database,
    trackedBytes: repositories.bytes + lfs.bytes + releaseAssets.bytes + database.bytes,
    trackedFiles: repositories.files + lfs.files + releaseAssets.files + database.files,
    truncated: state.truncated,
  };
}

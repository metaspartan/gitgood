import { statfsSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { scanStorage, type StorageRoots, type StorageScanReport } from "./storage-scan.ts";

export interface FilesystemSample {
  id: string;
  totalBytes: number;
  availableBytes: number;
  additive: boolean;
}

export interface StorageWorkerResult {
  sampledAt: number;
  scan: StorageScanReport;
  filesystems: FilesystemSample[];
  quota: null;
  ready: null;
}

function sampleFilesystem(path: string): FilesystemSample | null {
  let current = path;
  while (true) {
    try {
      const stats = statfsSync(current);
      const device = statSync(current).dev;
      return {
        id: String(device),
        totalBytes: Number(stats.blocks) * Number(stats.bsize),
        availableBytes: Number(stats.bavail) * Number(stats.bsize),
        additive: true,
      };
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "ENOENT" || dirname(current) === current) return null;
      current = dirname(current);
    }
  }
}

export function collectStorage(roots: StorageRoots): StorageWorkerResult {
  const scan = scanStorage(roots);
  const locations = [
    resolve(roots.repoRoot),
    resolve(roots.lfsRoot),
    resolve(roots.releasesRoot),
    dirname(resolve(roots.dbPath)),
  ];
  const byId = new Map<string, FilesystemSample>();
  const unavailable: FilesystemSample[] = [];
  for (const location of locations) {
    const sample = sampleFilesystem(location);
    if (!sample) {
      unavailable.push({ id: `location-${unavailable.length + 1}`, totalBytes: 0, availableBytes: 0, additive: false });
      continue;
    }
    const existing = byId.get(sample.id);
    if (!existing) byId.set(sample.id, { ...sample });
  }
  const filesystems = [...byId.values(), ...unavailable];
  if (filesystems.length > 1) {
    for (const sample of filesystems) sample.additive = false;
  }
  return { sampledAt: Date.now(), scan, filesystems, quota: null, ready: null };
}

const payload = process.argv[2];
if (import.meta.main && payload) {
  const roots = JSON.parse(payload) as StorageRoots;
  process.stdout.write(JSON.stringify(collectStorage(roots)));
}

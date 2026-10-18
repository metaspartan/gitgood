import { git } from "./run.ts";

const REPOSITORY_SETTINGS: ReadonlyArray<readonly [string, string]> = [
  [
    "core.bigFileThreshold",
    "512m",
  ],
  [
    "core.compression",
    "1",
  ],
  [
    "pack.windowMemory",
    "256m",
  ],
  [
    "pack.deltaCacheSize",
    "128m",
  ],
  [
    "pack.threads",
    "1",
  ],
  [
    "gc.auto",
    "6700",
  ],
  [
    "gc.autoPackLimit",
    "50",
  ],
  [
    "gc.pruneExpire",
    "2.weeks.ago",
  ],
  [
    "fetch.fsckObjects",
    "true",
  ],
  [
    "transfer.fsckObjects",
    "true",
  ],
  [
    "repack.usedeltabaseoffset",
    "true",
  ],
  [
    "index.version",
    "4",
  ],
  [
    "feature.manyFiles",
    "true",
  ],
  [
    "uploadpack.allowFilter",
    "true",
  ],
  [
    "uploadpack.allowAnySHA1InWant",
    "true",
  ],
];

export async function applyRepositorySettings(path: string): Promise<number> {
  let applied = 0;
  for (const [key, value] of REPOSITORY_SETTINGS) {
    const result = await git(["config", key, value], { cwd: path, allowFailure: true });
    if (result.exitCode === 0) applied += 1;
  }
  return applied;
}

export function repositorySettings(): ReadonlyArray<readonly [string, string]> {
  return REPOSITORY_SETTINGS;
}

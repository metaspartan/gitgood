import { cached, invalidatePrefix } from "../lib/cache.ts";
import * as gitRepo from "../git/repo.ts";
import type { GitBranch, GitCommit, GitCommitDetail, GitTag, GitTreeEntry } from "../git/types.ts";
import { languageBreakdown, treeIndex, type LanguageShare } from "../git/tree-index.ts";
import { repoDiskPath, type RepoRecord } from "./repos.ts";

export const MAX_CACHED_BLOB_BYTES = 256 * 1024;

const TTL = {
  refs: 5_000,
  tree: 10_000,
  log: 10_000,
  blob: 10_000,
  commit: 300_000,
  stats: 10_000,
} as const;

function repoKey(repo: RepoRecord): string {
  return `repo:${repo.id}:`;
}

function path(repo: RepoRecord): string {
  return repoDiskPath(repo);
}

export function invalidateRepo(repoId: number): void {
  invalidatePrefix(`repo:${repoId}:`);
}

export function refs(repo: RepoRecord): Promise<{ branches: GitBranch[]; tags: GitTag[]; head: string }> {
  return cached(`${repoKey(repo)}refs`, TTL.refs, () => gitRepo.refsAt(path(repo)));
}

export function branches(repo: RepoRecord): Promise<GitBranch[]> {
  return refs(repo).then((result) => result.branches);
}

export function branchesWithHead(repo: RepoRecord): Promise<{ branches: GitBranch[]; head: string }> {
  return refs(repo).then(({ branches: list, head }) => ({ branches: list, head }));
}

export function tags(repo: RepoRecord): Promise<GitTag[]> {
  return refs(repo).then((result) => result.tags);
}

export function headBranch(repo: RepoRecord): Promise<string> {
  return cached(`${repoKey(repo)}head`, TTL.refs, () => gitRepo.headBranch(path(repo)));
}

export function resolveRef(repo: RepoRecord, ref: string): Promise<string | null> {
  return cached(`${repoKey(repo)}ref:${ref}`, TTL.refs, () => gitRepo.resolveRef(path(repo), ref));
}

export function tree(repo: RepoRecord, ref: string, dir: string): Promise<GitTreeEntry[]> {
  return cached(`${repoKey(repo)}tree:${ref}:${dir}`, TTL.tree, () => gitRepo.treeAt(path(repo), ref, dir));
}

export function commits(
  repo: RepoRecord,
  ref: string,
  options: { limit: number; skip: number; filePath?: string },
): Promise<GitCommit[]> {
  const key = `${repoKey(repo)}log:${ref}:${options.limit}:${options.skip}:${options.filePath ?? ""}`;
  return cached(key, TTL.log, () => gitRepo.log(path(repo), ref, options));
}

export function commitDetail(repo: RepoRecord, sha: string): Promise<GitCommitDetail | null> {
  return cached(`${repoKey(repo)}commit:${sha}`, TTL.commit, () => gitRepo.commitDetail(path(repo), sha));
}

export function blob(
  repo: RepoRecord,
  ref: string,
  filePath: string,
  maxBytes = 2 * 1024 * 1024,
): Promise<gitRepo.BlobResult | null> {
  if (maxBytes > MAX_CACHED_BLOB_BYTES) {
    return gitRepo.blobAt(path(repo), ref, filePath, maxBytes);
  }
  return cached(`${repoKey(repo)}blob:${ref}:${filePath}`, TTL.blob, () =>
    gitRepo.blobAt(path(repo), ref, filePath, maxBytes),
  );
}

export function commitCount(repo: RepoRecord, ref: string): Promise<number> {
  return cached(`${repoKey(repo)}count:${ref}`, TTL.stats, () => gitRepo.commitCount(path(repo), ref));
}

export function size(repo: RepoRecord): Promise<gitRepo.RepoSize> {
  return cached(`${repoKey(repo)}size`, TTL.stats, () => gitRepo.repoSize(path(repo)));
}

export function candidateBlobSizes(
  repo: RepoRecord,
  ref: string,
  candidates: readonly string[],
): Promise<Map<string, number>> {
  const key = `${repoKey(repo)}sizes:${ref}:${[...candidates].sort().join(",")}`;
  return cached(key, TTL.blob, () => gitRepo.blobSizes(path(repo), ref, candidates));
}

export const MAX_FINDER_FILES = 100_000;

export function languages(repo: RepoRecord, sha: string): Promise<LanguageShare[]> {
  return cached(`${repoKey(repo)}langs:${sha}`, 3_600_000, async () => {
    const index = await treeIndex(path(repo), sha, Number.MAX_SAFE_INTEGER);
    return languageBreakdown(index.files);
  });
}

interface FileListEntry {
  json: string;
  expires: number;
}

const FILE_LISTS = new Map<string, FileListEntry>();
const FILE_LIST_SLOTS = 3;
const FILE_LIST_TTL_MS = 120_000;
const fileListLoads = new Map<string, Promise<string>>();

export function fileListJson(repo: RepoRecord, sha: string): Promise<string> {
  const key = `${repo.id}:${sha}`;
  const now = Date.now();
  for (const [k, entry] of FILE_LISTS) if (entry.expires <= now) FILE_LISTS.delete(k);
  const hit = FILE_LISTS.get(key);
  if (hit) {
    FILE_LISTS.delete(key);
    FILE_LISTS.set(key, hit);
    return Promise.resolve(hit.json);
  }
  const pending = fileListLoads.get(key);
  if (pending) return pending;
  const load = (async () => {
    try {
      const index = await treeIndex(path(repo), sha, MAX_FINDER_FILES);
      const json = JSON.stringify({ sha, total: index.total, truncated: index.truncated, paths: index.files.map((f) => f.path) });
      FILE_LISTS.set(key, { json, expires: Date.now() + FILE_LIST_TTL_MS });
      while (FILE_LISTS.size > FILE_LIST_SLOTS) FILE_LISTS.delete(FILE_LISTS.keys().next().value as string);
      return json;
    } finally {
      fileListLoads.delete(key);
    }
  })();
  fileListLoads.set(key, load);
  return load;
}

export function fileListSlotsUsed(): number {
  return FILE_LISTS.size;
}

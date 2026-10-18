import { all, changes, now, one, run, transaction } from "../db/index.ts";
import { log } from "../lib/logger.ts";
import { languageForPath } from "../lib/file-types.ts";
import { config } from "../config.ts";
import { repoDiskPath, type RepoRecord  } from "./repos.ts";
import * as gitRepo from "../git/repo.ts";

export interface CodeIndexState {
  repo_id: number;
  sha: string;
  files: number;
  bytes: number;
  skipped: number;
  truncated: number;
  indexed_at: number;
  last_error: string | null;
}

export interface CodeSearchHit {
  repo_id: number;
  owner_username: string;
  name: string;
  path: string;
  language: string;
  snippet: string;
}

const BINARY_EXTENSIONS = new Set([
  "png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "tiff", "tif", "avif", "heic",
  "pdf", "zip", "gz", "tgz", "bz2", "xz", "7z", "rar", "tar", "jar", "war",
  "woff", "woff2", "ttf", "otf", "eot",
  "mp3", "mp4", "m4a", "wav", "ogg", "flac", "avi", "mov", "mkv", "webm",
  "exe", "dll", "so", "dylib", "bin", "o", "a", "class", "pyc", "wasm",
  "sqlite", "db", "pack", "idx", "lock",
]);

function extensionOf(path: string): string {
  const slash = path.lastIndexOf("/");
  const base = slash >= 0 ? path.slice(slash + 1) : path;
  const dot = base.lastIndexOf(".");
  return dot <= 0 ? "" : base.slice(dot + 1).toLowerCase();
}

export function looksTextual(content: string, sample = 8000): boolean {
  return !content.slice(0, sample).includes("\u0000");
}

export interface IndexResult {
  files: number;
  bytes: number;
  skipped: number;
  truncated: number;
  sha: string;
}

export async function indexRepository(repo: RepoRecord, ref?: string): Promise<IndexResult> {
  const branch = ref ?? repo.default_branch;
  const started = now();

  const cwd = repoDiskPath(repo);
  const entries = await gitRepo.listTreeWithSizes(cwd, branch);
  if (entries === null) {
    recordState(repo.id, {
      sha: "",
      files: 0,
      bytes: 0,
      skipped: 0,
      truncated: 0,
      error: null,
    });
    return { files: 0, bytes: 0, skipped: 0, truncated: 0, sha: "" };
  }

  const sha = await gitRepo.revParse(cwd, branch);
  let files = 0;
  let bytes = 0;
  let skipped = 0;
  let truncated = 0;

  const rows: Array<{ path: string; language: string; content: string }> = [];

  for (const entry of entries) {
    if (files >= config.codeIndexMaxFiles) {
      truncated = 1;
      break;
    }
    if (entry.size > config.codeIndexMaxFileBytes) {
      skipped += 1;
      continue;
    }
    if (BINARY_EXTENSIONS.has(extensionOf(entry.path))) {
      skipped += 1;
      continue;
    }
    if (bytes + entry.size > config.codeIndexMaxTotalBytes) {
      truncated = 1;
      break;
    }

    const content = await gitRepo.showBlob(cwd, branch, entry.path);
    if (content === null) {
      skipped += 1;
      continue;
    }
    if (!looksTextual(content)) {
      skipped += 1;
      continue;
    }

    rows.push({
      path: entry.path,
      language: languageForPath(entry.path) ?? "",
      content,
    });
    files += 1;
    bytes += content.length;
  }

  transaction(() => {
    changes("DELETE FROM code_blobs WHERE repo_id = ?", repo.id);
    for (const row of rows) {
      run(
        "INSERT INTO code_blobs (repo_id, path, language, content) VALUES (?, ?, ?, ?)",
        repo.id,
        row.path,
        row.language,
        row.content,
      );
    }
    recordState(repo.id, { sha, files, bytes, skipped, truncated, error: null });
  });

  if (truncated === 1) {
    log.warn("code index truncated by budget", {
      repo: `${repo.owner_username}/${repo.name}`,
      files,
      bytes,
      limits: {
        files: config.codeIndexMaxFiles,
        bytes: config.codeIndexMaxTotalBytes,
      },
    });
  }
  void started;

  return { files, bytes, skipped, truncated, sha };
}

function recordState(
  repoId: number,
  state: { sha: string; files: number; bytes: number; skipped: number; truncated: number; error: string | null },
): void {
  run(
    `INSERT INTO code_index_state (repo_id, sha, files, bytes, skipped, truncated, indexed_at, last_error)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(repo_id) DO UPDATE SET
       sha = excluded.sha, files = excluded.files, bytes = excluded.bytes,
       skipped = excluded.skipped, truncated = excluded.truncated,
       indexed_at = excluded.indexed_at, last_error = excluded.last_error`,
    repoId,
    state.sha,
    state.files,
    state.bytes,
    state.skipped,
    state.truncated,
    now(),
    state.error,
  );
}

export async function reindexQuietly(repo: RepoRecord, reason: string): Promise<void> {
  try {
    const result = await indexRepository(repo);
    log.info("code index updated", {
      repo: `${repo.owner_username}/${repo.name}`,
      reason,
      files: result.files,
      truncated: result.truncated === 1,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    recordState(repo.id, {
      sha: "",
      files: 0,
      bytes: 0,
      skipped: 0,
      truncated: 0,
      error: message.slice(0, 500),
    });
    log.warn("code index failed", {
      repo: `${repo.owner_username}/${repo.name}`,
      reason,
      error: message,
    });
  }
}

export function indexState(repoId: number): CodeIndexState | null {
  return one<CodeIndexState>("SELECT * FROM code_index_state WHERE repo_id = ?", repoId);
}

export function indexedFileCount(repoId: number): number {
  return one<{ c: number }>("SELECT COUNT(*) AS c FROM code_blobs WHERE repo_id = ?", repoId)?.c ?? 0;
}

export function searchCode(
  match: string,
  viewerParams: readonly (number | string)[],
  options: { limit?: number; repoId?: number | null } = {},
): CodeSearchHit[] {
  const limit = options.limit ?? 40;
  const repoFilter = options.repoId ? "AND r.id = ?" : "";
  const params: Array<string | number> = [match, ...viewerParams];
  if (options.repoId) params.push(options.repoId);
  params.push(limit);

  return all<CodeSearchHit>(
    `SELECT b.repo_id,
            COALESCE(og.name, u.username) AS owner_username,
            r.name,
            b.path,
            b.language,
            snippet(code_fts, 1, '[', ']', ' … ', 12) AS snippet
       FROM code_fts f
       JOIN code_blobs b ON b.id = f.rowid
       JOIN repos r ON r.id = b.repo_id
       JOIN users u ON u.id = r.owner_id
       LEFT JOIN orgs og ON og.id = r.org_id
      WHERE code_fts MATCH ?
        AND (r.visibility = 'public'
             OR r.owner_id = ?
             OR (r.org_id IS NOT NULL AND EXISTS (
                  SELECT 1 FROM org_members om WHERE om.org_id = r.org_id AND om.user_id = ?
                ))
             OR ?)
        ${repoFilter}
      ORDER BY rank
      LIMIT ?`,
    ...params,
  );
}

export function indexSummary(): {
  indexed_repos: number;
  indexed_files: number;
  truncated_repos: number;
  failed_repos: number;
} {
  const row = one<{
    indexed_repos: number;
    indexed_files: number;
    truncated_repos: number;
    failed_repos: number;
  }>(
    `SELECT
       COUNT(*) AS indexed_repos,
       COALESCE(SUM(files), 0) AS indexed_files,
       COALESCE(SUM(CASE WHEN truncated = 1 THEN 1 ELSE 0 END), 0) AS truncated_repos,
       COALESCE(SUM(CASE WHEN last_error IS NOT NULL THEN 1 ELSE 0 END), 0) AS failed_repos
     FROM code_index_state`,
  );
  return row ?? { indexed_repos: 0, indexed_files: 0, truncated_repos: 0, failed_repos: 0 };
}

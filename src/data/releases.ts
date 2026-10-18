import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { config } from "../config.ts";
import { all, changes, now, one, run } from "../db/index.ts";

export interface ReleaseRow {
  id: number;
  repo_id: number;
  tag_name: string;
  name: string;
  body: string;
  prerelease: number;
  draft: number;
  author_id: number;
  created_at: number;
  updated_at: number;
}

export interface ReleaseAssetRow {
  id: number;
  release_id: number;
  name: string;
  size: number;
  content_type: string;
  sha256: string;
  downloads: number;
  created_at: number;
}

export function ensureAssetDir(repoId: number): string {
  const dir = join(config.dataDir, "releases", String(repoId));
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function assetPath(repoId: number, assetId: number): string {
  return join(config.dataDir, "releases", String(repoId), String(assetId));
}

export type ReleaseWithAuthor = ReleaseRow & { author_username: string };

function withAuthor(row: ReleaseRow): ReleaseWithAuthor | null {
  const author = one<{ username: string }>(`SELECT username FROM users WHERE id = ?`, row.author_id);
  if (!author) return null;
  return { ...row, author_username: author.username };
}

export function listReleases(repoId: number, includeDrafts: boolean): ReleaseWithAuthor[] {
  const rows = includeDrafts
    ? all<ReleaseRow>(`SELECT * FROM releases WHERE repo_id = ? ORDER BY created_at DESC, id DESC`, repoId)
    : all<ReleaseRow>(`SELECT * FROM releases WHERE repo_id = ? AND draft = 0 ORDER BY created_at DESC, id DESC`, repoId);
  return rows.map(withAuthor).filter((row): row is ReleaseWithAuthor => row !== null);
}

export function getRelease(repoId: number, id: number): ReleaseWithAuthor | null {
  const row = one<ReleaseRow>(`SELECT * FROM releases WHERE repo_id = ? AND id = ?`, repoId, id);
  return row ? withAuthor(row) : null;
}

export function getReleaseByTag(repoId: number, tagName: string): ReleaseRow | null {
  return one<ReleaseRow>(`SELECT * FROM releases WHERE repo_id = ? AND tag_name = ?`, repoId, tagName);
}

export interface CreateReleaseInput {
  repoId: number;
  tagName: string;
  name: string;
  body: string;
  prerelease: boolean;
  draft: boolean;
  authorId: number;
}

export function createRelease(input: CreateReleaseInput): number {
  const timestamp = now();
  return run(
    `INSERT INTO releases (repo_id, tag_name, name, body, prerelease, draft, author_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    input.repoId,
    input.tagName,
    input.name,
    input.body,
    input.prerelease ? 1 : 0,
    input.draft ? 1 : 0,
    input.authorId,
    timestamp,
    timestamp,
  );
}

export function updateRelease(
  repoId: number,
  id: number,
  patch: { name?: string; body?: string; prerelease?: boolean; draft?: boolean },
): boolean {
  const current = one<ReleaseRow>(`SELECT * FROM releases WHERE repo_id = ? AND id = ?`, repoId, id);
  if (!current) return false;
  return (
    changes(
      `UPDATE releases SET name = ?, body = ?, prerelease = ?, draft = ?, updated_at = ? WHERE repo_id = ? AND id = ?`,
      patch.name ?? current.name,
      patch.body ?? current.body,
      (patch.prerelease ?? current.prerelease === 1) ? 1 : 0,
      (patch.draft ?? current.draft === 1) ? 1 : 0,
      now(),
      repoId,
      id,
    ) > 0
  );
}

export function deleteRelease(repoId: number, id: number): boolean {
  return changes(`DELETE FROM releases WHERE repo_id = ? AND id = ?`, repoId, id) > 0;
}

export function listAssets(releaseId: number): ReleaseAssetRow[] {
  return all<ReleaseAssetRow>(`SELECT * FROM release_assets WHERE release_id = ? ORDER BY id`, releaseId);
}

export function getAsset(repoId: number, releaseId: number, assetId: number): ReleaseAssetRow | null {
  return one<ReleaseAssetRow>(
    `SELECT a.* FROM release_assets a JOIN releases r ON r.id = a.release_id
      WHERE a.id = ? AND a.release_id = ? AND r.repo_id = ?`,
    assetId,
    releaseId,
    repoId,
  );
}

export function addAsset(input: {
  releaseId: number;
  name: string;
  size: number;
  contentType: string;
  sha256: string;
}): number {
  return run(
    `INSERT INTO release_assets (release_id, name, size, content_type, sha256, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    input.releaseId,
    input.name,
    input.size,
    input.contentType,
    input.sha256,
    now(),
  );
}

export function countDownload(assetId: number): number {
  run(`UPDATE release_assets SET downloads = downloads + 1 WHERE id = ?`, assetId);
  return one<{ downloads: number }>(`SELECT downloads FROM release_assets WHERE id = ?`, assetId)?.downloads ?? 0;
}

export function deleteAsset(repoId: number, releaseId: number, assetId: number): boolean {
  const asset = getAsset(repoId, releaseId, assetId);
  if (!asset) return false;
  changes(`DELETE FROM release_assets WHERE id = ?`, assetId);
  rmSync(assetPath(repoId, assetId), { force: true });
  return true;
}

export { sha256Hex } from "../lib/ids.ts";

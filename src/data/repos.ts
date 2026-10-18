import { repositoryDefaultQuota } from "./instance-settings.ts";
import { invalidateLfsTotals, lfsTotalsFor } from "../lfs/totals.ts";
import { collaboratorPermission } from "./collaborators.ts";
import { all, changes, now, one, run, scalar } from "../db/index.ts";
import { conflict, forbidden, notFound, unauthorized, unprocessable } from "../lib/errors.ts";
import { REPO_NAME_PATTERN } from "../lib/ids.ts";
import type { Auth, Principal } from "../auth/service.ts";
import * as gitRepo from "../git/repo.ts";
import * as gitReads from "./git-reads.ts";
import { findOrgById, membershipFor } from "./orgs.ts";
import { applyDefaultPushPolicy } from "./git-policy.ts";

export type Visibility = "public" | "private";

export interface RepoRow {
  id: number;
  owner_id: number;
  org_id: number | null;
  fork_of: number | null;
  quota_bytes: number | null;
  over_quota_at: number | null;
  disk_path: string | null;
  name: string;
  description: string;
  visibility: Visibility;
  default_branch: string;
  lfs_enabled: number;
  archived: number;
  created_at: number;
  updated_at: number;
}

export interface RepoRecord extends RepoRow {
  owner_username: string;
  owner_display: string;
  owner_hue: number;
  owner_kind: "user" | "org";
  actions_enabled?: number;
}

export interface RepoStats {
  openIssues: number;
  openPulls: number;
  branches: number;
  tags: number;
  commits: number;
  sizeBytes: number;
  stars: number;
  forks: number;
  lfsObjects: number;
  lfsBytes: number;
}

const OWNER_NAME_SQL = "COALESCE(og.name, u.username)";
const OWNER_DISPLAY_SQL = "COALESCE(og.display_name, u.display_name)";
const OWNER_HUE_SQL = "COALESCE(og.avatar_hue, u.avatar_hue)";
const OWNER_KIND_SQL = "CASE WHEN r.org_id IS NULL THEN 'user' ELSE 'org' END";

const OWNER_JOINS = `
  JOIN users u ON u.id = r.owner_id
  LEFT JOIN orgs og ON og.id = r.org_id`;

const SELECT_REPO = `
  SELECT r.*,
    ${OWNER_NAME_SQL} AS owner_username,
    ${OWNER_DISPLAY_SQL} AS owner_display,
    ${OWNER_HUE_SQL} AS owner_hue,
    ${OWNER_KIND_SQL} AS owner_kind
  FROM repos r${OWNER_JOINS}`;

const SELECT_REPO_WITH_COUNTS = `
  SELECT r.*,
    ${OWNER_NAME_SQL} AS owner_username,
    ${OWNER_DISPLAY_SQL} AS owner_display,
    ${OWNER_HUE_SQL} AS owner_hue,
    ${OWNER_KIND_SQL} AS owner_kind,
    COALESCE(ic.c, 0) AS open_issues,
    COALESCE(pc.c, 0) AS open_pulls,
    COALESCE(sc.c, 0) AS stars,
    COALESCE(fc.c, 0) AS forks
  FROM repos r${OWNER_JOINS}
  LEFT JOIN (
    SELECT repo_id, COUNT(*) AS c FROM issues WHERE state = 'open' GROUP BY repo_id
  ) ic ON ic.repo_id = r.id
  LEFT JOIN (
    SELECT repo_id, COUNT(*) AS c FROM pulls WHERE state = 'open' GROUP BY repo_id
  ) pc ON pc.repo_id = r.id
  LEFT JOIN (
    SELECT repo_id, COUNT(*) AS c FROM stars GROUP BY repo_id
  ) sc ON sc.repo_id = r.id
  -- Fork counts are grouped once here rather than counted per row. The previous
  -- version ran a scalar subquery per repository inside statsFromCounts, which
  -- is 200 statements for a 200-row list - and the fork count was the *only*
  -- part of that function that touched the database, so the whole list paid an
  -- N+1 for a number most callers never render.
  LEFT JOIN (
    SELECT fork_of AS repo_id, COUNT(*) AS c FROM repos WHERE fork_of IS NOT NULL GROUP BY fork_of
  ) fc ON fc.repo_id = r.id`;

export interface RepoWithCounts extends RepoRecord {
  open_issues: number;
  open_pulls: number;
  stars: number;
  forks: number;
}

export function repoCountsProjection(): string {
  return SELECT_REPO_WITH_COUNTS;
}

export function readableRepoPredicate(): { sql: string; params: (auth: Auth) => Array<number | string> } {
  return {
    sql: `(
      r.visibility = 'public'
      OR r.owner_id = ?
      OR (r.org_id IS NOT NULL AND EXISTS (
           SELECT 1 FROM org_members om WHERE om.org_id = r.org_id AND om.user_id = ?
         ))
      OR ?
    )`,
    params: (auth: Auth) => {
      if (auth.kind !== "user") return [0, 0, 0];
      return [auth.userId, auth.userId, auth.isAdmin ? 1 : 0];
    },
  };
}

export function statsFromCounts(repo: RepoWithCounts): RepoStats {
  return {
    openIssues: repo.open_issues,
    openPulls: repo.open_pulls,
    branches: 0,
    tags: 0,
    commits: 0,
    sizeBytes: 0,
    stars: repo.stars,
    forks: repo.forks,
    ...lfsTotalsFor(repo.id),
  };
}

export function normalizeQuota(value: number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  if (!Number.isFinite(value)) throw unprocessable("Quota must be a number of bytes");
  const rounded = Math.trunc(value);
  if (rounded <= 0) return 0;
  if (rounded > 1024 ** 5) throw unprocessable("Quota cannot exceed 1 PiB");
  return rounded;
}

export function effectiveQuotaBytes(repo: RepoRecord): number {
  if (repo.quota_bytes === null) {
    const value = repositoryDefaultQuota().bytes;
    return value === 0 ? Number.POSITIVE_INFINITY : value;
  }
  if (repo.quota_bytes <= 0) return Number.POSITIVE_INFINITY;
  return repo.quota_bytes;
}

export function repoDiskPath(repo: RepoRecord): string {
  return repo.disk_path ?? gitRepo.repositoryPath(repo.owner_username, repo.name);
}

export function findRepo(owner: string, name: string): RepoRecord | null {
  return one<RepoRecord>(`${SELECT_REPO} WHERE ${OWNER_NAME_SQL} = ? AND r.name = ?`, owner, name);
}

export function findRepoById(id: number): RepoRecord | null {
  return one<RepoRecord>(`${SELECT_REPO} WHERE r.id = ?`, id);
}

export function requireRepo(owner: string, name: string): RepoRecord {
  const record = findRepo(owner, name);
  if (!record) throw notFound(`Repository ${owner}/${name} not found`);
  return record;
}

export interface CreateRepoInput {
  name: string;
  description?: string;
  visibility?: Visibility;
  defaultBranch?: string;
  lfsEnabled?: boolean;
  orgId?: number | null;
  quotaBytes?: number | null;
  forkOf?: number | null;
}

export async function createRepository(
  owner: Principal,
  input: CreateRepoInput,
): Promise<RepoRecord> {
  const name = gitRepo.normalizeRepoName(input.name);
  if (!REPO_NAME_PATTERN.test(name) || name === "." || name === "..") {
    throw conflict("Repository name may only contain letters, digits, dots, dashes and underscores");
  }
  const orgId = input.orgId ?? null;
  const existing =
    orgId === null
      ? scalar<number>(
          "SELECT COUNT(*) FROM repos WHERE owner_id = ? AND org_id IS NULL AND name = ?",
          owner.userId,
          name,
        )
      : scalar<number>("SELECT COUNT(*) FROM repos WHERE org_id = ? AND name = ?", orgId, name);
  if ((existing ?? 0) > 0) throw conflict(`Repository ${owner.username}/${name} already exists`);

  const quota = normalizeQuota(input.quotaBytes);

  const defaultBranch = input.defaultBranch?.trim() || "main";
  const timestamp = now();

  const ownerName = orgId === null ? owner.username : (findOrgById(orgId)?.name ?? owner.username);
  const path = gitRepo.hashedRepositoryPath(ownerName, name);

  const id = run(
    `INSERT INTO repos (owner_id, org_id, fork_of, quota_bytes, name, description, visibility, default_branch, lfs_enabled, disk_path, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    owner.userId,
    orgId,
    input.forkOf ?? null,
    quota,
    name,
    input.description?.trim() ?? "",
    input.visibility ?? "public",
    defaultBranch,
    input.lfsEnabled === false ? 0 : 1,
    path,
    timestamp,
    timestamp,
  );

  try {
    await gitRepo.initBareRepository(path, defaultBranch);
  } catch (error) {
    changes("DELETE FROM repos WHERE id = ?", id);
    invalidateLfsTotals();
    throw error;
  }

  const created = findRepoById(id);
  if (!created) throw notFound("Repository disappeared during creation");

  await applyDefaultPushPolicy(created);

  return created;
}

export interface UpdateRepoInput {
  description?: string;
  visibility?: Visibility;
  defaultBranch?: string;
  lfsEnabled?: boolean;
  actionsEnabled?: boolean;
  archived?: boolean;
  quotaBytes?: number | null;
  orgId?: number | null;
}

export function updateRepository(repo: RepoRecord, input: UpdateRepoInput): RepoRecord {
  const fields: string[] = [];
  const values: Array<string | number | null> = [];
  if (input.description !== undefined) {
    fields.push("description = ?");
    values.push(input.description.trim());
  }
  if (input.visibility !== undefined) {
    fields.push("visibility = ?");
    values.push(input.visibility);
  }
  if (input.defaultBranch !== undefined) {
    fields.push("default_branch = ?");
    values.push(input.defaultBranch.trim());
  }
  if (input.lfsEnabled !== undefined) {
    fields.push("lfs_enabled = ?");
    values.push(input.lfsEnabled ? 1 : 0);
  }
  if (input.actionsEnabled !== undefined) {
    fields.push("actions_enabled = ?");
    values.push(input.actionsEnabled ? 1 : 0);
  }
  if (input.archived !== undefined) {
    fields.push("archived = ?");
    values.push(input.archived ? 1 : 0);
  }
  if (input.quotaBytes !== undefined) {
    fields.push("quota_bytes = ?");
    values.push(normalizeQuota(input.quotaBytes));
  }
  if (input.orgId !== undefined) {
    fields.push("org_id = ?");
    values.push(input.orgId);
    fields.push("over_quota_at = NULL");
  }
  if (fields.length === 0) return repo;
  fields.push("updated_at = ?");
  values.push(now());
  values.push(repo.id);
  changes(`UPDATE repos SET ${fields.join(", ")} WHERE id = ?`, ...values);
  const updated = findRepoById(repo.id);
  if (!updated) throw notFound("Repository not found after update");
  return updated;
}

export async function deleteRepository(repo: RepoRecord): Promise<void> {
  const path = repoDiskPath(repo);
  changes("DELETE FROM repos WHERE id = ?", repo.id);
  invalidateLfsTotals();
  gitReads.invalidateRepo(repo.id);
  gitRepo.removeRepository(path);
}

function freeForkName(base: string, orgId: number | null, ownerId: number): string {
  const taken = (candidate: string): boolean => {
    const count =
      orgId === null
        ? scalar<number>(
            "SELECT COUNT(*) FROM repos WHERE owner_id = ? AND org_id IS NULL AND name = ?",
            ownerId,
            candidate,
          )
        : scalar<number>("SELECT COUNT(*) FROM repos WHERE org_id = ? AND name = ?", orgId, candidate);
    return (count ?? 0) > 0;
  };
  if (!taken(base)) return base;
  for (let suffix = 2; suffix < 1000; suffix++) {
    const candidate = `${base}-${suffix}`;
    if (candidate.length > 100) continue;
    if (!taken(candidate)) return candidate;
  }
  throw conflict(`Could not find a free name for a fork of ${base}`);
}

export interface ForkInput {
  orgId?: number | null;
  name?: string;
  description?: string;
  mirror?: boolean;
}

export async function forkRepository(
  parent: RepoRecord,
  actor: Principal,
  input: ForkInput = {},
): Promise<RepoRecord> {
  const orgId = input.orgId ?? null;
  const requested = input.name?.trim();
  const base = gitRepo.normalizeRepoName(requested || parent.name);
  const name = requested ? base : freeForkName(base, orgId, actor.userId);

  const created = await createRepository(actor, {
    name,
    description:
      input.description?.trim() ||
      `Fork of ${parent.owner_username}/${parent.name}`,
    visibility: parent.visibility === "private" ? "private" : "public",
    defaultBranch: parent.default_branch,
    lfsEnabled: parent.lfs_enabled === 1,
    orgId,
    forkOf: parent.id,
  });

  const from = repoDiskPath(parent);
  const to = repoDiskPath(created);
  await gitRepo.fetchAllRefs(from, to, input.mirror === true);
  return created;
}

export function touchRepository(repoId: number): void {
  changes("UPDATE repos SET updated_at = ? WHERE id = ?", now(), repoId);
}

export function listReposByOwner(ownerId: number): RepoWithCounts[] {
  return all<RepoWithCounts>(
    `${SELECT_REPO_WITH_COUNTS} WHERE r.owner_id = ? AND r.org_id IS NULL ORDER BY r.updated_at DESC`,
    ownerId,
  );
}

export function listVisibleRepos(auth: Auth, limit = 100, offset = 0): RepoWithCounts[] {
  const predicate = readableRepoPredicate();
  return all<RepoWithCounts>(
    `${SELECT_REPO_WITH_COUNTS} WHERE ${predicate.sql}
      ORDER BY r.updated_at DESC
      LIMIT ? OFFSET ?`,
    ...predicate.params(auth),
    limit,
    offset,
  );
}

export function countVisibleRepos(auth: Auth): number {
  const predicate = readableRepoPredicate();
  return (
    scalar<number>(
      `SELECT COUNT(*) FROM repos r WHERE ${predicate.sql}`,
      ...predicate.params(auth),
    ) ?? 0
  );
}

export function listVisibleReposWithTopic(
  auth: Auth,
  topicId: number,
  limit: number,
  offset: number,
): { items: RepoWithCounts[]; total: number } {
  const predicate = readableRepoPredicate();
  const scope = predicate.params(auth);
  const join = "JOIN repo_topics rt ON rt.repo_id = r.id AND rt.topic_id = ?";
  const total =
    scalar<number>(
      `SELECT COUNT(*) FROM repos r ${join} WHERE ${predicate.sql}`,
      topicId,
      ...scope,
    ) ?? 0;
  const items = all<RepoWithCounts>(
    `${SELECT_REPO_WITH_COUNTS} ${join} WHERE ${predicate.sql}
      ORDER BY r.updated_at DESC, r.id DESC LIMIT ? OFFSET ?`,
    topicId,
    ...scope,
    limit,
    offset,
  );
  return { items, total };
}

export function topicIdForName(name: string): number | null {
  const row = one<{ id: number }>("SELECT id FROM topics WHERE name = ?", name);
  return row ? row.id : null;
}

export function listReposByOrg(orgId: number): RepoWithCounts[] {
  return all<RepoWithCounts>(
    `${SELECT_REPO_WITH_COUNTS} WHERE r.org_id = ? ORDER BY r.updated_at DESC`,
    orgId,
  );
}

export function listForks(repoId: number, limit = 100): RepoWithCounts[] {
  return all<RepoWithCounts>(
    `${SELECT_REPO_WITH_COUNTS} WHERE r.fork_of = ? ORDER BY r.updated_at DESC LIMIT ?`,
    repoId,
    limit,
  );
}

export function findForkParent(repo: RepoRecord): RepoRecord | null {
  if (repo.fork_of === null) return null;
  return findRepoById(repo.fork_of);
}

export function countRepos(): number {
  return scalar<number>("SELECT COUNT(*) FROM repos") ?? 0;
}

export function selectionForQuotaReport(): string {
  return `${SELECT_REPO} ORDER BY r.updated_at DESC`;
}

export function isOwner(repo: RepoRecord, auth: Auth): boolean {
  if (auth.kind !== "user") return false;
  if (repo.org_id !== null) {
    const role = membershipFor(repo.org_id, auth.userId);
    return role === "owner" || role === "admin";
  }
  return auth.userId === repo.owner_id;
}

export function isMember(repo: RepoRecord, auth: Auth): boolean {
  if (auth.kind !== "user") return false;
  if (repo.org_id === null) return false;
  return membershipFor(repo.org_id, auth.userId) !== null;
}

function collaboratorGrant(repo: RepoRecord, auth: Auth): "read" | "write" | null {
  if (auth.kind !== "user") return null;
  if (auth.via === "token" && auth.tokenRepoId != null && auth.tokenRepoId !== repo.id) return null;
  return collaboratorPermission(repo.id, auth.userId);
}

export function canRead(repo: RepoRecord, auth: Auth): boolean {
  if (repo.visibility === "public") return true;
  if (auth.kind !== "user") return false;
  if (auth.via === "token" && auth.tokenRepoId != null && auth.tokenRepoId !== repo.id) return false;
  if (auth.isAdmin) return true;
  return isOwner(repo, auth) || isMember(repo, auth) || collaboratorGrant(repo, auth) !== null;
}

export function canWrite(repo: RepoRecord, auth: Auth): boolean {
  if (auth.kind !== "user") return false;
  if (auth.via === "token" && auth.tokenRepoId != null && auth.tokenRepoId !== repo.id) return false;
  if (auth.via === "token" && !auth.scopes.includes("write") && !auth.scopes.includes("admin")) {
    return false;
  }
  if (repo.archived === 1) return false;
  return isOwner(repo, auth) || auth.isAdmin || collaboratorGrant(repo, auth) === "write";
}

export function assertRead(repo: RepoRecord, auth: Auth): void {
  if (canRead(repo, auth)) return;
  if (repo.visibility === "private") throw notFound("Not found");
  if (auth.kind === "anonymous") throw unauthorized("Authentication required");
  throw forbidden();
}

export function shouldHideAsNotFound(auth: Auth): boolean {
  return auth.kind === "anonymous";
}

export function assertWrite(repo: RepoRecord, auth: Auth): Principal {
  if (auth.kind !== "user") throw forbidden("Authentication required to write");
  if (!canWrite(repo, auth)) throw forbidden("You do not have write access to this repository");
  return auth;
}

export function repoStats(repo: RepoRecord): RepoStats {
  return {
    openIssues: scalar<number>(
      "SELECT COUNT(*) FROM issues WHERE repo_id = ? AND state = 'open'",
      repo.id,
    ) ?? 0,
    openPulls: scalar<number>(
      "SELECT COUNT(*) FROM pulls WHERE repo_id = ? AND state = 'open'",
      repo.id,
    ) ?? 0,
    branches: 0,
    tags: 0,
    commits: 0,
    sizeBytes: 0,
    stars: scalar<number>("SELECT COUNT(*) FROM stars WHERE repo_id = ?", repo.id) ?? 0,
    forks: scalar<number>("SELECT COUNT(*) FROM repos WHERE fork_of = ?", repo.id) ?? 0,
    ...lfsTotalsFor(repo.id),
  };
}

export async function repoGitStats(repo: RepoRecord): Promise<RepoStats> {
  const stats = repoStats(repo);
  const defaultRef = `refs/heads/${repo.default_branch}`;
  const [allRefs, size, defaultCount] = await Promise.all([
    gitReads.refs(repo),
    gitReads.size(repo),
    gitReads.commitCount(repo, defaultRef).catch(() => null),
  ]);
  stats.branches = allRefs.branches.length;
  stats.tags = allRefs.tags.length;
  stats.sizeBytes = size.bytes;
  if (defaultCount !== null) {
    stats.commits = defaultCount;
  } else if (allRefs.branches[0]) {
    stats.commits = await gitReads.commitCount(repo, allRefs.branches[0].sha);
  }
  return stats;
}

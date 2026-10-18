import { badRequest, notFound } from "../lib/errors.ts";
import { GIT_REF_PATTERN, GIT_REV_PATTERN } from "../lib/ids.ts";
import { findRepo, requireRepo, assertRead, assertWrite, type RepoRecord } from "../data/repos.ts";
import { normalizeRepoName } from "../git/repo.ts";
import type { RouteContext } from "./router.ts";

export function param(ctx: RouteContext, key: string): string {
  const value = ctx.params[key];
  if (value === undefined || value === "") throw badRequest(`Missing path parameter "${key}"`);
  return value;
}

export function repoQuery(ctx: RouteContext): { owner: string; name: string } {
  return { owner: param(ctx, "owner"), name: normalizeRepoName(param(ctx, "name")) };
}

export function loadRepo(ctx: RouteContext): RepoRecord {
  const { owner, name } = repoQuery(ctx);
  return requireRepo(owner, name);
}

export function loadReadableRepo(ctx: RouteContext): RepoRecord {
  const repo = loadRepo(ctx);
  assertRead(repo, ctx.auth);
  return repo;
}

export function loadWritableRepo(ctx: RouteContext): RepoRecord {
  const repo = loadRepo(ctx);
  assertWrite(repo, ctx.auth);
  return repo;
}

export function optionalQuery(ctx: RouteContext, key: string): string | undefined {
  const value = ctx.url.searchParams.get(key);
  return value === null || value === "" ? undefined : value;
}

export function revParam(ctx: RouteContext, key = "sha"): string {
  const value = param(ctx, key);
  if (!GIT_REV_PATTERN.test(value)) throw badRequest(`Invalid ${key}`);
  return value;
}

export function assertSafeRefName(value: string, label = "ref"): string {
  if (!GIT_REF_PATTERN.test(value)) throw badRequest(`Invalid ${label} name`);
  return value;
}

export function assertSafeRevision(value: string, label = "revision"): string {
  if (!GIT_REV_PATTERN.test(value)) throw badRequest(`Invalid ${label}`);
  return value;
}

export function requestedRef(ctx: RouteContext, fallback: string): string {
  const value = optionalQuery(ctx, "ref") ?? optionalQuery(ctx, "sha") ?? fallback;
  if (!GIT_REV_PATTERN.test(value)) {
    throw badRequest("Invalid ref name");
  }
  return value;
}

export function ensureRepoFound(owner: string, name: string): RepoRecord {
  const repo = findRepo(owner, name);
  if (!repo) throw notFound(`Repository ${owner}/${name} not found`);
  return repo;
}

export function positiveId(raw: string, label = "ID"): number {
  const id = /^[1-9]\d{0,15}$/.test(raw) ? Number(raw) : NaN;
  if (!Number.isSafeInteger(id)) throw badRequest(`Invalid ${label}`);
  return id;
}

export function positiveIntParam(ctx: RouteContext, key: string, label: string): number {
  return positiveId(param(ctx, key), label);
}

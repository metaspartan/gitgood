import { json, readJson } from "../../lib/http.ts";
import { forbidden, unprocessable } from "../../lib/errors.ts";
import * as v from "../../lib/validate.ts";
import { requireUser } from "../../auth/service.ts";
import {
  canRead,
  canWrite,
  effectiveQuotaBytes,
  findForkParent,
  forkRepository,
  listForks,
  normalizeQuota,
  requireRepo,
  updateRepository,
  type RepoRecord,
} from "../../data/repos.ts";
import { assertOrgRole, findOrg } from "../../data/orgs.ts";
import {
  isStarred,
  listStargazers,
  listWatchers,
  setWatchLevel,
  star,
  starCount,
  unstar,
  watcherCount,
  watchLevel,
  WATCH_LEVELS,
  type WatchLevel,
} from "../../data/stars.ts";
import { scalar } from "../../db/index.ts";
import { notify } from "../../data/notifications.ts";
import {
  defaultPushPolicy,
  differsFromDefault,
  getPushPolicy,
  setPushPolicy,
} from "../../data/git-policy.ts";
import { repoJson } from "../serialize.ts";
import { loadReadableRepo, param } from "../helpers.ts";
import { increment, observe } from "../../lib/metrics.ts";
import { repoGitStats, repoStats, statsFromCounts } from "../../data/repos.ts";
import type { Router } from "../router.ts";

const watchSchema = v.strictObject({ level: v.optional(v.enumOf(WATCH_LEVELS)) });

const forkSchema = v.strictObject({
  name: v.optional(v.string({ min: 1, max: 100 })),
  description: v.optional(v.string({ max: 2048 })),
  organization: v.optional(v.string({ max: 39 })),
  mirror: v.optional(v.boolean()),
});

const quotaSchema = v.strictObject({
  quota_bytes: v.union([v.number({ int: true, min: 0, max: 1024 ** 5 }), v.literal(null)]),
});

function forkTargetOrg(
  organization: string | undefined,
  auth: Parameters<typeof requireUser>[0],
): number | null {
  if (organization === undefined) return null;
  const org = findOrg(organization);
  if (!org) throw unprocessable(`Organisation ${organization} not found`);
  assertOrgRole(auth, org.id, "member");
  return org.id;
}

const pushPolicySchema = v.strictObject({
  deny_non_fast_forwards: v.optional(v.boolean()),
  deny_deletes: v.optional(v.boolean()),
  fsck_objects: v.optional(v.boolean()),
});

export function registerRepoExtraRoutes(router: Router): void {

  router.post("/api/repos/:owner/:name/forks", async (ctx) => {
    const parent = loadReadableRepo(ctx);
    const principal = requireUser(ctx.auth);
    const body = await readJson(ctx.request, forkSchema);

    if (parent.visibility === "private" && !canWrite(parent, ctx.auth)) {
      throw forbidden("You need write access to fork a private repository");
    }

    const orgId = forkTargetOrg(body.organization, principal);
    const started = performance.now();
    const fork = await forkRepository(parent, principal, {
      orgId,
      ...(body.name === undefined ? {} : { name: body.name }),
      ...(body.description === undefined ? {} : { description: body.description }),
      ...(body.mirror === undefined ? {} : { mirror: body.mirror }),
    });
    observe("git_fork_ms", performance.now() - started);

    notify({
      userId: parent.owner_id,
      kind: "push",
      repoId: parent.id,
      repoFullName: `${parent.owner_username}/${parent.name}`,
      subjectType: "repository",
      subjectId: parent.id,
      subjectTitle: parent.name,
      actorId: principal.userId,
      actorUsername: principal.username,
      dedupeKey: `fork:${fork.id}`,
    });

    return json({ ...repoJson(fork), ...repoStats(fork) }, { status: 201 });
  });

  router.get("/api/repos/:owner/:name/forks", (ctx) => {
    const repo = requireRepo(param(ctx, "owner"), param(ctx, "name"));
    if (!canRead(repo, ctx.auth)) return json({ items: [] });
    const items = listForks(repo.id)
      .filter((fork) => canRead(fork, ctx.auth))
      .map((fork) => ({ ...repoJson(fork), ...statsFromCounts(fork) }));
    return json({ items });
  });

  router.get("/api/repos/:owner/:name/fork-parent", (ctx) => {
    const repo = loadReadableRepo(ctx);
    const parent = findForkParent(repo);
    if (!parent || !canRead(parent, ctx.auth)) return json({ parent: null });
    return json({ parent: repoJson(parent) });
  });

  router.get("/api/repos/:owner/:name/stargazers", (ctx) => {
    const repo = loadReadableRepo(ctx);
    return json({
      stars: starCount(repo.id),
      items: listStargazers(repo.id).map((hit) => ({
        username: hit.username,
        display_name: hit.display_name,
        avatar_hue: hit.avatar_hue,
        starred_at: hit.starred_at,
      })),
    });
  });

  router.put("/api/repos/:owner/:name/star", (ctx) => {
    const repo = loadReadableRepo(ctx);
    const principal = requireUser(ctx.auth);
    star(repo.id, principal.userId);
    increment("repo_stars_total");
    return json({ starred: true, stars: starCount(repo.id) });
  });

  router.delete("/api/repos/:owner/:name/star", (ctx) => {
    const repo = loadReadableRepo(ctx);
    const principal = requireUser(ctx.auth);
    unstar(repo.id, principal.userId);
    return json({ starred: false, stars: starCount(repo.id) });
  });

  const socialState = (repo: RepoRecord, userId: number | null) => {
    const level = watchLevel(repo.id, userId);
    return {
      watching: level === "all",
      watch_level: level,
      starring: isStarred(repo.id, userId),
      stars: starCount(repo.id),
      watchers: watcherCount(repo.id),
      forks: scalar<number>("SELECT COUNT(*) FROM repos WHERE fork_of = ?", repo.id) ?? 0,
    };
  };

  router.get("/api/repos/:owner/:name/watch", (ctx) => {
    const repo = loadReadableRepo(ctx);
    return json(socialState(repo, ctx.auth.kind === "user" ? ctx.auth.userId : null));
  });

  router.put("/api/repos/:owner/:name/watch", async (ctx) => {
    const repo = loadReadableRepo(ctx);
    const principal = requireUser(ctx.auth);
    const hasBody = Number(ctx.request.headers.get("content-length") ?? "0") > 0;
    const body = hasBody ? await readJson(ctx.request, watchSchema) : {};
    const level: WatchLevel = body.level ?? "all";
    setWatchLevel(repo.id, principal.userId, level);
    return json(socialState(repo, principal.userId));
  });

  router.delete("/api/repos/:owner/:name/watch", (ctx) => {
    const repo = loadReadableRepo(ctx);
    const principal = requireUser(ctx.auth);
    setWatchLevel(repo.id, principal.userId, "participating");
    return json(socialState(repo, principal.userId));
  });

  router.get("/api/repos/:owner/:name/watchers", (ctx) => {
    const repo = loadReadableRepo(ctx);
    return json({
      watchers: watcherCount(repo.id),
      items: listWatchers(repo.id).map((hit) => ({
        username: hit.username,
        display_name: hit.display_name,
        avatar_hue: hit.avatar_hue,
        since: hit.starred_at,
      })),
    });
  });

  router.get("/api/repos/quota-report", (ctx) => {
    const principal = requireUser(ctx.auth);
    if (!principal.isAdmin) throw forbidden("Administrator access required");
    const rows = quotaReport();
    return json({ items: rows });
  });

  router.put("/api/repos/:owner/:name/quota", async (ctx) => {
    const repo = requireRepo(param(ctx, "owner"), param(ctx, "name"));
    const principal = requireUser(ctx.auth);

    if (!canWrite(repo, ctx.auth)) {
      throw forbidden("You do not have write access to this repository");
    }
    if (repo.org_id !== null) {
      assertOrgRole(principal, repo.org_id, "admin");
    }

    const body = await readJson(ctx.request, quotaSchema);
    const updated = updateRepository(repo, {
      quotaBytes: body.quota_bytes === null ? null : normalizeQuota(body.quota_bytes),
    });
    return json({
      ...repoJson(updated),
      quota_bytes: updated.quota_bytes,
      effective_quota_bytes: effectiveQuotaBytes(updated),
    });
  });

  router.get("/api/repos/:owner/:name/quota", async (ctx) => {
    const repo = loadReadableRepo(ctx);
    const stats = await repoGitStats(repo);
    const limit = effectiveQuotaBytes(repo);
    return json({
      used_bytes: stats.sizeBytes,
      limit_bytes: Number.isFinite(limit) ? limit : null,
      default_limit_bytes: repo.quota_bytes === null ? null : undefined,
      over_quota: repo.over_quota_at !== null,
      percent_used: Number.isFinite(limit) && limit > 0
        ? Math.min(100, Math.round((stats.sizeBytes / limit) * 1000) / 10)
        : null,
    });
  });

  router.get("/api/repos/:owner/:name/push-policy", async (ctx) => {
    const repo = loadReadableRepo(ctx);
    const policy = await getPushPolicy(repo);
    return json({
      deny_non_fast_forwards: policy.denyNonFastForwards,
      deny_deletes: policy.denyDeletes,
      fsck_objects: policy.fsckObjects,
      defaults: defaultPushPolicy(),
      differs_from_default: differsFromDefault(policy),
    });
  });

  router.put("/api/repos/:owner/:name/push-policy", async (ctx) => {
    const repo = requireRepo(param(ctx, "owner"), param(ctx, "name"));
    const principal = requireUser(ctx.auth);

    if (!canWrite(repo, ctx.auth)) {
      throw forbidden("You do not have write access to this repository");
    }
    if (repo.org_id !== null) {
      assertOrgRole(principal, repo.org_id, "admin");
    }

    const body = await readJson(ctx.request, pushPolicySchema);
    const current = await getPushPolicy(repo);
    const updated = await setPushPolicy(repo, {
      denyNonFastForwards: body.deny_non_fast_forwards ?? current.denyNonFastForwards,
      denyDeletes: body.deny_deletes ?? current.denyDeletes,
      fsckObjects: body.fsck_objects ?? current.fsckObjects,
    });
    increment("push_policy_changes_total");
    return json({
      deny_non_fast_forwards: updated.denyNonFastForwards,
      deny_deletes: updated.denyDeletes,
      fsck_objects: updated.fsckObjects,
      defaults: defaultPushPolicy(),
      differs_from_default: differsFromDefault(updated),
    });
  });

}

export function quotaReport(): Array<Record<string, unknown>> {
  const repos = allReposWithQuota();
  return repos.map((repo) => {
    const limit = effectiveQuotaBytes(repo);
    return {
      repository: `${repo.owner_username}/${repo.name}`,
      owner_kind: repo.owner_kind,
      visibility: repo.visibility,
      used_bytes: repo.used_bytes,
      limit_bytes: Number.isFinite(limit) ? limit : null,
      over_quota: repo.over_quota_at !== null,
    };
  });
}

import { all } from "../../db/index.ts";
import { selectionForQuotaReport } from "../../data/repos.ts";

function allReposWithQuota(): Array<RepoRecord & { used_bytes: number }> {
  return all<RepoRecord & { used_bytes: number }>(selectionForQuotaReport());
}

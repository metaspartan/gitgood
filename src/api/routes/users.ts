import { json } from "../../lib/http.ts";
import { badRequest, notFound } from "../../lib/errors.ts";
import { all } from "../../db/index.ts";
import { findUserByUsername, requireUser, toPublicUser, type UserRow } from "../../auth/service.ts";
import { canRead, findRepoById, listReposByOwner, repoStats, statsFromCounts, type RepoRecord } from "../../data/repos.ts";
import { contributedRepoIds, contributionReport, profileReadmeRepo } from "../../data/activity.ts";
import { MAX_PINS, pinnedRepoIds, setPins } from "../../data/pins.ts";
import { allCommitEmails } from "../../data/user-emails.ts";
import { readJson } from "../../lib/http.ts";
import * as v from "../../lib/validate.ts";
import { listStarredByUser } from "../../data/stars.ts";
import { repoJson, userJson, profileFieldsJson } from "../serialize.ts";
import { param } from "../helpers.ts";
import type { Router } from "../router.ts";

const pinsSchema = v.strictObject({ repo_ids: v.array(v.number({ int: true, min: 1 }), { max: 20 }) });

export function registerUserRoutes(router: Router): void {
  router.get("/api/users", (ctx) => {
    const search = ctx.url.searchParams.get("q");
    const limit = Math.min(Number.parseInt(ctx.url.searchParams.get("limit") ?? "50", 10) || 50, 200);
    const rows = search
      ? all<UserRow>(
          "SELECT * FROM users WHERE username LIKE ? OR display_name LIKE ? ORDER BY username LIMIT ?",
          `%${search}%`,
          `%${search}%`,
          limit,
        )
      : all<UserRow>("SELECT * FROM users ORDER BY created_at DESC LIMIT ?", limit);
    return json({ items: rows.map((row) => userJson(toPublicUser(row))) });
  });

  router.get("/api/users/:username", (ctx) => {
    const row = findUserByUsername(param(ctx, "username"));
    if (!row) throw notFound("User not found");
    const repoCount = listReposByOwner(row.id).filter((repo) => canRead(repo, ctx.auth)).length;
    const starCount = listStarredByUser(row.id, 1000).filter((repo) => canRead(repo, ctx.auth)).length;
    const readmeRepoId = profileReadmeRepo(row.id, row.username);
    const readmeRepo = readmeRepoId === null ? null : findRepoById(readmeRepoId);
    return json({
      ...userJson(toPublicUser(row)),
      ...profileFieldsJson(row),
      repo_count: repoCount,
      star_count: starCount,
      has_profile_readme: readmeRepo !== null && canRead(readmeRepo, ctx.auth),
    });
  });

  router.get("/api/users/:username/repos", (ctx) => {
    const row = findUserByUsername(param(ctx, "username"));
    if (!row) throw notFound("User not found");
    const repos = listReposByOwner(row.id).filter((repo) => canRead(repo, ctx.auth));
    return json({ items: repos.map((repo) => ({ ...repoJson(repo), ...statsFromCounts(repo) })) });
  });

  router.get("/api/users/:username/contributions", async (ctx) => {
    const row = findUserByUsername(param(ctx, "username"));
    if (!row) throw notFound("User not found");
    const tz = Number.parseInt(ctx.url.searchParams.get("tz") ?? "0", 10);
    const offset = Number.isFinite(tz) ? Math.max(-840, Math.min(840, tz)) : 0;
    const rawYear = ctx.url.searchParams.get("year");
    const year = rawYear && /^\d{4}$/.test(rawYear) ? Number(rawYear) : null;
    const repos = contributedRepoIds(row.id)
      .map((id) => findRepoById(id))
      .filter((repo): repo is RepoRecord => repo !== null && canRead(repo, ctx.auth));
    const report = await contributionReport({ user: row, emails: allCommitEmails(row), repos, year, offsetMinutes: offset, at: Date.now() });
    return json(report, { headers: { "cache-control": "private, max-age=60" } });
  });

  router.get("/api/users/:username/pins", (ctx) => {
    const row = findUserByUsername(param(ctx, "username"));
    if (!row) throw notFound("User not found");
    const repos = pinnedRepoIds(row.id)
      .map((id) => findRepoById(id))
      .filter((repo): repo is RepoRecord => repo !== null && canRead(repo, ctx.auth));
    return json({ items: repos.map((repo) => ({ ...repoJson(repo), ...repoStats(repo) })) });
  });

  router.put("/api/user/pins", async (ctx) => {
    const principal = requireUser(ctx.auth);
    const body = await readJson(ctx.request, pinsSchema);
    const ids = [...new Set(body.repo_ids)];
    if (ids.length > MAX_PINS) throw badRequest(`You can pin up to ${MAX_PINS} repositories`);
    for (const id of ids) {
      const repo = findRepoById(id);
      const own = repo !== null && repo.owner_id === principal.userId && repo.org_id === null;
      if (!repo || !canRead(repo, ctx.auth) || (!own && repo.visibility !== "public")) throw notFound("Repository not found");
    }
    setPins(principal.userId, ids);
    return json({ repo_ids: pinnedRepoIds(principal.userId) });
  });

  router.get("/api/users/:username/starred", (ctx) => {
    const row = findUserByUsername(param(ctx, "username"));
    if (!row) throw notFound("User not found");
    const repos = listStarredByUser(row.id, 1000).filter((repo) => canRead(repo, ctx.auth));
    return json({ items: repos.map((repo) => ({ ...repoJson(repo), ...statsFromCounts(repo) })) });
  });
}

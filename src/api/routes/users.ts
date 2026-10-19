import { json } from "../../lib/http.ts";
import { notFound } from "../../lib/errors.ts";
import { all } from "../../db/index.ts";
import { findUserByUsername, toPublicUser, type UserRow } from "../../auth/service.ts";
import { canRead, findRepoById, listReposByOwner, statsFromCounts } from "../../data/repos.ts";
import { contributionCalendar } from "../../data/activity.ts";
import { listStarredByUser } from "../../data/stars.ts";
import { repoJson, userJson } from "../serialize.ts";
import { param } from "../helpers.ts";
import type { Router } from "../router.ts";

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
    return json({ ...userJson(toPublicUser(row)), repo_count: repoCount, star_count: starCount });
  });

  router.get("/api/users/:username/repos", (ctx) => {
    const row = findUserByUsername(param(ctx, "username"));
    if (!row) throw notFound("User not found");
    const repos = listReposByOwner(row.id).filter((repo) => canRead(repo, ctx.auth));
    return json({ items: repos.map((repo) => ({ ...repoJson(repo), ...statsFromCounts(repo) })) });
  });

  router.get("/api/users/:username/contributions", (ctx) => {
    const row = findUserByUsername(param(ctx, "username"));
    if (!row) throw notFound("User not found");
    const tz = Number.parseInt(ctx.url.searchParams.get("tz") ?? "0", 10);
    const offset = Number.isFinite(tz) ? Math.max(-840, Math.min(840, tz)) : 0;
    const calendar = contributionCalendar(row.id, (repoId) => {
      const repo = findRepoById(repoId);
      return repo !== null && canRead(repo, ctx.auth);
    }, offset);
    return json(calendar, { headers: { "cache-control": "private, max-age=60" } });
  });

  router.get("/api/users/:username/starred", (ctx) => {
    const row = findUserByUsername(param(ctx, "username"));
    if (!row) throw notFound("User not found");
    const repos = listStarredByUser(row.id, 1000).filter((repo) => canRead(repo, ctx.auth));
    return json({ items: repos.map((repo) => ({ ...repoJson(repo), ...statsFromCounts(repo) })) });
  });
}

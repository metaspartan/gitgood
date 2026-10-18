import { json } from "../../lib/http.ts";
import { notFound } from "../../lib/errors.ts";
import { all, scalar } from "../../db/index.ts";
import { findUserByUsername, toPublicUser, type UserRow } from "../../auth/service.ts";
import { canRead, listReposByOwner, statsFromCounts } from "../../data/repos.ts";
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
    const repoCount =
      scalar<number>("SELECT COUNT(*) FROM repos WHERE owner_id = ? AND org_id IS NULL", row.id) ?? 0;
    return json({ ...userJson(toPublicUser(row)), repo_count: repoCount });
  });

  router.get("/api/users/:username/repos", (ctx) => {
    const row = findUserByUsername(param(ctx, "username"));
    if (!row) throw notFound("User not found");
    const repos = listReposByOwner(row.id).filter((repo) => canRead(repo, ctx.auth));
    return json({ items: repos.map((repo) => ({ ...repoJson(repo), ...statsFromCounts(repo) })) });
  });
}

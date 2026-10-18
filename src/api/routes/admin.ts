import { createUser, findUserById, requireInstanceAdmin, type Principal } from "../../auth/service.ts";
import { assertPasswordStrength, hashPassword } from "../../auth/password.ts";
import { ciRunnerStatus } from "../../ci/policy.ts";
import { listRunners } from "../../ci/runners.ts";
import { instanceSettings, updateInstanceSettings } from "../../data/instance-settings.ts";
import { all, changes, now, one, run, scalar } from "../../db/index.ts";
import { lfsTotalsFor } from "../../lfs/totals.ts";
import { conflict, notFound } from "../../lib/errors.ts";
import { json, readJson } from "../../lib/http.ts";
import * as v from "../../lib/validate.ts";
import { param, positiveId } from "../helpers.ts";
import type { RouteContext, Router } from "../router.ts";

const PAGE_SIZE = 50;
const startedAt = Date.now();

const createUserSchema = v.strictObject({
  username: v.string({ min: 1, max: 39 }),
  email: v.string({ min: 3, max: 254, pattern: /^[^@\s]+@[^@\s]+\.[^@\s]+$/ }),
  password: v.string({ min: 8, max: 256, trim: false }),
  display_name: v.optional(v.string({ min: 1, max: 64 })),
  is_admin: v.optional(v.boolean()),
});

const updateUserSchema = v.strictObject({
  is_admin: v.optional(v.boolean()),
  blocked: v.optional(v.boolean()),
  password: v.optional(v.string({ min: 8, max: 256, trim: false })),
});

const settingsSchema = v.strictObject({
  allow_signup: v.optional(v.boolean()),
  allow_repo_creation: v.optional(v.boolean()),
  default_visibility: v.optional(v.enumOf(["public", "private"] as const)),
  actions_default_enabled: v.optional(v.boolean()),
});

interface AdminUserRow {
  id: number;
  username: string;
  email: string;
  display_name: string;
  is_admin: number;
  avatar_hue: number;
  created_at: number;
  blocked_at: number | null;
  repo_count: number;
  last_active_at: number | null;
}

function adminFor(ctx: RouteContext, mutating: boolean): Principal {
  return requireInstanceAdmin(ctx.auth, mutating);
}

function pageOf(ctx: RouteContext): { page: number; offset: number; q: string } {
  const page = Math.max(1, Math.min(Number(ctx.url.searchParams.get("page")) || 1, 10_000));
  const q = (ctx.url.searchParams.get("q") ?? "").trim().slice(0, 100);
  return { page, offset: (page - 1) * PAGE_SIZE, q };
}

function likePattern(q: string): string {
  return `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

function userJson(row: AdminUserRow) {
  return {
    id: row.id,
    username: row.username,
    email: row.email,
    display_name: row.display_name,
    avatar_hue: row.avatar_hue,
    is_admin: row.is_admin === 1,
    blocked: row.blocked_at !== null,
    blocked_at: row.blocked_at,
    created_at: row.created_at,
    repo_count: row.repo_count,
    last_active_at: row.last_active_at,
  };
}

const USER_SELECT = `SELECT u.id, u.username, u.email, u.display_name, u.is_admin, u.avatar_hue, u.created_at, u.blocked_at,
  (SELECT COUNT(*) FROM repos r WHERE r.owner_id = u.id AND r.org_id IS NULL) AS repo_count,
  (SELECT MAX(s.created_at) FROM sessions s WHERE s.user_id = u.id) AS last_active_at
  FROM users u`;

function loadAdminUser(id: number): AdminUserRow {
  const row = one<AdminUserRow>(`${USER_SELECT} WHERE u.id = ?`, id);
  if (!row) throw notFound("User not found");
  return row;
}

function activeAdminCount(): number {
  return scalar<number>("SELECT COUNT(*) FROM users WHERE is_admin = 1 AND blocked_at IS NULL") ?? 0;
}

function settingsJson() {
  const s = instanceSettings();
  return {
    allow_signup: s.allowSignup,
    allow_repo_creation: s.allowRepoCreation,
    default_visibility: s.defaultVisibility,
    actions_default_enabled: s.actionsDefaultEnabled,
  };
}

export function registerAdminRoutes(router: Router): void {
  router.get("/api/admin/overview", (ctx) => {
    adminFor(ctx, false);
    const count = (sql: string) => scalar<number>(sql) ?? 0;
    const runners = listRunners();
    const lfs = one<{ n: number; b: number }>("SELECT COUNT(*) AS n, COALESCE(SUM(size), 0) AS b FROM lfs_objects");
    const memory = process.memoryUsage();
    return json({
      users: { total: count("SELECT COUNT(*) FROM users"), admins: count("SELECT COUNT(*) FROM users WHERE is_admin = 1"), blocked: count("SELECT COUNT(*) FROM users WHERE blocked_at IS NOT NULL") },
      repositories: { total: count("SELECT COUNT(*) FROM repos"), private: count("SELECT COUNT(*) FROM repos WHERE visibility = 'private'"), archived: count("SELECT COUNT(*) FROM repos WHERE archived = 1") },
      organizations: count("SELECT COUNT(*) FROM orgs"),
      issues: { open: count("SELECT COUNT(*) FROM issues WHERE state = 'open'"), total: count("SELECT COUNT(*) FROM issues") },
      pulls: { open: count("SELECT COUNT(*) FROM pulls WHERE state = 'open'"), total: count("SELECT COUNT(*) FROM pulls") },
      ci: {
        ...ciRunnerStatus(),
        queued: count("SELECT COUNT(*) FROM ci_runs WHERE status = 'queued'"),
        running: count("SELECT COUNT(*) FROM ci_runs WHERE status = 'running'"),
        runners: runners.length,
        runners_online: runners.filter((r) => r.online && !r.paused).length,
      },
      lfs: { objects: lfs?.n ?? 0, bytes: lfs?.b ?? 0 },
      system: {
        uptime_ms: Date.now() - startedAt,
        rss_bytes: memory.rss,
        heap_bytes: memory.heapUsed,
        bun: Bun.version,
        platform: `${process.platform}/${process.arch}`,
      },
    });
  });

  router.get("/api/admin/users", (ctx) => {
    adminFor(ctx, false);
    const { page, offset, q } = pageOf(ctx);
    const filter = ctx.url.searchParams.get("filter");
    const where: string[] = [];
    const args: Array<string | number> = [];
    if (q) {
      where.push("(u.username LIKE ? ESCAPE '\\' OR u.email LIKE ? ESCAPE '\\' OR u.display_name LIKE ? ESCAPE '\\')");
      args.push(likePattern(q), likePattern(q), likePattern(q));
    }
    if (filter === "admins") where.push("u.is_admin = 1");
    if (filter === "blocked") where.push("u.blocked_at IS NOT NULL");
    const clause = where.length ? ` WHERE ${where.join(" AND ")}` : "";
    const total = scalar<number>(`SELECT COUNT(*) FROM users u${clause}`, ...args) ?? 0;
    const rows = all<AdminUserRow>(`${USER_SELECT}${clause} ORDER BY u.id LIMIT ? OFFSET ?`, ...args, PAGE_SIZE, offset);
    return json({ items: rows.map(userJson), total, page, per_page: PAGE_SIZE });
  });

  router.post("/api/admin/users", async (ctx) => {
    adminFor(ctx, true);
    const body = await readJson(ctx.request, createUserSchema);
    const user = await createUser({
      username: body.username,
      email: body.email,
      password: body.password,
      ...(body.display_name ? { displayName: body.display_name } : {}),
    });
    if (body.is_admin) changes("UPDATE users SET is_admin = 1 WHERE id = ?", user.id);
    return json({ user: userJson(loadAdminUser(user.id)) }, { status: 201 });
  });

  router.patch("/api/admin/users/:id", async (ctx) => {
    const admin = adminFor(ctx, true);
    const id = positiveId(param(ctx, "id"));
    const body = await readJson(ctx.request, updateUserSchema);
    const target = loadAdminUser(id);
    const self = id === admin.userId;
    if (body.blocked === true && self) throw conflict("You cannot block your own account");
    if (body.is_admin === false && self) throw conflict("You cannot remove your own administrator access");
    const losesAdmin = target.is_admin === 1 && target.blocked_at === null && (body.is_admin === false || body.blocked === true);
    if (losesAdmin && activeAdminCount() <= 1) throw conflict("The instance must keep at least one active administrator");
    if (body.is_admin !== undefined) changes("UPDATE users SET is_admin = ? WHERE id = ?", body.is_admin ? 1 : 0, id);
    if (body.blocked !== undefined) {
      changes("UPDATE users SET blocked_at = ? WHERE id = ?", body.blocked ? now() : null, id);
      if (body.blocked) changes("DELETE FROM sessions WHERE user_id = ?", id);
    }
    if (body.password !== undefined) {
      assertPasswordStrength(body.password);
      run("UPDATE users SET password_hash = ?, credentials_changed_at = ? WHERE id = ?", await hashPassword(body.password), now(), id);
      changes("DELETE FROM sessions WHERE user_id = ?", id);
    }
    return json({ user: userJson(loadAdminUser(id)) });
  });

  router.delete("/api/admin/users/:id", (ctx) => {
    const admin = adminFor(ctx, true);
    const id = positiveId(param(ctx, "id"));
    const target = loadAdminUser(id);
    if (id === admin.userId) throw conflict("You cannot delete your own account here");
    if (target.repo_count > 0) throw conflict(`${target.username} still owns ${target.repo_count} repositories. Transfer or delete them first.`);
    if (target.is_admin === 1 && target.blocked_at === null && activeAdminCount() <= 1) throw conflict("The instance must keep at least one active administrator");
    if (!findUserById(id)) throw notFound("User not found");
    changes("DELETE FROM users WHERE id = ?", id);
    return new Response(null, { status: 204 });
  });

  router.get("/api/admin/repositories", (ctx) => {
    adminFor(ctx, false);
    const { page, offset, q } = pageOf(ctx);
    const owner = "COALESCE(o.name, u.username)";
    const clause = q ? ` WHERE (r.name LIKE ? ESCAPE '\\' OR ${owner} LIKE ? ESCAPE '\\')` : "";
    const args = q ? [likePattern(q), likePattern(q)] : [];
    const from = " FROM repos r JOIN users u ON u.id = r.owner_id LEFT JOIN orgs o ON o.id = r.org_id";
    const total = scalar<number>(`SELECT COUNT(*)${from}${clause}`, ...args) ?? 0;
    const rows = all<{ id: number; name: string; owner: string; visibility: string; archived: number; actions_enabled: number; created_at: number; updated_at: number }>(
      `SELECT r.id, r.name, ${owner} AS owner, r.visibility, r.archived, r.actions_enabled, r.created_at, r.updated_at${from}${clause} ORDER BY r.updated_at DESC LIMIT ? OFFSET ?`,
      ...args,
      PAGE_SIZE,
      offset,
    );
    return json({
      items: rows.map((row) => ({
        ...row,
        archived: row.archived === 1,
        actions_enabled: row.actions_enabled !== 0,
        full_name: `${row.owner}/${row.name}`,
        lfs_bytes: lfsTotalsFor(row.id).lfsBytes,
      })),
      total,
      page,
      per_page: PAGE_SIZE,
    });
  });

  router.get("/api/admin/settings", (ctx) => {
    adminFor(ctx, false);
    return json(settingsJson());
  });

  router.put("/api/admin/settings", async (ctx) => {
    adminFor(ctx, true);
    const body = await readJson(ctx.request, settingsSchema);
    updateInstanceSettings({
      ...(body.allow_signup !== undefined ? { allowSignup: body.allow_signup } : {}),
      ...(body.allow_repo_creation !== undefined ? { allowRepoCreation: body.allow_repo_creation } : {}),
      ...(body.default_visibility !== undefined ? { defaultVisibility: body.default_visibility } : {}),
      ...(body.actions_default_enabled !== undefined ? { actionsDefaultEnabled: body.actions_default_enabled } : {}),
    });
    return json(settingsJson());
  });
}

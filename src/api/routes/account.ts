import * as v from "../../lib/validate.ts";
import { badRequest, conflict, unauthorized } from "../../lib/errors.ts";
import { json, readJson } from "../../lib/http.ts";
import { hashPassword, verifyPassword, assertPasswordStrength } from "../../auth/password.ts";
import { bootstrapPending, clearBootstrapFlag } from "../../auth/bootstrap.ts";
import { findUserById, listUserSessions, requireUser, revokeOtherSessions, revokeUserSession, SESSION_COOKIE, type UserRow } from "../../auth/service.ts";
import { readCookie } from "../../lib/http.ts";
import { notFound } from "../../lib/errors.ts";
import { addCommitEmail, allCommitEmails, commitEmails, emailClaimedByAnyone, MAX_COMMIT_EMAILS, removeCommitEmail } from "../../data/user-emails.ts";
import { suggestCommitEmails } from "../../data/activity.ts";
import { listReposByOwner } from "../../data/repos.ts";
import { invalidatePrefix } from "../../lib/cache.ts";
import { one, run } from "../../db/index.ts";
import { selfUserJson } from "../serialize.ts";
import type { RouteContext, Router } from "../router.ts";

const USERNAME = /^[A-Za-z0-9](?:[A-Za-z0-9_-]{0,38})$/;

const RESERVED = new Set([
  "api", "new", "settings", "login", "signup", "notifications", "organisations",
  "orgs", "search", "admin", "root", "system", "gitgood", "help", "about",
  "static", "assets",
]);

const profileSchema = v.strictObject({
  username: v.optional(v.string({ min: 1, max: 39 })),
  email: v.optional(v.string({ min: 3, max: 254 })),
  display_name: v.optional(v.string({ min: 1, max: 64 })),
  bio: v.optional(v.string({ max: 160 })),
  company: v.optional(v.string({ max: 100 })),
  location: v.optional(v.string({ max: 100 })),
  website: v.optional(v.string({ max: 200 })),
  show_private_contributions: v.optional(v.boolean()),
});

export function normalizeWebsite(raw: string): string {
  const value = raw.trim();
  if (!value) return "";
  const candidate = /^[a-z][a-z0-9+.-]*:/i.test(value) ? value : `https://${value}`;
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    throw badRequest("Website must be a valid http or https URL");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw badRequest("Website must be a valid http or https URL");
  if (url.username || url.password) throw badRequest("Website must not contain credentials");
  return url.toString();
}

const passwordSchema = v.strictObject({
  current_password: v.string({ min: 1, max: 256, trim: false }),
  new_password: v.string({ min: 8, max: 256, trim: false }),
});

function caller(ctx: RouteContext): UserRow {
  const principal = requireUser(ctx.auth);
  const user = findUserById(principal.userId);
  if (!user) throw unauthorized();
  return user;
}

function orgExists(name: string): boolean {
  return (one<{ c: number }>(`SELECT COUNT(*) AS c FROM orgs WHERE name = ? COLLATE NOCASE`, name)?.c ?? 0) > 0;
}

function currentSessionId(ctx: RouteContext): string | null {
  return ctx.auth.kind === "user" && ctx.auth.via === "session" ? readCookie(ctx.request, SESSION_COOKIE) : null;
}

const emailSchema = v.strictObject({ email: v.string({ min: 3, max: 254 }) });

export function registerAccountRoutes(router: Router): void {
  router.get("/api/account/emails", (ctx) => {
    const user = caller(ctx);
    return json({ primary: user.email, items: commitEmails(user.id), max: MAX_COMMIT_EMAILS });
  });

  router.get("/api/account/emails/suggestions", async (ctx) => {
    const user = caller(ctx);
    const owned = listReposByOwner(user.id).filter((repo) => repo.org_id === null && repo.fork_of === null);
    const mine = new Set(allCommitEmails(user).map((email) => email.toLowerCase()));
    const items = await suggestCommitEmails(owned, (email) => mine.has(email.toLowerCase()) || emailClaimedByAnyone(email));
    return json({ items });
  });

  router.post("/api/account/emails", async (ctx) => {
    const user = caller(ctx);
    const body = await readJson(ctx.request, emailSchema);
    addCommitEmail(user.id, body.email);
    invalidatePrefix("activity:");
    return json({ primary: user.email, items: commitEmails(user.id), max: MAX_COMMIT_EMAILS }, { status: 201 });
  });

  router.delete("/api/account/emails/:email", (ctx) => {
    const user = caller(ctx);
    if (!removeCommitEmail(user.id, decodeURIComponent(ctx.params.email ?? ""))) throw notFound("Email not found");
    invalidatePrefix("activity:");
    return json({ primary: user.email, items: commitEmails(user.id), max: MAX_COMMIT_EMAILS });
  });

  router.get("/api/account/sessions", (ctx) => {
    const user = caller(ctx);
    return json({ items: listUserSessions(user.id, currentSessionId(ctx)) });
  });

  router.delete("/api/account/sessions/:id", (ctx) => {
    const user = caller(ctx);
    const id = ctx.params.id ?? "";
    if (!/^[0-9a-f]{20}$/.test(id) || !revokeUserSession(user.id, id)) throw notFound("Session not found");
    return new Response(null, { status: 204 });
  });

  router.post("/api/account/sessions/revoke-others", (ctx) => {
    const user = caller(ctx);
    return json({ revoked: revokeOtherSessions(user.id, currentSessionId(ctx)) });
  });

  router.get("/api/account", (ctx) => {
    const user = caller(ctx);
    return json({
      user: selfUserJson(user),
      bootstrap_pending: user.is_bootstrap === 1,
      instance_bootstrap_pending: bootstrapPending(),
    });
  });

  router.patch("/api/account", async (ctx) => {
    const user = caller(ctx);
    const body = await readJson(ctx.request, profileSchema);
    let changedCredential = false;

    if (body.username !== undefined) {
      const next = body.username.trim();
      if (!USERNAME.test(next)) {
        throw badRequest(
          "Usernames start with a letter or digit, may contain letters, digits, hyphens and underscores, and are at most 39 characters",
        );
      }
      if (RESERVED.has(next.toLowerCase())) throw badRequest(`"${next}" is reserved`);
      if (next.toLowerCase() !== user.username.toLowerCase()) {
        const clash = one<{ id: number }>(`SELECT id FROM users WHERE username = ? COLLATE NOCASE`, next);
        if (clash && clash.id !== user.id) throw conflict("That username is already taken");
        if (orgExists(next)) throw conflict("An organisation already uses that name");
      }
      run(`UPDATE users SET username = ? WHERE id = ?`, next, user.id);
      changedCredential = true;
    }

    if (body.email !== undefined) {
      const next = body.email.trim();
      if (next.length > 254 || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(next)) {
        throw badRequest("That is not a valid email address");
      }
      const clash = one<{ id: number }>(`SELECT id FROM users WHERE email = ? COLLATE NOCASE`, next);
      if (clash && clash.id !== user.id) throw conflict("That email is already in use");
      run(`UPDATE users SET email = ? WHERE id = ?`, next, user.id);
      changedCredential = true;
    }

    if (body.display_name !== undefined) {
      run(`UPDATE users SET display_name = ? WHERE id = ?`, body.display_name.trim(), user.id);
    }
    for (const field of ["bio", "company", "location"] as const) {
      const value = body[field];
      if (value !== undefined) run(`UPDATE users SET ${field} = ? WHERE id = ?`, value.trim().replace(/\s+/g, " "), user.id);
    }
    if (body.website !== undefined) run("UPDATE users SET website = ? WHERE id = ?", normalizeWebsite(body.website), user.id);
    if (body.show_private_contributions !== undefined) run("UPDATE users SET show_private_contributions = ? WHERE id = ?", body.show_private_contributions ? 1 : 0, user.id);

    if (changedCredential) clearBootstrapFlag(user.id);

    const updated = findUserById(user.id);
    if (!updated) throw unauthorized();
    return json({ user: selfUserJson(updated), bootstrap_pending: updated.is_bootstrap === 1 });
  });

  router.post("/api/account/password", async (ctx) => {
    const user = caller(ctx);
    const body = await readJson(ctx.request, passwordSchema);

    if (!(await verifyPassword(body.current_password, user.password_hash))) {
      throw badRequest("That is not your current password");
    }
    assertPasswordStrength(body.new_password);
    if (body.new_password === body.current_password) {
      throw badRequest("The new password must be different from the current one");
    }

    const stamp = Date.now();
    run(
      `UPDATE users SET password_hash = ?, credentials_changed_at = ? WHERE id = ?`,
      await hashPassword(body.new_password),
      stamp,
      user.id,
    );
    clearBootstrapFlag(user.id);

    const match = new RegExp(`${SESSION_COOKIE}=([^;]+)`).exec(ctx.request.headers.get("cookie") ?? "");
    if (match?.[1]) {
      run(`UPDATE sessions SET created_at = ? WHERE id = ?`, stamp, decodeURIComponent(match[1]));
    }
    return json({ ok: true });
  });
}

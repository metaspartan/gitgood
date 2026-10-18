import { config } from "../../config.ts";
import {
  checkLoginThrottle,
  recordLoginFailure,
  recordLoginSuccess,
  retryAfterSeconds,
} from "../../auth/login-throttle.ts";
import {
  createAccessToken,
  createUser,
  findUserById,
  listAccessTokens,
  login,
  logout,
  pruneExpiredSessions,
  requireUser,
  resolveAuth,
  revokeAccessToken,
  SESSION_COOKIE,
  type UserRow,
} from "../../auth/service.ts";
import { badRequest, conflict, forbidden, invalidCredentials, notFound, tooManyAttempts, unauthorized } from "../../lib/errors.ts";
import { clearCookie, json, readJson, serializeCookie } from "../../lib/http.ts";
import * as v from "../../lib/validate.ts";
import { scalar } from "../../db/index.ts";
import { canWrite, requireRepo } from "../../data/repos.ts";
import { normalizeRepoName } from "../../git/repo.ts";
import { isWellFormedCode, verifyTotp } from "../../auth/totp.ts";
import { consumeRecoveryCode, getTotpLastStep, getTotpState, setTotpLastStep, currentTotpStep } from "../../auth/account-store.ts";
import { hashRecoveryCode } from "../../auth/totp.ts";
import { issueSession, verifyCredentials } from "../../auth/service.ts";
import { createdTokenJson, selfUserJson, tokenJson } from "../serialize.ts";
import type { Router } from "../router.ts";
import { instanceSettings } from "../../data/instance-settings.ts";

const signupSchema = v.strictObject({
  username: v.string({ min: 1, max: 39 }),
  email: v.string({ min: 3, max: 254, pattern: /^[^@\s]+@[^@\s]+\.[^@\s]+$/ }),
  password: v.string({ min: 8, max: 256, trim: false }),
  display_name: v.optional(v.string({ min: 1, max: 64 })),
});

const loginSchema = v.strictObject({
  username: v.string({ min: 1, max: 254 }),
  password: v.string({ min: 1, max: 256, trim: false }),
});

const mfaLoginSchema = v.strictObject({
  username: v.string({ min: 1, max: 254 }),
  password: v.string({ min: 1, max: 256, trim: false }),
  code: v.string({ min: 6, max: 24 }),
});

const tokenSchema = v.strictObject({
  name: v.string({ min: 1, max: 64 }),
  scopes: v.optional(v.array(v.enumOf(["read", "write", "admin"] as const), { max: 3 })),
  repository: v.optional(v.string({ min: 1, max: 200 })),
});

function sessionHeaders(sessionId: string): Record<string, string> {
  return {
    "set-cookie": serializeCookie(SESSION_COOKIE, sessionId, {
      maxAge: config.sessionTtlSeconds,
      httpOnly: true,
      sameSite: "Lax",
      secure: config.env === "production" || config.baseUrl.startsWith("https"),
    }),
  };
}

export function registerAuthRoutes(router: Router): void {
  router.post("/api/auth/signup", async (ctx) => {
    const body = await readJson(ctx.request, signupSchema);
    const userCount = scalar<number>("SELECT COUNT(*) FROM users") ?? 0;
    if (!instanceSettings().allowSignup && userCount > 0) {
      throw forbidden("Signups are disabled on this instance");
    }
    let user: UserRow;
    try {
      user = await createUser({
        username: body.username,
        email: body.email,
        password: body.password,
        ...(body.display_name ? { displayName: body.display_name } : {}),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not create account";
      throw message.includes("taken") ? conflict(message) : badRequest(message);
    }
    const { sessionId } = await login(user.username, body.password);
    return json({ user: selfUserJson(user) }, { status: 201, headers: sessionHeaders(sessionId) });
  });

  router.post("/api/auth/login", async (ctx) => {
    const body = await readJson(ctx.request, loginSchema);

    const throttle = checkLoginThrottle(body.username);
    if (throttle.blocked) throw tooManyAttempts(retryAfterSeconds(throttle.retryAfterMs));

    let user;
    try {
      user = await verifyCredentials(body.username, body.password);
    } catch {
      recordLoginFailure(body.username);
      throw invalidCredentials();
    }
    recordLoginSuccess(body.username);

    const totp = getTotpState(user.id);
    if (totp.secret !== null && totp.confirmed_at !== null) {
      return json({ mfa_required: true, methods: ["totp", "recovery_code"] });
    }

    const sessionId = issueSession(user.id);
    pruneExpiredSessions();
    return json({ user: selfUserJson(user) }, { headers: sessionHeaders(sessionId) });
  });

  router.post("/api/auth/login/mfa", async (ctx) => {
    const body = await readJson(ctx.request, mfaLoginSchema);

    const throttle = checkLoginThrottle(body.username);
    if (throttle.blocked) throw tooManyAttempts(retryAfterSeconds(throttle.retryAfterMs));

    let user;
    try {
      user = await verifyCredentials(body.username, body.password);
    } catch {
      recordLoginFailure(body.username);
      throw invalidCredentials();
    }
    recordLoginSuccess(body.username);

    const totp = getTotpState(user.id);
    if (totp.secret === null || totp.confirmed_at === null) {
      throw badRequest("This account does not have two-factor authentication enabled");
    }

    const submitted = body.code.trim();
    let accepted = false;

    if (isWellFormedCode(submitted)) {
      const nowSeconds = Math.floor(Date.now() / 1000);
      const step = currentTotpStep(nowSeconds);
      const lastStep = getTotpLastStep(user.id);
      if (lastStep !== null && step <= lastStep) {
        accepted = false;
      } else if (verifyTotp(totp.secret, submitted, nowSeconds)) {
        setTotpLastStep(user.id, step);
        accepted = true;
      }
    } else {
      accepted = consumeRecoveryCode(user.id, hashRecoveryCode(submitted));
    }

    if (!accepted) {
      recordLoginFailure(body.username);
      throw unauthorized("That code did not match");
    }
    recordLoginSuccess(body.username);

    const sessionId = issueSession(user.id);
    pruneExpiredSessions();
    return json({ user: selfUserJson(user) }, { headers: sessionHeaders(sessionId) });
  });

  router.post("/api/auth/logout", (ctx) => {
    const cookie = ctx.request.headers.get("cookie");
    if (cookie) {
      const match = /gitgood_session=([^;]+)/.exec(cookie);
      if (match?.[1]) logout(decodeURIComponent(match[1]));
    }
    return json({ ok: true }, { headers: { "set-cookie": clearCookie(SESSION_COOKIE) } });
  });

  router.get("/api/auth/me", async (ctx) => {
    const auth = await resolveAuth(ctx.request);
    if (auth.kind !== "user") return json({ user: null });
    const user = findUserById(auth.userId);
    if (!user) throw unauthorized();
    return json({ user: selfUserJson(user) });
  });

  router.get("/api/tokens", (ctx) => {
    const principal = requireUser(ctx.auth);
    return json({ items: listAccessTokens(principal.userId).map(tokenJson) });
  });

  router.post("/api/tokens", async (ctx) => {
    const principal = requireUser(ctx.auth);
    const body = await readJson(ctx.request, tokenSchema);
    const scopes = body.scopes && body.scopes.length > 0 ? body.scopes.join(",") : "read,write";

    let repoId: number | null = null;
    let repoName: string | null = null;
    if (body.repository !== undefined) {
      const separator = body.repository.indexOf("/");
      if (separator <= 0 || separator === body.repository.length - 1 || body.repository.indexOf("/", separator + 1) !== -1) {
        throw badRequest("Repository must be given as owner/name");
      }
      const owner = body.repository.slice(0, separator);
      const name = normalizeRepoName(body.repository.slice(separator + 1));
      const repo = requireRepo(owner, name);
      if (!canWrite(repo, ctx.auth)) throw notFound("Repository not found");
      if (scopes.includes("admin")) {
        throw badRequest("A repository-limited token cannot carry the admin scope");
      }
      repoId = repo.id;
      repoName = `${owner}/${repo.name}`;
    }

    const token = { ...createAccessToken(principal.userId, body.name, scopes, repoId), repo_name: repoName };
    return json(createdTokenJson(token), { status: 201 });
  });

  router.delete("/api/tokens/:id", (ctx) => {
    const principal = requireUser(ctx.auth);
    const id = Number.parseInt(ctx.params.id ?? "", 10);
    if (!Number.isFinite(id)) throw badRequest("Invalid token id");
    if (!revokeAccessToken(principal.userId, id)) throw notFound("Token not found");
    return json({ ok: true });
  });
}

import { all, changes, now, one, run, scalar } from "../db/index.ts";
import { forbidden, unauthorized } from "../lib/errors.ts";
import {
  generateAccessToken,
  generateSessionId,
  hueFor,
  sha256Hex,
  USERNAME_PATTERN,
} from "../lib/ids.ts";
import { config } from "../config.ts";
import { readCookie, parseAuthHeader, type AuthHeader } from "../lib/http.ts";
import { hashPassword, verifyPassword } from "./password.ts";
import { checkLoginThrottle, recordLoginFailure, recordLoginSuccess } from "./login-throttle.ts";
import { getTotpState } from "./account-store.ts";

export const SESSION_COOKIE = "gitgood_session";

export interface UserRow {
  id: number;
  username: string;
  email: string;
  display_name: string;
  password_hash: string;
  is_admin: number;
  avatar_hue: number;
  created_at: number;
  is_bootstrap: number;
  credentials_changed_at: number | null;
  blocked_at?: number | null;
}

export interface PublicUser {
  id: number;
  username: string;
  display_name: string;
  avatar_hue: number;
  is_admin: boolean;
  created_at: number;
}

export interface Principal {
  kind: "user";
  userId: number;
  username: string;
  isAdmin: boolean;
  scopes: readonly string[];
  via: "session" | "token";
  tokenRepoId?: number | null;
}

export interface Anonymous {
  kind: "anonymous";
}

export type Auth = Principal | Anonymous;

export const ANONYMOUS: Anonymous = { kind: "anonymous" };

export function toPublicUser(row: UserRow): PublicUser {
  return {
    id: row.id,
    username: row.username,
    display_name: row.display_name,
    avatar_hue: row.avatar_hue,
    is_admin: row.is_admin === 1,
    created_at: row.created_at,
  };
}

export function findUserByUsername(username: string): UserRow | null {
  return one<UserRow>("SELECT * FROM users WHERE username = ?", username);
}

export function findUserById(id: number): UserRow | null {
  return one<UserRow>("SELECT * FROM users WHERE id = ?", id);
}

export interface CreateUserInput {
  username: string;
  email: string;
  password: string;
  displayName?: string;
}

export async function createUser(input: CreateUserInput): Promise<UserRow> {
  if (!USERNAME_PATTERN.test(input.username)) {
    throw new Error(
      "Username must start with a letter or digit and contain only letters, digits, dashes or underscores",
    );
  }
  const existing = scalar<number>(
    `SELECT (SELECT COUNT(*) FROM users WHERE username = ?)
          + (SELECT COUNT(*) FROM users WHERE email = ?)
          + (SELECT COUNT(*) FROM orgs WHERE name = ?)`,
    input.username,
    input.email,
    input.username,
  );
  if ((existing ?? 0) > 0) throw new Error("Username or email is already taken");

  const passwordHash = await hashPassword(input.password);
  const isFirst = (scalar<number>("SELECT COUNT(*) FROM users") ?? 0) === 0;
  const timestamp = now();
  const id = run(
    `INSERT INTO users (username, email, display_name, password_hash, is_admin, avatar_hue, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    input.username,
    input.email,
    input.displayName?.trim() || input.username,
    passwordHash,
    isFirst ? 1 : 0,
    hueFor(input.username),
    timestamp,
  );
  const created = findUserById(id);
  if (!created) throw new Error("Failed to create user");
  return created;
}

const DUMMY_HASH =
  "$argon2id$v=19$m=19456,t=2,p=1$c29tZXNhbHRzb21lc2FsdA$" +
  "RdescudvJCsgt3ub+b+dWRWJTmaaJObG";

export async function verifyCredentials(username: string, password: string): Promise<UserRow> {
  const user = findUserByUsername(username);
  if (!user) {
    await verifyPassword(password, DUMMY_HASH);
    throw unauthorized("Invalid username or password");
  }
  const valid = await verifyPassword(password, user.password_hash);
  if (!valid) throw unauthorized("Invalid username or password");
  if (user.blocked_at) throw unauthorized("This account has been blocked by an administrator");
  return user;
}

export function issueSession(userId: number): string {
  const sessionId = generateSessionId();
  const timestamp = now();
  run(
    "INSERT INTO sessions (id, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)",
    sessionId,
    userId,
    timestamp + config.sessionTtlSeconds * 1000,
    timestamp,
  );
  return sessionId;
}

export async function login(
  username: string,
  password: string,
): Promise<{ user: UserRow; sessionId: string }> {
  const user = await verifyCredentials(username, password);
  return { user, sessionId: issueSession(user.id) };
}

export function logout(sessionId: string): void {
  changes("DELETE FROM sessions WHERE id = ?", sessionId);
}

export function pruneExpiredSessions(): number {
  return changes("DELETE FROM sessions WHERE expires_at < ?", now());
}

export interface AccessTokenRow {
  id: number;
  user_id: number;
  name: string;
  token_hash: string;
  scopes: string;
  repo_id: number | null;
  repo_name: string | null;
  last_used_at: number | null;
  created_at: number;
}

export interface CreatedToken {
  id: number;
  name: string;
  scopes: string;
  repo_id: number | null;
  repo_name?: string | null;
  plaintext: string;
  created_at: number;
}

export function createAccessToken(
  userId: number,
  name: string,
  scopes = "read,write",
  repoId: number | null = null,
): CreatedToken {
  const token = generateAccessToken();
  const timestamp = now();
  const id = run(
    "INSERT INTO access_tokens (user_id, name, token_hash, scopes, repo_id, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    userId,
    name,
    token.hash,
    scopes,
    repoId,
    timestamp,
  );
  return { id, name, scopes, repo_id: repoId, plaintext: token.plaintext, created_at: timestamp };
}

export function listAccessTokens(userId: number): AccessTokenRow[] {
  return all<AccessTokenRow>(
    `SELECT t.*, (o.username || '/' || r.name) AS repo_name
       FROM access_tokens t
       LEFT JOIN repos r ON r.id = t.repo_id
       LEFT JOIN users o ON o.id = r.owner_id
      WHERE t.user_id = ?
      ORDER BY t.id DESC`,
    userId,
  );
}

export function revokeAccessToken(userId: number, tokenId: number): boolean {
  return changes("DELETE FROM access_tokens WHERE id = ? AND user_id = ?", tokenId, userId) > 0;
}

function scopesFor(row: AccessTokenRow): readonly string[] {
  return row.scopes
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export function principalForToken(token: string): Principal | null {
  const hash = sha256Hex(token);
  const row = one<AccessTokenRow>("SELECT * FROM access_tokens WHERE token_hash = ?", hash);
  if (!row) return null;
  const user = findUserById(row.user_id);
  if (!user || user.blocked_at) return null;
  changes("UPDATE access_tokens SET last_used_at = ? WHERE id = ?", now(), row.id);
  return {
    kind: "user",
    userId: user.id,
    username: user.username,
    isAdmin: user.is_admin === 1,
    scopes: scopesFor(row),
    via: "token",
    tokenRepoId: row.repo_id ?? null,
  };
}

export function principalForSession(sessionId: string): Principal | null {
  const session = one<{ id: string; user_id: number; expires_at: number; created_at: number }>(
    "SELECT id, user_id, expires_at, created_at FROM sessions WHERE id = ?",
    sessionId,
  );
  if (!session) return null;
  if (session.expires_at < now()) {
    changes("DELETE FROM sessions WHERE id = ?", sessionId);
    return null;
  }
  const user = findUserById(session.user_id);
  if (!user || user.blocked_at) return null;

  const changedAt = (user as { credentials_changed_at?: number | null }).credentials_changed_at ?? null;
  if (changedAt !== null && session.created_at !== undefined && session.created_at < changedAt) {
    changes("DELETE FROM sessions WHERE id = ?", sessionId);
    return null;
  }

  return {
    kind: "user",
    userId: user.id,
    username: user.username,
    isAdmin: user.is_admin === 1,
    scopes: ["read", "write", "admin"],
    via: "session",
    tokenRepoId: null,
  };
}

export async function resolveAuth(request: Request, headerOverride?: AuthHeader): Promise<Auth> {
  const header = headerOverride ?? parseAuthHeader(request);

  if (header.kind === "bearer") {
    return principalForToken(header.token) ?? ANONYMOUS;
  }

  if (header.kind === "basic") {
    const byPasswordToken = principalForToken(header.password);
    if (byPasswordToken) return byPasswordToken;

    if (checkLoginThrottle(header.username).blocked) return ANONYMOUS;
    const user = findUserByUsername(header.username);
    const valid = user ? await verifyPassword(header.password, user.password_hash) : await verifyPassword(header.password, DUMMY_HASH);
    if (!user || !valid) {
      recordLoginFailure(header.username);
      return ANONYMOUS;
    }
    recordLoginSuccess(header.username);
    if (!user.blocked_at && !hasConfirmedTotp(user.id)) {
      return {
        kind: "user",
        userId: user.id,
        username: user.username,
        isAdmin: user.is_admin === 1,
        scopes: ["read", "write", "admin"],
        via: "session",
      };
    }
    return ANONYMOUS;
  }

  const cookie = readCookie(request, SESSION_COOKIE);
  if (cookie) {
    const principal = principalForSession(cookie);
    if (principal) return principal;
  }
  return ANONYMOUS;
}

export function requireUser(auth: Auth): Principal {
  if (auth.kind !== "user") throw unauthorized();
  return auth;
}

export function requireWrite(auth: Auth): Principal {
  const principal = requireUser(auth);
  if (
    principal.via === "token" &&
    !principal.scopes.includes("write") &&
    !principal.scopes.includes("admin")
  ) {
    throw forbidden("This token does not have write scope");
  }
  return principal;
}

function hasConfirmedTotp(userId: number): boolean {
  const totp = getTotpState(userId);
  return totp.secret !== null && totp.confirmed_at !== null;
}

export function requireInstanceAdmin(auth: Auth, mutating: boolean): Principal {
  const principal = requireAdmin(auth);
  if (mutating && principal.via === "token" && !principal.scopes.includes("admin")) {
    throw forbidden("Instance administration with a token requires the admin scope");
  }
  return principal;
}

export function requireAdmin(auth: Auth): Principal {
  const principal = requireUser(auth);
  if (!principal.isAdmin) throw forbidden("Administrator access required");
  if (principal.via === "token" && principal.tokenRepoId != null) {
    throw forbidden("This token is limited to one repository and cannot perform instance administration");
  }
  return principal;
}

import { randomBytes } from "node:crypto";
import { hashPassword } from "./password.ts";
import { all, changes, now, one, run } from "../db/index.ts";

export interface BootstrapCredentials {
  username: string;
  email: string;
  generatedPassword: string | null;
}

function userCount(): number {
  return one<{ c: number }>(`SELECT COUNT(*) AS c FROM users`)?.c ?? 0;
}

export async function bootstrapAdmin(env: Record<string, string | undefined> = process.env): Promise<BootstrapCredentials | null> {
  if (userCount() > 0) return null;

  const username = (env.GITGOOD_ADMIN_USERNAME ?? "admin").trim() || "admin";
  const email = (env.GITGOOD_ADMIN_EMAIL ?? `${username}@localhost`).trim();
  const supplied = env.GITGOOD_ADMIN_PASSWORD;
  const generatedPassword = supplied && supplied.length > 0 ? null : randomBytes(12).toString("base64url");
  const password = supplied && supplied.length > 0 ? supplied : (generatedPassword as string);

  const hash = await hashPassword(password);
  run(
    `INSERT INTO users (username, email, display_name, password_hash, is_admin, is_bootstrap, avatar_hue, created_at)
     VALUES (?, ?, ?, ?, 1, 1, ?, ?)`,
    username,
    email,
    username,
    hash,
    hashHue(username),
    now(),
  );

  return { username, email, generatedPassword };
}

export function clearBootstrapFlag(userId: number): void {
  changes(`UPDATE users SET is_bootstrap = 0 WHERE id = ? AND is_bootstrap = 1`, userId);
}

export function bootstrapPending(): boolean {
  return (one<{ c: number }>(`SELECT COUNT(*) AS c FROM users WHERE is_bootstrap = 1`)?.c ?? 0) > 0;
}

export function bootstrapAccount(): { id: number; username: string } | null {
  return one<{ id: number; username: string }>(
    `SELECT id, username FROM users WHERE is_bootstrap = 1 ORDER BY id LIMIT 1`,
  );
}

export function adminCount(): number {
  return one<{ c: number }>(`SELECT COUNT(*) AS c FROM users WHERE is_admin = 1`)?.c ?? 0;
}

export function listAdmins(): Array<{ id: number; username: string }> {
  return all<{ id: number; username: string }>(`SELECT id, username FROM users WHERE is_admin = 1 ORDER BY id`);
}

function hashHue(value: string): number {
  let hash = 0;
  for (let i = 0; i < value.length; i++) hash = (hash * 31 + value.charCodeAt(i)) % 360;
  return hash;
}

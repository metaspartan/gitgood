import { all, changes, now, one, run } from "../db/index.ts";
import { badRequest, conflict } from "../lib/errors.ts";

export const MAX_COMMIT_EMAILS = 10;
const EMAIL = /^[^@\s<>]+@[^@\s<>]+\.[^@\s<>]+$/;

export function commitEmails(userId: number): string[] {
  return all<{ email: string }>("SELECT email FROM user_emails WHERE user_id = ? ORDER BY created_at", userId).map((row) => row.email);
}

export function allCommitEmails(user: { id: number; email: string }): string[] {
  const seen = new Set<string>();
  return [user.email, ...commitEmails(user.id)].filter((email) => {
    const key = email.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function emailClaimedByAnyone(email: string): boolean {
  return (
    one<{ id: number }>("SELECT id FROM users WHERE email = ? COLLATE NOCASE", email) !== null ||
    one<{ user_id: number }>("SELECT user_id FROM user_emails WHERE email = ?", email) !== null
  );
}

export function addCommitEmail(userId: number, raw: string): string {
  const email = raw.trim();
  if (email.length > 254 || !EMAIL.test(email)) throw badRequest("Enter a valid email address");
  if (commitEmails(userId).length >= MAX_COMMIT_EMAILS) throw badRequest(`You can add up to ${MAX_COMMIT_EMAILS} commit emails`);
  const primary = one<{ id: number }>("SELECT id FROM users WHERE email = ? COLLATE NOCASE", email);
  if (primary && primary.id !== userId) throw conflict("That email belongs to another account");
  if (primary) throw conflict("That is already your account email");
  const existing = one<{ user_id: number }>("SELECT user_id FROM user_emails WHERE email = ?", email);
  if (existing) throw conflict(existing.user_id === userId ? "You already added that email" : "That email belongs to another account");
  run("INSERT INTO user_emails (email, user_id, created_at) VALUES (?, ?, ?)", email, userId, now());
  return email;
}

export function removeCommitEmail(userId: number, email: string): boolean {
  return changes("DELETE FROM user_emails WHERE user_id = ? AND email = ?", userId, email) > 0;
}

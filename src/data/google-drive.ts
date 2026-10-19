import { randomBytes } from "node:crypto";
import { all, changes, now, one, run } from "../db/index.ts";
import {
  driveAccount,
  pollDeviceToken,
  requestDeviceCode,
  revokeGoogleToken,
  tokenSource,
  type GoogleClient,
} from "../lib/google-drive.ts";
import { openSecret, sealSecret } from "../lib/secret-box.ts";

export const GOOGLE_CLIENT_ID_PATTERN = /^[\w.-]{8,200}\.apps\.googleusercontent\.com$/;
const MAX_SESSIONS = 10;

export interface GoogleAccountRow {
  id: number;
  email: string;
  display_name: string;
  created_at: number;
  destinations: number;
}

export interface GoogleClientInfo {
  configured: boolean;
  source: "environment" | "admin" | null;
  client_id_hint: string | null;
}

interface Session {
  id: string;
  userId: number;
  deviceCode: string;
  expiresAt: number;
  interval: number;
  nextPollAt: number;
}

const sessions = new Map<string, Session>();

export function googleClient(): GoogleClient | null {
  const envId = process.env.GITGOOD_GOOGLE_CLIENT_ID;
  const envSecret = process.env.GITGOOD_GOOGLE_CLIENT_SECRET;
  if (envId && envSecret) return { clientId: envId, clientSecret: envSecret };
  const row = one<{ client_id: string; client_secret: string }>("SELECT client_id, client_secret FROM google_oauth_client WHERE id = 1");
  if (!row) return null;
  const secret = openSecret(row.client_secret);
  return secret ? { clientId: row.client_id, clientSecret: secret } : null;
}

export function googleClientInfo(): GoogleClientInfo {
  const envManaged = Boolean(process.env.GITGOOD_GOOGLE_CLIENT_ID && process.env.GITGOOD_GOOGLE_CLIENT_SECRET);
  const client = googleClient();
  if (!client) return { configured: false, source: null, client_id_hint: null };
  const prefix = client.clientId.split("-")[0] ?? "";
  return { configured: true, source: envManaged ? "environment" : "admin", client_id_hint: `${prefix.slice(0, 6)}…apps.googleusercontent.com` };
}

export function saveGoogleClient(clientId: string, clientSecret: string): void {
  if (process.env.GITGOOD_GOOGLE_CLIENT_ID && process.env.GITGOOD_GOOGLE_CLIENT_SECRET) throw new Error("The Google OAuth client is set in the server environment");
  if (!GOOGLE_CLIENT_ID_PATTERN.test(clientId)) throw new Error("That does not look like a Google OAuth client ID (it ends in .apps.googleusercontent.com)");
  if (!/^[\x21-\x7e]{8,200}$/.test(clientSecret)) throw new Error("Enter the client secret exactly as Google shows it");
  run(
    `INSERT INTO google_oauth_client (id, client_id, client_secret, updated_at) VALUES (1, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET client_id = excluded.client_id, client_secret = excluded.client_secret, updated_at = excluded.updated_at`,
    clientId,
    sealSecret(clientSecret),
    now(),
  );
}

export function removeGoogleClient(): void {
  if (listGoogleAccounts().length > 0) throw new Error("Disconnect every Google account before removing the OAuth client");
  changes("DELETE FROM google_oauth_client WHERE id = 1");
}

export function listGoogleAccounts(): GoogleAccountRow[] {
  return all<GoogleAccountRow>(
    `SELECT a.id, a.email, a.display_name, a.created_at,
            (SELECT COUNT(*) FROM backup_destinations d WHERE d.google_account_id = a.id) AS destinations
       FROM google_drive_accounts a ORDER BY a.created_at`,
  );
}

export function findGoogleAccount(id: number): GoogleAccountRow | null {
  return listGoogleAccounts().find((account) => account.id === id) ?? null;
}

export function googleRefreshToken(accountId: number): string | null {
  const row = one<{ refresh_token: string }>("SELECT refresh_token FROM google_drive_accounts WHERE id = ?", accountId);
  return row ? openSecret(row.refresh_token) : null;
}

export async function disconnectGoogleAccount(id: number): Promise<boolean> {
  const account = findGoogleAccount(id);
  if (!account) return false;
  if (account.destinations > 0) throw new Error("This account is used by a backup destination; remove or change the destination first");
  const token = googleRefreshToken(id);
  changes("DELETE FROM google_drive_accounts WHERE id = ?", id);
  if (token) await revokeGoogleToken(token);
  return true;
}

function purgeSessions(at: number): void {
  for (const [id, session] of sessions) if (session.expiresAt <= at) sessions.delete(id);
  while (sessions.size >= MAX_SESSIONS) sessions.delete(sessions.keys().next().value!);
}

export async function startGoogleConnect(userId: number): Promise<{ session: string; user_code: string; verification_url: string; expires_at: number; interval: number }> {
  const client = googleClient();
  if (!client) throw new Error("Set up the Google OAuth client first");
  const code = await requestDeviceCode(client);
  const at = now();
  purgeSessions(at);
  const id = randomBytes(18).toString("base64url");
  sessions.set(id, { id, userId, deviceCode: code.deviceCode, expiresAt: at + code.expiresIn * 1000, interval: code.interval, nextPollAt: at + code.interval * 1000 });
  return { session: id, user_code: code.userCode, verification_url: code.verificationUrl, expires_at: at + code.expiresIn * 1000, interval: code.interval };
}

export type ConnectPoll =
  | { state: "pending" | "denied" | "expired"; retry_after?: number }
  | { state: "connected"; account: GoogleAccountRow };

export async function pollGoogleConnect(sessionId: string, userId: number): Promise<ConnectPoll | null> {
  const session = sessions.get(sessionId);
  if (!session || session.userId !== userId) return null;
  const at = now();
  if (session.expiresAt <= at) {
    sessions.delete(sessionId);
    return { state: "expired" };
  }
  if (at < session.nextPollAt) return { state: "pending", retry_after: Math.ceil((session.nextPollAt - at) / 1000) };
  const client = googleClient();
  if (!client) return { state: "expired" };
  const result = await pollDeviceToken(client, session.deviceCode);
  if (result.state === "slow_down") session.interval = Math.min(60, session.interval + 5);
  session.nextPollAt = now() + session.interval * 1000;
  if (result.state === "pending" || result.state === "slow_down") return { state: "pending", retry_after: session.interval };
  sessions.delete(sessionId);
  if (result.state !== "authorized") return { state: result.state };
  const tokens = tokenSource(client, result.refreshToken);
  const account = await driveAccount({ token: async () => result.accessToken, refresh: tokens.refresh });
  const email = account.email || "Google account";
  const existing = one<{ id: number }>("SELECT id FROM google_drive_accounts WHERE email = ? COLLATE NOCASE", email);
  if (existing) {
    changes("UPDATE google_drive_accounts SET refresh_token = ?, display_name = ? WHERE id = ?", sealSecret(result.refreshToken), account.name, existing.id);
    return { state: "connected", account: findGoogleAccount(existing.id)! };
  }
  const id = run(
    "INSERT INTO google_drive_accounts (email, display_name, refresh_token, created_by, created_at) VALUES (?, ?, ?, ?, ?)",
    email,
    account.name,
    sealSecret(result.refreshToken),
    userId,
    now(),
  );
  return { state: "connected", account: findGoogleAccount(Number(id))! };
}

export function cancelGoogleConnect(sessionId: string, userId: number): void {
  const session = sessions.get(sessionId);
  if (session && session.userId === userId) sessions.delete(sessionId);
}

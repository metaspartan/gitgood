import { all, changes, now, one, run } from "../db/index.ts";

export interface TotpState {
  secret: string | null;
  confirmed_at: number | null;
}

export function getTotpState(userId: number): TotpState {
  const row = one<{ totp_secret: string | null; totp_confirmed_at: number | null }>(
    `SELECT totp_secret, totp_confirmed_at FROM users WHERE id = ?`,
    userId,
  );
  return { secret: row?.totp_secret ?? null, confirmed_at: row?.totp_confirmed_at ?? null };
}

export function setPendingTotpSecret(userId: number, secret: string): void {
  run(
    `UPDATE users SET totp_secret = ?, totp_confirmed_at = NULL, totp_last_step = NULL WHERE id = ?`,
    secret,
    userId,
  );
}

export function confirmTotp(userId: number, lastStep: number): void {
  run(`UPDATE users SET totp_confirmed_at = ?, totp_last_step = ? WHERE id = ?`, now(), lastStep, userId);
}

export function disableTotp(userId: number): void {
  run(
    `UPDATE users SET totp_secret = NULL, totp_confirmed_at = NULL, totp_last_step = NULL WHERE id = ?`,
    userId,
  );
}

export function getTotpLastStep(userId: number): number | null {
  const row = one<{ totp_last_step: number | null }>(`SELECT totp_last_step FROM users WHERE id = ?`, userId);
  return row?.totp_last_step ?? null;
}

export function setTotpLastStep(userId: number, step: number): void {
  run(`UPDATE users SET totp_last_step = ? WHERE id = ?`, step, userId);
}

export function currentTotpStep(unixSeconds: number, periodSeconds = 30): number {
  return Math.floor(unixSeconds / periodSeconds);
}

export function replaceRecoveryCodes(userId: number, hashes: string[]): void {
  run(`DELETE FROM recovery_codes WHERE user_id = ?`, userId);
  for (const hash of hashes) {
    run(`INSERT INTO recovery_codes (user_id, code_hash, created_at) VALUES (?, ?, ?)`, userId, hash, now());
  }
}

export function countRecoveryCodes(userId: number): number {
  return one<{ c: number }>(`SELECT COUNT(*) AS c FROM recovery_codes WHERE user_id = ?`, userId)?.c ?? 0;
}

export function consumeRecoveryCode(userId: number, hash: string): boolean {
  const row = one<{ id: number }>(
    `SELECT id FROM recovery_codes WHERE user_id = ? AND code_hash = ?`,
    userId,
    hash,
  );
  if (!row) return false;
  changes(`DELETE FROM recovery_codes WHERE id = ?`, row.id);
  return true;
}

export function clearRecoveryCodes(userId: number): void {
  run(`DELETE FROM recovery_codes WHERE user_id = ?`, userId);
}

export interface PasskeyRow {
  id: number;
  user_id: number;
  credential_id: string;
  public_key: string;
  sign_count: number;
  label: string;
  created_at: number;
  last_used_at: number | null;
}

export function listPasskeys(userId: number): PasskeyRow[] {
  return all<PasskeyRow>(
    `SELECT id, user_id, credential_id, public_key, sign_count, label, created_at, last_used_at
       FROM passkeys WHERE user_id = ? ORDER BY id`,
    userId,
  );
}

export function findPasskeyByCredentialId(credentialId: string): PasskeyRow | null {
  return one<PasskeyRow>(
    `SELECT id, user_id, credential_id, public_key, sign_count, label, created_at, last_used_at
       FROM passkeys WHERE credential_id = ?`,
    credentialId,
  );
}

export function countPasskeys(userId: number): number {
  return one<{ c: number }>(`SELECT COUNT(*) AS c FROM passkeys WHERE user_id = ?`, userId)?.c ?? 0;
}

export function insertPasskey(input: {
  userId: number;
  credentialId: string;
  publicKey: string;
  signCount: number;
  label: string;
}): number {
  const result = run(
    `INSERT INTO passkeys (user_id, credential_id, public_key, sign_count, label, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    input.userId,
    input.credentialId,
    input.publicKey,
    input.signCount,
    input.label,
    now(),
  );
  return result;
}

export function touchPasskey(id: number, signCount: number): void {
  run(`UPDATE passkeys SET sign_count = ?, last_used_at = ? WHERE id = ?`, signCount, now(), id);
}

export function deletePasskey(userId: number, id: number): boolean {
  return changes(`DELETE FROM passkeys WHERE id = ? AND user_id = ?`, id, userId) > 0;
}

export function storeChallenge(userId: number, challenge: string, kind: string): void {
  run(
    `INSERT OR REPLACE INTO webauthn_challenges (user_id, challenge, kind, created_at)
     VALUES (?, ?, ?, ?)`,
    userId,
    challenge,
    kind,
    now(),
  );
}

export function takeChallenge(userId: number, kind: string): string | null {
  const row = one<{ challenge: string; created_at: number }>(
    `SELECT challenge, created_at FROM webauthn_challenges WHERE user_id = ? AND kind = ?`,
    userId,
    kind,
  );
  if (!row) return null;
  run(`DELETE FROM webauthn_challenges WHERE user_id = ? AND kind = ?`, userId, kind);
  if (now() - row.created_at > 5 * 60 * 1000) return null;
  return row.challenge;
}

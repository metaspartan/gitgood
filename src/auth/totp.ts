import { randomBytes, createHmac, timingSafeEqual, createHash } from "node:crypto";

const DIGITS = 6;
const PERIOD_SECONDS = 30;
const DRIFT_STEPS = 1;
const SECRET_BYTES = 20;

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Encode(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(input: string): Uint8Array {
  const clean = input.toUpperCase().replace(/=+$/, "").replace(/\s/g, "");
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const index = B32.indexOf(ch);
    if (index < 0) throw new Error(`Invalid base32 character: ${ch}`);
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return new Uint8Array(out);
}

export interface TotpEnrollment {
  secret: string;
  uri: string;
  displaySecret: string;
}

export function generateTotpSecret(accountName: string, issuer = "GitGood"): TotpEnrollment {
  const secret = base32Encode(randomBytes(SECRET_BYTES));
  const label = encodeURIComponent(`${issuer}:${accountName}`);
  const params = new URLSearchParams({
    secret,
    issuer,
    algorithm: "SHA1",
    digits: String(DIGITS),
    period: String(PERIOD_SECONDS),
  });
  return {
    secret,
    uri: `otpauth://totp/${label}?${params.toString()}`,
    displaySecret: secret.replace(/(.{4})/g, "$1 ").trim(),
  };
}

export function totpAt(secretBase32: string, unixSeconds: number): string {
  const counter = Math.floor(unixSeconds / PERIOD_SECONDS);
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const key = Buffer.from(base32Decode(secretBase32));
  const digest = createHmac("sha1", key).update(message).digest();
  const offset = (digest[digest.length - 1] as number) & 0x0f;
  const binary =
    (((digest[offset] as number) & 0x7f) << 24) |
    (((digest[offset + 1] as number) & 0xff) << 16) |
    (((digest[offset + 2] as number) & 0xff) << 8) |
    ((digest[offset + 3] as number) & 0xff);
  return String(binary % 10 ** DIGITS).padStart(DIGITS, "0");
}

export function verifyTotp(secretBase32: string, submitted: string, unixSeconds = Math.floor(Date.now() / 1000)): boolean {
  const code = submitted.replace(/\s/g, "");
  if (!/^\d{6}$/.test(code)) return false;
  for (let step = -DRIFT_STEPS; step <= DRIFT_STEPS; step++) {
    const candidate = totpAt(secretBase32, unixSeconds + step * PERIOD_SECONDS);
    const a = Buffer.from(candidate);
    const b = Buffer.from(code);
    if (a.length === b.length && timingSafeEqual(a, b)) return true;
  }
  return false;
}

export function secondsRemaining(unixSeconds = Math.floor(Date.now() / 1000)): number {
  return PERIOD_SECONDS - (unixSeconds % PERIOD_SECONDS);
}

export function isWellFormedCode(input: string): boolean {
  return /^\d{6}$/.test(input.replace(/\s/g, ""));
}

export interface RecoveryCodes {
  plaintext: string[];
  hashes: string[];
}

const RECOVERY_COUNT = 10;

export function generateRecoveryCodes(count = RECOVERY_COUNT): RecoveryCodes {
  const plaintext: string[] = [];
  const hashes: string[] = [];
  for (let i = 0; i < count; i++) {
    const code = randomBytes(5).toString("hex");
    plaintext.push(`${code.slice(0, 5)}-${code.slice(5)}`);
    hashes.push(hashRecoveryCode(code));
  }
  return { plaintext, hashes };
}

export function hashRecoveryCode(code: string): string {
  const normalised = code.toLowerCase().replace(/[^a-f0-9]/g, "");
  return createHash("sha256").update(normalised).digest("hex");
}

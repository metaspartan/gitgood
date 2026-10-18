import { randomBytes, randomUUID } from "node:crypto";

export function randomHex(bytes: number): string {
  return randomBytes(bytes).toString("hex");
}

export function randomId(): string {
  return randomUUID();
}

export function sha256Hex(input: string | Uint8Array): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(input);
  return hasher.digest("hex");
}

export function hmacSha256Hex(secret: string, message: string): string {
  const key = new Bun.CryptoHasher("sha256", secret);
  key.update(message);
  return key.digest("hex");
}

export interface GeneratedToken {
  readonly plaintext: string;
  readonly hash: string;
}

export function generateAccessToken(): GeneratedToken {
  const secret = randomBytes(24).toString("base64url");
  const plaintext = `ggh_${randomBytes(4).toString("hex")}_${secret}`;
  return { plaintext, hash: sha256Hex(plaintext) };
}

export function generateSessionId(): string {
  return randomBytes(32).toString("base64url");
}

export const USERNAME_PATTERN = /^[a-zA-Z0-9](?:[a-zA-Z0-9_-]{0,38})$/;
export const REPO_NAME_PATTERN = /^[a-zA-Z0-9._-]{1,100}$/;
export const GIT_REF_PATTERN = /^(?![-.])(?!.*\.\.)(?!.*@\{)[A-Za-z0-9._/-]{1,255}$/;

export const GIT_REV_PATTERN = /^(?!-)[^\s\u0000-\u001f\u007f]{1,255}$/;
export const SHA_PATTERN = /^[0-9a-f]{7,64}$/;
export const OID_PATTERN = /^[0-9a-f]{64}$/;

export function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

export function hueFor(value: string): number {
  let hash = 0;
  for (let i = 0; i < value.length; i++) {
    hash = (hash * 31 + value.charCodeAt(i)) % 360;
  }
  return hash;
}

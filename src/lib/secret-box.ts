import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "../config.ts";

const VERSION = "v1";
let cachedKey: Buffer | null = null;

function loadKey(): Buffer {
  if (cachedKey) return cachedKey;
  const fromEnv = process.env.GITGOOD_SECRET_KEY;
  if (fromEnv) {
    cachedKey = createHash("sha256").update(fromEnv).digest();
    return cachedKey;
  }
  mkdirSync(config.dataDir, { recursive: true });
  const path = join(config.dataDir, "secret.key");
  if (!existsSync(path)) {
    try {
      writeFileSync(path, `${randomBytes(32).toString("base64")}\n`, { mode: 0o600, flag: "wx" });
    } catch (error) {
      if ((error as { code?: string }).code !== "EEXIST") throw error;
    }
  }
  const key = Buffer.from(readFileSync(path, "utf8").trim(), "base64");
  if (key.length !== 32) throw new Error("The instance secret key is invalid");
  cachedKey = key;
  return key;
}

export function sealSecret(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", loadKey(), iv);
  const body = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return [VERSION, iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), body.toString("base64url")].join(".");
}

export function openSecret(sealed: string): string | null {
  const [version, iv, tag, body] = sealed.split(".");
  if (version !== VERSION || !iv || !tag || body === undefined) return null;
  try {
    const decipher = createDecipheriv("aes-256-gcm", loadKey(), Buffer.from(iv, "base64url"));
    decipher.setAuthTag(Buffer.from(tag, "base64url"));
    return Buffer.concat([decipher.update(Buffer.from(body, "base64url")), decipher.final()]).toString("utf8");
  } catch {
    return null;
  }
}

export function resetSecretKeyCache(): void {
  cachedKey = null;
}

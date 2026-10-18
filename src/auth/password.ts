import { config } from "../config.ts";

const ARGON_OPTIONS = {
  algorithm: "argon2id" as const,
  memoryCost: config.env === "test" ? 4096 : 19456,
  timeCost: config.env === "test" ? 1 : 2,
};

export async function hashPassword(plaintext: string): Promise<string> {
  return Bun.password.hash(plaintext, ARGON_OPTIONS);
}

export async function verifyPassword(plaintext: string, hash: string): Promise<boolean> {
  try {
    return await Bun.password.verify(plaintext, hash);
  } catch {
    return false;
  }
}

export function assertPasswordStrength(password: string): void {
  if (password.length < 8) {
    throw new Error("Password must be at least 8 characters");
  }
  if (password.length > 256) {
    throw new Error("Password must be at most 256 characters");
  }
}

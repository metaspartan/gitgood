import { config } from "../config.ts";
import { all, changes, one, run } from "../db/index.ts";

export function repositoryDefaultQuota(): { bytes: number; source: "admin" | "environment" | "default" } {
  const saved = one<{ value: number }>("SELECT value FROM instance_settings WHERE key = ?", "default_repo_quota_bytes");
  if (saved) return { bytes: saved.value, source: "admin" };
  return { bytes: Math.max(0, config.maxRepoBytes), source: process.env.GITGOOD_MAX_REPO_BYTES ? "environment" : "default" };
}

export function setRepositoryDefaultQuota(bytes: number): void {
  if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > 1024 ** 5) throw new Error("Quota must be between 0 and 1 PiB");
  changes("INSERT INTO instance_settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", "default_repo_quota_bytes", bytes);
}

export interface InstanceSettings {
  allowSignup: boolean;
  allowRepoCreation: boolean;
  defaultVisibility: "public" | "private";
  actionsDefaultEnabled: boolean;
}

const KEYS = {
  allowSignup: "allow_signup",
  allowRepoCreation: "allow_repo_creation",
  defaultVisibility: "default_visibility",
  actionsDefaultEnabled: "actions_default_enabled",
} as const satisfies Record<keyof InstanceSettings, string>;

let cache: InstanceSettings | null = null;

function defaults(): InstanceSettings {
  return {
    allowSignup: config.allowSignup,
    allowRepoCreation: config.allowRepoCreation,
    defaultVisibility: "public",
    actionsDefaultEnabled: true,
  };
}

export function instanceSettings(): InstanceSettings {
  if (cache) return cache;
  const stored = new Map(all<{ key: string; value: number }>("SELECT key, value FROM instance_settings").map((r) => [r.key, Number(r.value)]));
  const base = defaults();
  const bool = (key: string, fallback: boolean) => (stored.has(key) ? stored.get(key) === 1 : fallback);
  cache = {
    allowSignup: bool(KEYS.allowSignup, base.allowSignup),
    allowRepoCreation: bool(KEYS.allowRepoCreation, base.allowRepoCreation),
    defaultVisibility: stored.has(KEYS.defaultVisibility) ? (stored.get(KEYS.defaultVisibility) === 1 ? "private" : "public") : base.defaultVisibility,
    actionsDefaultEnabled: bool(KEYS.actionsDefaultEnabled, base.actionsDefaultEnabled),
  };
  return cache;
}

export function updateInstanceSettings(patch: Partial<InstanceSettings>): InstanceSettings {
  for (const [name, value] of Object.entries(patch) as [keyof InstanceSettings, InstanceSettings[keyof InstanceSettings]][]) {
    if (value === undefined) continue;
    const stored = typeof value === "boolean" ? (value ? 1 : 0) : value === "private" ? 1 : 0;
    run("INSERT INTO instance_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", KEYS[name], stored);
  }
  cache = null;
  return instanceSettings();
}

export function resetInstanceSettingsCache(): void {
  cache = null;
}

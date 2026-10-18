import { config } from "../config.ts";
import * as gitRepo from "../git/repo.ts";
import { cached, invalidatePrefix } from "../lib/cache.ts";
import { repoDiskPath, type RepoRecord } from "./repos.ts";

export type { PushPolicy } from "../git/repo.ts";
import type { PushPolicy } from "../git/repo.ts";

export function defaultPushPolicy(): PushPolicy {
  return {
    denyNonFastForwards: config.denyNonFastForwards,
    denyDeletes: config.denyDeletes,
    fsckObjects: config.fsckObjects,
  };
}

export function policyPath(repo: RepoRecord): string {
  return repoDiskPath(repo);
}

const POLICY_TTL_MS = 5_000;

const policyEpoch = new Map<number, number>();

export async function getPushPolicy(repo: RepoRecord): Promise<PushPolicy> {
  const path = policyPath(repo);
  return cached(`repo:${repo.id}:push-policy`, POLICY_TTL_MS, () =>
    gitRepo.readPushPolicy(path, defaultPushPolicy()),
  );
}

export async function setPushPolicy(repo: RepoRecord, policy: PushPolicy): Promise<PushPolicy> {
  const path = policyPath(repo);
  await gitRepo.writePushPolicy(path, policy);
  invalidatePrefix(`repo:${repo.id}:`);
  policyEpoch.set(repo.id, Date.now());
  return gitRepo.readPushPolicy(path, defaultPushPolicy());
}

export function policyCacheEpoch(repoId: number): number | undefined {
  return policyEpoch.get(repoId);
}

export async function applyDefaultPushPolicy(repo: RepoRecord): Promise<void> {
  await gitRepo.writePushPolicy(policyPath(repo), defaultPushPolicy());
}

export function differsFromDefault(policy: PushPolicy): boolean {
  const defaults = defaultPushPolicy();
  return (
    policy.denyNonFastForwards !== defaults.denyNonFastForwards ||
    policy.denyDeletes !== defaults.denyDeletes ||
    policy.fsckObjects !== defaults.fsckObjects
  );
}

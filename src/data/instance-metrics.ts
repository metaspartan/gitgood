import type { SQLQueryBindings } from "bun:sqlite";
import { scalar } from "../db/index.ts";

export interface InstanceMetrics {
  users: number;
  admins: number;
  sessions: number;
  accessTokens: number;
  sshKeys: number;
  repos: number;
  publicRepos: number;
  archivedRepos: number;
  orgs: number;
  stars: number;
  openIssues: number;
  openPulls: number;
  mergedPulls30d: number;
  releases: number;
  webhooks: number;
  webhookDeliveries24h: number;
  webhookFailures24h: number;
  ciRuns24h: number;
  ciRunning: number;
  ciFailing24h: number;
  lfsObjects: number;
  lfsBytes: number;
  indexedFiles: number;
  notifications: number;
}

const count = (sql: string, ...args: SQLQueryBindings[]): number => Number(scalar<number>(sql, ...args) ?? 0);

export function collectInstanceMetrics(now = Date.now()): InstanceMetrics {
  const day = now - 24 * 60 * 60 * 1000;
  const month = now - 30 * 24 * 60 * 60 * 1000;
  return {
    users: count("SELECT COUNT(*) FROM users"),
    admins: count("SELECT COUNT(*) FROM users WHERE is_admin = 1"),
    sessions: count("SELECT COUNT(*) FROM sessions WHERE expires_at > ?", now),
    accessTokens: count("SELECT COUNT(*) FROM access_tokens"),
    sshKeys: count("SELECT COUNT(*) FROM ssh_keys"),
    repos: count("SELECT COUNT(*) FROM repos"),
    publicRepos: count("SELECT COUNT(*) FROM repos WHERE visibility = 'public'"),
    archivedRepos: count("SELECT COUNT(*) FROM repos WHERE archived = 1"),
    orgs: count("SELECT COUNT(*) FROM orgs"),
    stars: count("SELECT COUNT(*) FROM stars"),
    openIssues: count("SELECT COUNT(*) FROM issues WHERE state = 'open'"),
    openPulls: count("SELECT COUNT(*) FROM pulls WHERE state = 'open'"),
    mergedPulls30d: count("SELECT COUNT(*) FROM pulls WHERE state = 'merged' AND merged_at >= ?", month),
    releases: count("SELECT COUNT(*) FROM releases"),
    webhooks: count("SELECT COUNT(*) FROM webhooks"),
    webhookDeliveries24h: count("SELECT COUNT(*) FROM webhook_deliveries WHERE created_at >= ?", day),
    webhookFailures24h: count("SELECT COUNT(*) FROM webhook_deliveries WHERE created_at >= ? AND status_code >= 400", day),
    ciRuns24h: count("SELECT COUNT(*) FROM ci_runs WHERE started_at >= ?", day),
    ciRunning: count("SELECT COUNT(*) FROM ci_runs WHERE status IN ('queued', 'running')"),
    ciFailing24h: count("SELECT COUNT(*) FROM ci_runs WHERE started_at >= ? AND status = 'failure'", day),
    lfsObjects: count("SELECT COUNT(*) FROM lfs_objects"),
    lfsBytes: count("SELECT COALESCE(SUM(size), 0) FROM lfs_objects"),
    indexedFiles: count("SELECT COUNT(*) FROM code_blobs"),
    notifications: count("SELECT COUNT(*) FROM notifications"),
  };
}

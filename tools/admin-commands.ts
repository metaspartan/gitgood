import { existsSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { all, changes, db, migrate, one, scalar } from "../src/db/index.ts";
import { config } from "../src/config.ts";
import * as gitRepo from "../src/git/repo.ts";
import { formatBytes, runBackup } from "../src/lib/backup.ts";
import { log } from "../src/lib/logger.ts";
import {
  effectiveQuotaBytes,
  findRepo,
  normalizeQuota,
  repoDiskPath,
  selectionForQuotaReport,
  updateRepository,
  type RepoRecord,
} from "../src/data/repos.ts";
import { indexRepository, indexSummary } from "../src/data/code-index.ts";
import {
  defaultPushPolicy,
  differsFromDefault,
  getPushPolicy,
  setPushPolicy,
  type PushPolicy,
} from "../src/data/git-policy.ts";
import { authorizedKeysFile, listAllKeysWithOwners, type SshKeyRow } from "../src/ssh/keys.ts";

interface ParsedArgs {
  command: string;
  flags: Map<string, string | true>;
}

function parseArgs(argv: readonly string[]): ParsedArgs {
  const [command = "help", ...rest] = argv;
  const flags = new Map<string, string | true>();
  for (let i = 0; i < rest.length; i++) {
    const token = rest[i];
    if (token === undefined || !token.startsWith("--")) continue;
    const name = token.slice(2);
    const next = rest[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      flags.set(name, next);
      i += 1;
    } else {
      flags.set(name, true);
    }
  }
  return { command, flags };
}

function flagString(flags: Map<string, string | true>, name: string): string | undefined {
  const value = flags.get(name);
  return typeof value === "string" ? value : undefined;
}

function flagNumber(flags: Map<string, string | true>, name: string, fallback: number): number {
  const raw = flagString(flags, name);
  if (raw === undefined) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function listRepositoryPaths(): Array<{ id: number; full: string; path: string }> {
  return all<RepoRecord>(selectionForQuotaReport()).map((repo) => ({
    id: repo.id,
    full: `${repo.owner_username}/${repo.name}`,
    path: repoDiskPath(repo),
  }));
}

function selectRepositories(flags: Map<string, string | true>): Array<{ id: number; full: string; path: string }> {
  const requested = flagString(flags, "repo");
  const list = listRepositoryPaths();
  if (requested === undefined) return list;
  const match = list.find((entry) => entry.full === requested || entry.full.endsWith(`/${requested}`));
  if (!match) throw new Error(`No such repository: ${requested}`);
  return [match];
}

async function commandBackup(flags: Map<string, string | true>): Promise<number> {
  const out = flagString(flags, "out");
  if (!out) throw new Error("--out DIR is required");
  const manifest = await runBackup({
    outDir: out,
    label: flagString(flags, "label") ?? "manual",
    force: flags.get("force") === true,
  });
  console.log(`backup written to ${resolve(out)}`);
  console.log(`  database      ${formatBytes(manifest.database.bytes)}  sha256 ${manifest.databaseSha256.slice(0, 16)}â€¦`);
  console.log(`  repositories  ${manifest.repositories.count} repos, ${formatBytes(manifest.repositories.bytes)}`);
  console.log(`  lfs           ${manifest.lfs.objects} objects, ${formatBytes(manifest.lfs.bytes)}`);
  return 0;
}

async function commandVerify(flags: Map<string, string | true>): Promise<number> {
  const targets = selectRepositories(flags);
  const full = flags.get("full") === true;
  let failures = 0;
  for (const target of targets) {
    const started = performance.now();
    const ok = await gitRepo.verifyRepository(target.path, { full });
    const elapsed = Math.round(performance.now() - started);
    if (ok) {
      const size = await gitRepo.repoSize(target.path);
      console.log(`  ok    ${target.full.padEnd(40)} ${formatBytes(size.bytes).padStart(10)}  ${elapsed} ms`);
    } else {
      failures += 1;
      console.log(`  FAIL  ${target.full.padEnd(40)} fsck reported problems`);
    }
  }
  console.log(`\n${targets.length - failures}/${targets.length} repositories verified${full ? " (full object check)" : " (connectivity only; pass --full for a deep check)"}`);
  return failures === 0 ? 0 : 1;
}

async function commandGc(flags: Map<string, string | true>): Promise<number> {
  const targets = selectRepositories(flags);
  const aggressive = flags.get("aggressive") === true;
  let reclaimed = 0;
  for (const target of targets) {
    const before = (await gitRepo.repoSize(target.path)).bytes;
    const started = performance.now();
    await gitRepo.runGc(target.path, aggressive);
    const after = (await gitRepo.repoSize(target.path)).bytes;
    const saved = Math.max(0, before - after);
    reclaimed += saved;
    console.log(
      `  ${target.full.padEnd(40)} ${formatBytes(before).padStart(10)} -> ${formatBytes(after).padStart(10)}` +
        `  saved ${formatBytes(saved)}  ${Math.round(performance.now() - started)} ms`,
    );
  }
  console.log(`\nreclaimed ${formatBytes(reclaimed)} across ${targets.length} repositories`);
  return 0;
}

function commandPrune(flags: Map<string, string | true>): number {
  const sessions = flags.get("sessions") === true;
  const tokenDays = flagString(flags, "tokens");
  const backupDir = flagString(flags, "backups");
  const keep = flagNumber(flags, "keep", 7);
  let didSomething = false;

  if (sessions) {
    const removed = changes("DELETE FROM sessions WHERE expires_at < ?", Date.now());
    console.log(`  sessions  expired removed: ${removed}`);
    didSomething = true;
  }

  if (tokenDays !== undefined) {
    const days = Number.parseInt(tokenDays, 10);
    if (!Number.isFinite(days) || days < 1) throw new Error("--tokens expects a number of days");
    const cutoff = Date.now() - days * 86_400_000;
    const removed = changes(
      "DELETE FROM access_tokens WHERE created_at < ? AND (last_used_at IS NULL OR last_used_at < ?)",
      cutoff,
      cutoff,
    );
    console.log(`  tokens    unused for ${days}d removed: ${removed}`);
    didSomething = true;
  }

  if (backupDir !== undefined) {
    const dir = resolve(backupDir);
    if (!existsSync(dir)) throw new Error(`No such backup directory: ${dir}`);
    const entries = readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    const excess = entries.slice(0, Math.max(0, entries.length - keep));
    for (const name of excess) {
      const full = join(dir, name);
      const bytes = directorySize(full);
      rmSync(full, { recursive: true, force: true });
      console.log(`  backups   removed ${name} (${formatBytes(bytes)})`);
    }
    console.log(`  backups   kept the newest ${Math.min(keep, entries.length)} of ${entries.length}`);
    didSomething = true;
  }

  if (!didSomething) {
    console.log("nothing to do; pass --sessions, --tokens DAYS and/or --backups DIR --keep N");
    return 0;
  }
  return 0;
}

function directorySize(dir: string): number {
  let total = 0;
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else total += statSync(full).size;
    }
  };
  walk(dir);
  return total;
}

async function commandQuota(flags: Map<string, string | true>): Promise<number> {
  const targets = selectRepositories(flags).map((target) => ({
    full: target.full,
    repo: requireRepoByFullName(target.full),
  }));

  const setTo = flagString(flags, "set");
  if (setTo !== undefined) {
    if (!flags.get("repo")) throw new Error("--set requires --repo owner/name");
    const bytes = Number.parseInt(setTo, 10);
    if (!Number.isFinite(bytes)) throw new Error("--set expects a byte count (0 means unlimited)");
    for (const target of targets) {
      const updated = updateRepository(target.repo, { quotaBytes: normalizeQuota(bytes) });
      console.log(`  ${target.full.padEnd(40)} quota set to ${formatQuota(updated.quota_bytes)}`);
    }
    return 0;
  }

  const onlyOver = flags.get("over") === true;
  let shown = 0;
  let over = 0;
  for (const target of targets) {
    const path = repoDiskPath(target.repo);
    const size = (await gitRepo.repoSize(path)).bytes;
    const limit = effectiveQuotaBytes(target.repo);
    const isOver = Number.isFinite(limit) && size > limit;
    if (isOver) over += 1;
    if (onlyOver && !isOver) continue;
    shown += 1;
    const percent = Number.isFinite(limit) && limit > 0 ? `${((size / limit) * 100).toFixed(0)}%` : "-";
    console.log(
      `  ${isOver ? "OVER" : "ok  "} ${target.full.padEnd(40)} ` +
        `${formatBytes(size).padStart(10)} / ${formatQuota(target.repo.quota_bytes).padStart(10)}  ${percent.padStart(5)}`,
    );
  }
  if (shown === 0) {
    console.log("  no repositories over their limit");
    return 0;
  }
  console.log(`\n${shown} shown${over > 0 ? `, ${over} over quota` : ""}`);
  return over === 0 ? 0 : 1;
}

function formatQuota(value: number | null): string {
  if (value === null) return "default";
  if (value <= 0) return "unlimited";
  return formatBytes(value);
}

function requireRepoByFullName(full: string): RepoRecord {
  const slash = full.indexOf("/");
  if (slash <= 0) throw new Error(`Expected owner/name, got ${full}`);
  const repo = findRepo(full.slice(0, slash), full.slice(slash + 1));
  if (!repo) throw new Error(`No such repository: ${full}`);
  return repo;
}

function commandSsh(flags: Map<string, string | true>): number {
  const keys = listAllKeysWithOwners();
  const rows: SshKeyRow[] = keys.map((row) => ({
    id: row.id,
    user_id: row.user_id,
    title: row.title,
    fingerprint: row.fingerprint,
    public_key: row.public_key,
    created_at: row.created_at,
  }));
  const generated = authorizedKeysFile(rows, config.sshCommand);

  const check = flagString(flags, "check");
  if (check !== undefined) {
    if (!existsSync(check)) {
      console.error(`  ${check} does not exist`);
      return 1;
    }
    if (readFileSync(check, "utf8") === generated) {
      console.log(`  ${check} matches the database (${rows.length} keys)`);
      return 0;
    }
    console.error(`  ${check} differs from the database; regenerate with:`);
    console.error(`    bun tools/admin.ts ssh --authorized-keys ${check}`);
    return 1;
  }

  const out = flagString(flags, "authorized-keys");
  if (out !== undefined) {
    if (existsSync(out)) renameSync(out, `${out}.bak`);
    writeFileSync(out, generated);
    console.log(`  wrote ${out} (${rows.length} keys, previous kept as ${out}.bak)`);
    return 0;
  }

  console.log(`  ${rows.length} registered keys`);
  for (const row of keys) {
    console.log(`    ${row.username.padEnd(24)} ${row.title.slice(0, 30).padEnd(32)} ${row.fingerprint}`);
  }
  console.log(`\n  sshd command: ${config.sshCommand.trim() || "(unset; see DEPLOYMENT.md)"}`);
  return 0;
}

async function commandIndex(flags: Map<string, string | true>): Promise<number> {
  const targets = selectRepositories(flags);
  for (const target of targets) {
    const repo = requireRepoByFullName(target.full);
    const started = performance.now();
    const result = await indexRepository(repo);
    console.log(
      `  ${target.full.padEnd(40)} ${String(result.files).padStart(6)} files  ` +
        `${formatBytes(result.bytes).padStart(10)}  ${result.skipped} skipped` +
        `${result.truncated === 1 ? "  TRUNCATED" : ""}  ${Math.round(performance.now() - started)} ms`,
    );
  }
  const summary = indexSummary();
  console.log(
    `\n${summary.indexed_repos} repositories indexed, ${summary.indexed_files} files` +
      `${summary.truncated_repos > 0 ? `, ${summary.truncated_repos} truncated by budget` : ""}` +
      `${summary.failed_repos > 0 ? `, ${summary.failed_repos} failed` : ""}`,
  );
  return summary.failed_repos > 0 ? 1 : 0;
}

async function commandPolicy(flags: Map<string, string | true>): Promise<number> {
  const requested = flagString(flags, "repo");

  if (requested === undefined) {
    const rows = all<RepoRecord>(selectionForQuotaReport());
    let shown = 0;
    for (const repo of rows) {
      const policy = await getPushPolicy(repo);
      if (!differsFromDefault(policy)) continue;
      shown += 1;
      console.log(
        `  ${(repo.owner_username + "/" + repo.name).padEnd(44)} ${describePolicy(policy)}`,
      );
    }
    if (shown === 0) {
      console.log("  every repository uses the instance defaults");
    } else {
      console.log(`\n${shown} of ${rows.length} repositories differ from the defaults`);
    }
    console.log(`\n  instance defaults: ${describePolicy(defaultPushPolicy())}`);
    return 0;
  }

  const repo = requireRepoByFullName(requested);

  const updates: Partial<PushPolicy> = {};
  const denyForce = flagString(flags, "deny-non-fast-forwards");
  if (denyForce !== undefined) updates.denyNonFastForwards = parseOnOff(denyForce);
  const denyDeletes = flagString(flags, "deny-deletes");
  if (denyDeletes !== undefined) updates.denyDeletes = parseOnOff(denyDeletes);
  const fsck = flagString(flags, "fsck-objects");
  if (fsck !== undefined) updates.fsckObjects = parseOnOff(fsck);

  if (Object.keys(updates).length > 0) {
    const current = await getPushPolicy(repo);
    const applied = await setPushPolicy(repo, { ...current, ...updates });
    console.log(`  ${requested.padEnd(44)} ${describePolicy(applied)}`);
    console.log(`\n  read back from ${repoDiskPath(repo)}/config`);
    return 0;
  }

  const policy = await getPushPolicy(repo);
  console.log(`  ${requested}`);
  console.log(`    deny-non-fast-forwards  ${policy.denyNonFastForwards ? "on" : "off"}`);
  console.log(`    deny-deletes            ${policy.denyDeletes ? "on" : "off"}`);
  console.log(`    fsck-objects            ${policy.fsckObjects ? "on" : "off"}`);
  console.log(`    differs from defaults   ${differsFromDefault(policy) ? "yes" : "no"}`);
  return 0;
}

function parseOnOff(value: string): boolean {
  const v = value.trim().toLowerCase();
  if (["on", "true", "yes", "1"].includes(v)) return true;
  if (["off", "false", "no", "0"].includes(v)) return false;
  throw new Error(`expected on or off, got "${value}"`);
}

function describePolicy(policy: PushPolicy): string {
  const parts = [
    `deny-force-push=${policy.denyNonFastForwards ? "on" : "off"}`,
    `deny-deletes=${policy.denyDeletes ? "on" : "off"}`,
    `fsck=${policy.fsckObjects ? "on" : "off"}`,
  ];
  return parts.join("  ");
}

function commandStatus(): number {  const users = scalar<number>("SELECT COUNT(*) FROM users") ?? 0;
  const repos = scalar<number>("SELECT COUNT(*) FROM repos") ?? 0;
  const issues = scalar<number>("SELECT COUNT(*) FROM issues") ?? 0;
  const pulls = scalar<number>("SELECT COUNT(*) FROM pulls") ?? 0;
  const lfs = one<{ c: number; bytes: number }>(
    "SELECT COUNT(*) AS c, COALESCE(SUM(size), 0) AS bytes FROM lfs_objects",
  );
  const sessions = scalar<number>("SELECT COUNT(*) FROM sessions") ?? 0;
  const expired = scalar<number>("SELECT COUNT(*) FROM sessions WHERE expires_at < ?", Date.now()) ?? 0;
  const pageSize = one<{ page_size: number }>("PRAGMA page_size");
  const pageCount = one<{ page_count: number }>("PRAGMA page_count");
  const journalMode = one<{ journal_mode: string }>("PRAGMA journal_mode");
  const integrity = one<{ integrity_check: string }>("PRAGMA integrity_check");

  const dbBytes = (pageSize?.page_size ?? 0) * (pageCount?.page_count ?? 0);
  const repoBytes = directorySize(config.repoRoot);
  const lfsBytes = directorySize(config.lfsRoot);

  console.log(`GitGood ${"1.0.0"} on Bun ${Bun.version}`);
  console.log(`  data dir        ${resolve(config.dataDir)}`);
  console.log(`  database        ${formatBytes(dbBytes)}  journal=${journalMode?.journal_mode ?? "?"}  integrity=${integrity?.integrity_check ?? "?"}`);
  console.log(`  repositories    ${repos} repos, ${formatBytes(repoBytes)}`);
  console.log(`  lfs             ${lfs?.c ?? 0} objects, ${formatBytes(lfsBytes)}`);
  console.log(`  users           ${users}`);
  console.log(`  issues / pulls  ${issues} / ${pulls}`);
  console.log(`  sessions        ${sessions} (${expired} expired)`);
  console.log(`  db path         ${resolve(config.dbPath)}`);
  return 0;
}

function usage(): void {
  const text = readFileSync(new URL(import.meta.url), "utf8");
  const header = text.slice(0, text.indexOf("*/") + 2);
  console.log(header.replace(/^\/\*\*|\s*\*\/$/g, "").replace(/^ ?\*?/gm, "").trim());
}

async function main(): Promise<number> {
  migrate();
  const { command, flags } = parseArgs(Bun.argv.slice(2));
  switch (command) {
    case "backup":
      return commandBackup(flags);
    case "verify":
      return commandVerify(flags);
    case "gc":
      return commandGc(flags);
    case "prune":
      return commandPrune(flags);
    case "quota":
      return commandQuota(flags);
    case "ssh":
      return commandSsh(flags);
    case "index":
      return commandIndex(flags);
    case "policy":
      return commandPolicy(flags);
    case "status":
      return commandStatus();
    case "help":
    case "--help":
    case "-h":
      usage();
      return 0;
    default:
      console.error(`Unknown command: ${command}\n`);
      usage();
      return 2;
  }
}

try {
  const code = await main();
  db.close();
  process.exit(code);
} catch (error) {
  log.error("admin command failed", { reason: error instanceof Error ? error.message : String(error) });
  console.error(`\n${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}

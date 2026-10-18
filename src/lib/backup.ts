import { Database } from "bun:sqlite";
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { config } from "../config.ts";

export const BACKUP_FORMAT = 1;

export interface BackupManifest {
  format: number;
  label: string;
  createdAt: string;
  appVersion: string;
  bun: string;
  database: { file: string; bytes: number };
  repositories: { count: number; bytes: number };
  lfs: { objects: number; files: number; bytes: number };
  databaseSha256: string;
}

export interface BackupOptions {
  outDir: string;
  label?: string;
  force?: boolean;
}

function directoryStats(dir: string): { files: number; bytes: number } {
  if (!existsSync(dir)) return { files: 0, bytes: 0 };
  let files = 0;
  let bytes = 0;
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else {
        files += 1;
        bytes += statSync(full).size;
      }
    }
  };
  walk(dir);
  return { files, bytes };
}

function countEntries(dir: string): number {
  if (!existsSync(dir)) return 0;
  return readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isDirectory()).length;
}

export function snapshotDatabase(sourcePath: string, targetPath: string): void {
  const db = new Database(sourcePath);
  try {
    if (existsSync(targetPath)) rmSync(targetPath, { force: true });
    db.run(`VACUUM INTO '${targetPath.replaceAll("'", "''")}'`);
  } finally {
    db.close();
  }
}

export async function runBackup(options: BackupOptions): Promise<BackupManifest> {
  const outDir = resolve(options.outDir);
  if (existsSync(outDir) && !options.force) {
    const listing = readdirSync(outDir);
    if (listing.length > 0) {
      throw new Error(`${outDir} exists and is not empty; pass --force to overwrite`);
    }
  }
  mkdirSync(outDir, { recursive: true });

  const dbTarget = join(outDir, "gitgood.db");
  snapshotDatabase(config.dbPath, dbTarget);
  const dbBytes = statSync(dbTarget).size;
  const dbDigest = new Bun.CryptoHasher("sha256")
    .update(new Uint8Array(readFileSync(dbTarget)))
    .digest("hex");

  const repoSource = resolve(config.repoRoot);
  const repoTarget = join(outDir, "repositories");
  if (existsSync(repoSource)) cpSync(repoSource, repoTarget, { recursive: true });
  else mkdirSync(repoTarget, { recursive: true });

  const lfsSource = resolve(config.lfsRoot);
  const lfsTarget = join(outDir, "lfs");
  if (existsSync(lfsSource)) cpSync(lfsSource, lfsTarget, { recursive: true });
  else mkdirSync(lfsTarget, { recursive: true });

  const repoStats = directoryStats(repoTarget);
  const lfsStats = directoryStats(lfsTarget);

  const manifest: BackupManifest = {
    format: BACKUP_FORMAT,
    label: options.label ?? "manual",
    createdAt: new Date().toISOString(),
    appVersion: "1.0.0",
    bun: Bun.version,
    database: { file: "gitgood.db", bytes: dbBytes },
    repositories: { count: countEntries(repoTarget), bytes: repoStats.bytes },
    lfs: { objects: countEntries(join(lfsTarget, "objects")), files: lfsStats.files, bytes: lfsStats.bytes },
    databaseSha256: dbDigest,
  };
  writeFileSync(join(outDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

export interface RestoreOptions {
  from: string;
  force?: boolean;
  dryRun?: boolean;
}

export interface RestorePlan {
  manifest: BackupManifest;
  targets: { database: string; repositories: string; lfs: string };
  warnings: string[];
}

export function planRestore(options: RestoreOptions): RestorePlan {
  const from = resolve(options.from);
  const manifestPath = join(from, "manifest.json");
  if (!existsSync(manifestPath)) throw new Error(`No manifest.json in ${from}`);

  let manifest: BackupManifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as BackupManifest;
  } catch (error) {
    throw new Error(`manifest.json is not valid JSON: ${error instanceof Error ? error.message : "unknown"}`);
  }

  if (manifest.format !== BACKUP_FORMAT) {
    throw new Error(
      `Backup format ${manifest.format} is not supported by this build (expected ${BACKUP_FORMAT})`,
    );
  }

  const warnings: string[] = [];
  const dbPath = join(from, manifest.database.file);
  if (!existsSync(dbPath)) throw new Error(`Backup is missing ${manifest.database.file}`);

  const actualBytes = statSync(dbPath).size;
  if (actualBytes !== manifest.database.bytes) {
    warnings.push(`database size differs from the manifest (${actualBytes} vs ${manifest.database.bytes})`);
  }
  const digest = new Bun.CryptoHasher("sha256")
    .update(new Uint8Array(readFileSync(dbPath)))
    .digest("hex");
  if (digest !== manifest.databaseSha256) {
    throw new Error("Database digest does not match the manifest; the backup is corrupt");
  }

  if (existsSync(config.dbPath) && !options.force) {
    warnings.push(`${config.dbPath} exists and will be replaced (pass --force to proceed)`);
  }

  return {
    manifest,
    targets: {
      database: resolve(config.dbPath),
      repositories: resolve(config.repoRoot),
      lfs: resolve(config.lfsRoot),
    },
    warnings,
  };
}

export interface RestoreResult {
  manifest: BackupManifest;
  restored: { database: boolean; repositories: boolean; lfs: boolean };
  previousState: string | null;
  sidecarsPending: string[];
}

export function runRestore(options: RestoreOptions): RestoreResult {
  const plan = planRestore(options);
  if (options.dryRun) {
    return {
      manifest: plan.manifest,
      restored: { database: false, repositories: false, lfs: false },
      previousState: null,
      sidecarsPending: [],
    };
  }
  if (plan.warnings.some((warning) => warning.includes("--force")) && !options.force) {
    throw new Error(`Refusing to overwrite live state without --force:\n  ${plan.warnings.join("\n  ")}`);
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const aside = `${plan.targets.repositories}.replaced-${stamp}`;
  let previousState: string | null = null;

  const from = resolve(options.from);
  const saved: Array<[string, string]> = [];
  const sidecarsPending: string[] = [];

  const replace = (source: string, target: string, kind: "file" | "tree"): boolean => {
    if (!existsSync(source)) return false;

    if (existsSync(target)) {
      const backupPath = previousState === null ? aside : `${aside}-${basenameOf(target)}`;
      rmSync(backupPath, { recursive: true, force: true });
      cpSync(target, backupPath, { recursive: true });
      if (previousState === null) previousState = backupPath;
    } else {
      mkdirSync(dirnameOf(target), { recursive: true });
    }

    if (kind === "file") {
      try {
        copyFileSync(source, target);
      } catch (cause) {
        const detail = cause instanceof Error ? cause.message : String(cause);
        throw new Error(
          `Restoring the database failed while copying it (${detail}), which usually means another ` +
            `process has it open. Stop the GitGood server and run the restore again; the ` +
            `previous state is preserved at ${previousState ?? "(not moved)"}.`,
        );
      }
      const written = statSync(target).size;
      const expected = statSync(source).size;
      if (written !== expected) {
        throw new Error(
          `Restoring the database wrote ${written} of ${expected} bytes, which means another ` +
            `process has it open. Stop the GitGood server and run the restore again; the ` +
            `previous state is preserved at ${previousState ?? "(not moved)"}.`,
        );
      }
      for (const sidecar of [`${target}-wal`, `${target}-shm`]) {
        if (!existsSync(sidecar)) continue;
        try {
          rmSync(sidecar, { force: true });
        } catch {
          sidecarsPending.push(sidecar);
        }
      }
    }
    else cpSync(source, target, { recursive: true, force: true });

    saved.push([source, target]);
    return true;
  };
  const repositories = replace(join(from, "repositories"), plan.targets.repositories, "tree");
  const lfs = replace(join(from, "lfs"), plan.targets.lfs, "tree");
  const database = replace(join(from, plan.manifest.database.file), plan.targets.database, "file");

  return { manifest: plan.manifest, restored: { database, repositories, lfs }, previousState, sidecarsPending };
}

function basenameOf(p: string): string {
  const parts = p.replaceAll("\\", "/").split("/");
  return parts[parts.length - 1] ?? "state";
}

function dirnameOf(p: string): string {
  const normalized = p.replaceAll("\\", "/");
  return normalized.slice(0, normalized.lastIndexOf("/")) || ".";
}

export { formatBytes } from "./format.ts";

import { cpSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, statfsSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { config } from "../src/config.ts";
import { runBackup } from "../src/lib/backup.ts";
import { parseBackupDestinations, validateBackupDestination, type BackupDestination } from "../src/lib/backup-destinations.ts";
import {
  deleteDriveFile,
  driveAccount,
  driveFileIdFromUrl,
  driveFileUrl,
  ensureFolder,
  GoogleError,
  tokenSource,
  uploadStream,
  type TokenSource,
} from "../src/lib/google-drive.ts";

const JOB_ID = /^backup-[0-9a-f-]{36}$/;

class SafeError extends Error {}

function safeMessage(error: unknown): string {
  if (error instanceof SafeError || error instanceof GoogleError) return error.message;
  const code = (error as { code?: string } | null)?.code;
  if (code === "ENOSPC") return "No space left on the destination";
  if (code === "EACCES" || code === "EPERM") return "Permission denied writing to the destination";
  if (code === "ENOENT") return "A required path does not exist on the server";
  if (code === "EROFS") return "The destination is read-only";
  return "Backup failed; see the server log for details";
}

function destinationFor(id: string): BackupDestination {
  const inline = process.env.GITGOOD_BACKUP_JOB_DESTINATION;
  if (inline) {
    const destination = validateBackupDestination(JSON.parse(inline));
    if (destination.id !== id) throw new SafeError("Destination mismatch");
    return destination;
  }
  const destination = parseBackupDestinations(process.env.GITGOOD_BACKUP_DESTINATIONS).find((d) => d.id === id);
  if (!destination) throw new SafeError("Unknown destination");
  return destination;
}

function isRemote(destination: BackupDestination): boolean {
  return destination.kind === "google-drive" || destination.kind === "rclone";
}

function localRootFor(destination: BackupDestination): string {
  const stagingRoot = resolve(process.env.GITGOOD_BACKUP_STAGING ?? "./backups");
  const requestedRoot = isRemote(destination) ? stagingRoot : resolve(destination.target);
  if (destination.kind === "nas" && !existsSync(requestedRoot)) throw new SafeError("The NAS mount does not exist on the server");
  mkdirSync(requestedRoot, { recursive: true });
  const localRoot = realpathSync(requestedRoot);
  for (const source of [config.dataDir, config.repoRoot, config.lfsRoot]) {
    const rel = relative(existsSync(source) ? realpathSync(source) : resolve(source), localRoot);
    if (!rel || (rel !== ".." && !rel.startsWith("../") && !rel.startsWith("..\\") && !isAbsolute(rel))) {
      throw new SafeError("The destination must be outside GitGood's own data directories");
    }
  }
  return localRoot;
}

function googleTokens(): TokenSource {
  const raw = process.env.GITGOOD_BACKUP_GOOGLE;
  if (!raw) throw new SafeError("The Google account for this destination is not connected");
  const parsed = JSON.parse(raw) as { client_id: string; client_secret: string; refresh_token: string };
  return tokenSource({ clientId: parsed.client_id, clientSecret: parsed.client_secret }, parsed.refresh_token);
}

async function rclone(args: string[], timeoutMs: number): Promise<number> {
  const proc = Bun.spawn([process.env.GITGOOD_RCLONE_BIN ?? "rclone", ...args], { stdout: "ignore", stderr: "ignore" });
  const timer = setTimeout(() => proc.kill("SIGKILL"), timeoutMs);
  return proc.exited.finally(() => clearTimeout(timer));
}

function remotePath(destination: BackupDestination, id: string): string {
  return `${destination.target.replace(/\/$/, "")}/${id}`;
}

function freeBytes(path: string): number {
  const stats = statfsSync(path);
  return Number(stats.bavail) * Number(stats.bsize);
}

async function test(destination: BackupDestination): Promise<{ ok: boolean; message: string; free_bytes: number | null }> {
  const localRoot = localRootFor(destination);
  const probe = join(localRoot, `.gitgood-probe-${process.pid}`);
  writeFileSync(probe, "ok");
  unlinkSync(probe);
  if (destination.kind === "google-drive") {
    const tokens = googleTokens();
    const account = await driveAccount(tokens);
    await ensureFolder(tokens, destination.target);
    return { ok: true, message: `Connected to Google Drive as ${account.email}. The “${destination.target}” folder is ready.`, free_bytes: account.freeBytes };
  }
  if (destination.kind === "rclone") {
    const code = await rclone(["lsf", destination.target, "--max-depth", "1", "--contimeout", "15s", "--timeout", "30s"], 60_000).catch(() => -1);
    if (code !== 0) return { ok: false, message: "Local staging is writable, but rclone could not reach the remote. Check the remote name and its authorisation.", free_bytes: freeBytes(localRoot) };
    return { ok: true, message: "Staging is writable and the rclone remote is reachable.", free_bytes: freeBytes(localRoot) };
  }
  return { ok: true, message: "The destination is writable.", free_bytes: freeBytes(localRoot) };
}

async function snapshot(outDir: string): Promise<number> {
  mkdirSync(dirname(outDir), { recursive: true });
  await runBackup({ outDir });
  const releases = join(config.dataDir, "releases");
  if (existsSync(releases)) cpSync(releases, join(outDir, "releases"), { recursive: true });
  const manifestPath = join(outDir, "manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  manifest.releaseAssetsIncluded = true;
  manifest.consistency = "SQLite snapshot with sequential file copies; quiesce writes for a cross-store consistent recovery point";
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
  return Number(manifest.database?.bytes ?? 0) + Number(manifest.repositories?.bytes ?? 0) + Number(manifest.lfs?.bytes ?? 0);
}

export function archiveName(jobId: string, at = new Date()): string {
  return `gitgood-backup-${at.toISOString().slice(0, 19).replace(/[:T]/g, "-")}-${jobId.slice(7, 15)}.tar`;
}

async function uploadToDrive(destination: BackupDestination, outDir: string, jobId: string): Promise<{ bytes: number; location: string }> {
  const tokens = googleTokens();
  const folderId = await ensureFolder(tokens, destination.target);
  const tar = Bun.spawn(["tar", "-cf", "-", "-C", outDir, "."], { stdout: "pipe", stderr: "pipe" });
  const stderr = new Response(tar.stderr).text();
  let uploaded;
  try {
    uploaded = await uploadStream(tokens, folderId, archiveName(jobId), tar.stdout as ReadableStream<Uint8Array>, {
      chunkBytes: Number(process.env.GITGOOD_GOOGLE_CHUNK_BYTES) || undefined,
    });
  } catch (error) {
    tar.kill();
    throw error;
  }
  if ((await tar.exited) !== 0) {
    process.stderr.write(`tar: ${(await stderr).slice(0, 2000)}\n`);
    await deleteDriveFile(tokens, uploaded.id).catch(() => false);
    throw new SafeError("Could not package the backup for upload");
  }
  return { bytes: uploaded.size, location: driveFileUrl(uploaded.id) };
}

async function prune(destination: BackupDestination, localRoot: string, jobId: string): Promise<string[]> {
  const pruned: string[] = [];
  const candidates: unknown = JSON.parse(process.env.GITGOOD_BACKUP_PRUNE ?? "[]");
  const tokens = destination.kind === "google-drive" ? googleTokens() : null;
  for (const entry of Array.isArray(candidates) ? candidates : []) {
    const id = typeof entry === "string" ? entry : (entry as { id?: unknown })?.id;
    const location = typeof entry === "object" && entry ? (entry as { location?: unknown }).location : null;
    if (typeof id !== "string" || !JOB_ID.test(id) || id === jobId) continue;
    if (destination.kind === "google-drive") {
      const fileId = driveFileIdFromUrl(typeof location === "string" ? location : null);
      if (!fileId) continue;
      const removed = await deleteDriveFile(tokens!, fileId).catch(() => false);
      if (removed) pruned.push(id);
      continue;
    }
    const dir = join(localRoot, id);
    if (existsSync(join(dir, "manifest.json"))) rmSync(dir, { recursive: true, force: true });
    if (destination.kind === "rclone") {
      const code = await rclone(["purge", remotePath(destination, id), "--contimeout", "15s", "--timeout", "2m"], 10 * 60 * 1000).catch(() => -1);
      if (code !== 0) continue;
    }
    pruned.push(id);
  }
  return pruned;
}

async function backup(destination: BackupDestination, jobId: string): Promise<{ bytes: number; location: string; pruned: string[] }> {
  const localRoot = localRootFor(destination);
  const outDir = join(localRoot, jobId);
  if (existsSync(outDir)) throw new SafeError("A backup with this ID already exists");
  let bytes = await snapshot(outDir).catch((error) => {
    if (destination.kind === "google-drive") rmSync(outDir, { recursive: true, force: true });
    throw error;
  });
  let location = outDir;
  if (destination.kind === "google-drive") {
    try {
      const uploaded = await uploadToDrive(destination, outDir, jobId);
      bytes = uploaded.bytes;
      location = uploaded.location;
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  } else if (destination.kind === "rclone") {
    location = remotePath(destination, jobId);
    for (const command of ["copy", "check"]) {
      const code = await rclone([command, outDir, location, "--retries", "2", "--contimeout", "15s", "--timeout", "2m"], 60 * 60 * 1000);
      if (code !== 0) throw new SafeError("Remote transfer or verification failed; the local staging copy was kept");
    }
  }
  return { bytes, location, pruned: await prune(destination, localRoot, jobId) };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args[0] === "--test") {
    const destination = destinationFor(args[1] ?? "");
    process.stdout.write(JSON.stringify(await test(destination)) + "\n");
    return;
  }
  const [destinationId, jobId] = args;
  if (!jobId || !JOB_ID.test(jobId)) throw new SafeError("Invalid backup job ID");
  const destination = destinationFor(destinationId ?? "");
  process.stdout.write(JSON.stringify(await backup(destination, jobId)) + "\n");
}

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    process.stderr.write(`GITGOOD_ERROR:${safeMessage(error)}\n`);
    if (!(error instanceof SafeError) && !(error instanceof GoogleError)) process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exit(1);
  }
}

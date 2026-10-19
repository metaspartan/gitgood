import { log } from "../lib/logger.ts";
import {
  activeJob,
  failInterruptedJobs,
  isDue,
  jobScriptPath,
  listDestinations,
  markPruned,
  markScheduled,
  pruneCandidates,
  recordJobEnd,
  recordJobStart,
  type BackupTrigger,
  type StoredDestination,
} from "./backups.ts";
import { googleClient, googleRefreshToken } from "./google-drive.ts";

const OUTPUT_LIMIT = 64 * 1024;
const TEST_TIMEOUT_MS = 90_000;
const SCHEDULER_INTERVAL_MS = 60_000;
let running = false;
let schedulerTimer: ReturnType<typeof setInterval> | null = null;

class SetupError extends Error {}

function childEnv(destination: StoredDestination, extra: Record<string, string> = {}): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {
    ...process.env,
    GITGOOD_BACKUP_JOB_DESTINATION: JSON.stringify({ id: destination.id, name: destination.name, kind: destination.kind, target: destination.target, account_id: destination.account_id ?? null }),
    ...extra,
  };
  delete env.GITGOOD_BACKUP_GOOGLE;
  if (destination.kind === "google-drive") {
    const client = googleClient();
    if (!client) throw new SetupError("Set up the Google OAuth client in Admin → Backups first");
    const refreshToken = googleRefreshToken(destination.account_id ?? -1);
    if (!refreshToken) throw new SetupError("The Google account for this destination is not connected; reconnect it in Admin → Backups");
    env.GITGOOD_BACKUP_GOOGLE = JSON.stringify({ client_id: client.clientId, client_secret: client.clientSecret, refresh_token: refreshToken });
  }
  return env;
}

async function readBounded(stream: ReadableStream<Uint8Array> | null | undefined): Promise<string> {
  if (!stream) return "";
  const text = await new Response(stream).text();
  return text.length > OUTPUT_LIMIT ? text.slice(0, OUTPUT_LIMIT) : text;
}

export function parseWorkerError(stderr: string): string {
  const line = stderr.split("\n").find((entry) => entry.startsWith("GITGOOD_ERROR:"));
  return line ? line.slice("GITGOOD_ERROR:".length).trim().slice(0, 300) : "Backup failed; see the server log for details";
}

export function isBackupRunning(): boolean {
  return running || activeJob() !== null;
}

export function startBackupJob(destination: StoredDestination, trigger: BackupTrigger): { id: string } {
  if (isBackupRunning()) throw new Error("A backup is already running");
  running = true;
  const id = `backup-${crypto.randomUUID()}`;
  recordJobStart({ id, destination_id: destination.id, destination_name: destination.name, trigger });
  const prune = pruneCandidates(destination.id, destination.keep);
  void (async () => {
    try {
      let env: Record<string, string | undefined>;
      try {
        env = childEnv(destination, { GITGOOD_BACKUP_PRUNE: JSON.stringify(prune) });
      } catch (error) {
        recordJobEnd(id, { state: "failed", error: error instanceof SetupError ? error.message : "Backup failed; see the server log for details" });
        return;
      }
      const child = Bun.spawn([process.execPath, jobScriptPath(), destination.id, id], {
        env,
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, stderr, code] = await Promise.all([readBounded(child.stdout), readBounded(child.stderr), child.exited]);
      if (code === 0) {
        const result = JSON.parse(stdout.trim().split("\n").pop() ?? "{}") as { bytes?: number; location?: string; pruned?: string[] };
        recordJobEnd(id, { state: "completed", bytes: result.bytes ?? null, location: result.location ?? null });
        markPruned(result.pruned ?? []);
        log.info("backup completed", { id, destination: destination.id, trigger, pruned: result.pruned?.length ?? 0 });
      } else {
        recordJobEnd(id, { state: "failed", error: parseWorkerError(stderr) });
        log.warn("backup failed", { id, destination: destination.id, detail: stderr.slice(0, 4000) });
      }
    } catch (error) {
      recordJobEnd(id, { state: "failed", error: "Backup failed; see the server log for details" });
      log.warn("backup could not start", { id, error: error instanceof Error ? error.message : String(error) });
    } finally {
      running = false;
    }
  })();
  return { id };
}

export async function testDestination(destination: StoredDestination): Promise<{ ok: boolean; message: string; free_bytes: number | null }> {
  let env: Record<string, string | undefined>;
  try {
    env = childEnv(destination);
  } catch (error) {
    if (error instanceof SetupError) return { ok: false, message: error.message, free_bytes: null };
    throw error;
  }
  const child = Bun.spawn([process.execPath, jobScriptPath(), "--test", destination.id], { env, stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => child.kill("SIGKILL"), TEST_TIMEOUT_MS);
  try {
    const [stdout, stderr, code] = await Promise.all([readBounded(child.stdout), readBounded(child.stderr), child.exited]);
    if (code !== 0) return { ok: false, message: parseWorkerError(stderr), free_bytes: null };
    return JSON.parse(stdout.trim().split("\n").pop() ?? "{}");
  } finally {
    clearTimeout(timer);
  }
}

export function runDueBackups(at = Date.now()): string | null {
  if (isBackupRunning()) return null;
  const due = listDestinations().find((destination) => isDue(destination, at));
  if (!due) return null;
  markScheduled(due, at);
  return startBackupJob(due, "scheduled").id;
}

export function startBackupScheduler(): void {
  if (schedulerTimer) return;
  const interrupted = failInterruptedJobs();
  if (interrupted > 0) log.warn("backups interrupted by restart were marked failed", { count: interrupted });
  schedulerTimer = setInterval(() => {
    try {
      runDueBackups();
    } catch (error) {
      log.warn("backup scheduler tick failed", { error: error instanceof Error ? error.message : String(error) });
    }
  }, SCHEDULER_INTERVAL_MS);
  (schedulerTimer as { unref?: () => void }).unref?.();
}

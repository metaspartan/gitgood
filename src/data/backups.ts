import { join } from "node:path";
import { all, changes, now, one, run } from "../db/index.ts";
import { log } from "../lib/logger.ts";
import {
  BACKUP_ID_PATTERN,
  MAX_BACKUP_DESTINATIONS,
  parseBackupDestinations,
  validateBackupDestination,
  type BackupDestination,
} from "../lib/backup-destinations.ts";

export type BackupSchedule = "manual" | "daily" | "weekly";
export type BackupTrigger = "manual" | "scheduled";
export type BackupState = "running" | "completed" | "failed";

export interface StoredDestination extends BackupDestination {
  source: "admin" | "environment";
  schedule: BackupSchedule;
  hour: number;
  weekday: number;
  keep: number;
  last_scheduled_at: number | null;
}

export interface BackupJobRow {
  id: string;
  destination_id: string;
  destination_name: string;
  trigger: BackupTrigger;
  state: BackupState;
  started_at: number;
  finished_at: number | null;
  bytes: number | null;
  error: string | null;
  location: string | null;
  pruned: number;
}

export interface ScheduleInput {
  schedule: BackupSchedule;
  hour: number;
  weekday: number;
  keep: number;
}

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
const JOB_HISTORY = 200;

export function environmentDestinations(): BackupDestination[] {
  try {
    return parseBackupDestinations(process.env.GITGOOD_BACKUP_DESTINATIONS);
  } catch (error) {
    log.warn("GITGOOD_BACKUP_DESTINATIONS is invalid", { error: error instanceof Error ? error.message : String(error) });
    return [];
  }
}

export function validateSchedule(input: ScheduleInput): ScheduleInput {
  if (!["manual", "daily", "weekly"].includes(input.schedule)) throw new Error("Unknown schedule");
  if (!Number.isInteger(input.hour) || input.hour < 0 || input.hour > 23) throw new Error("Hour must be between 0 and 23");
  if (!Number.isInteger(input.weekday) || input.weekday < 0 || input.weekday > 6) throw new Error("Weekday must be between 0 and 6");
  if (!Number.isInteger(input.keep) || input.keep < 0 || input.keep > 365) throw new Error("Keep between 0 (all) and 365 backups");
  return input;
}

export function listDestinations(): StoredDestination[] {
  const schedules = new Map(
    all<ScheduleInput & { id: string; last_scheduled_at: number | null }>("SELECT * FROM backup_env_schedules").map((row) => [row.id, row]),
  );
  const fromEnv = environmentDestinations().map((destination): StoredDestination => {
    const stored = schedules.get(destination.id);
    return {
      ...destination,
      source: "environment",
      schedule: stored?.schedule ?? "manual",
      hour: stored?.hour ?? 3,
      weekday: stored?.weekday ?? 0,
      keep: stored?.keep ?? 7,
      last_scheduled_at: stored?.last_scheduled_at ?? null,
    };
  });
  const envIds = new Set(fromEnv.map((destination) => destination.id));
  const stored = all<Omit<StoredDestination, "source">>(
    "SELECT id, name, kind, target, schedule, hour, weekday, keep, last_scheduled_at FROM backup_destinations ORDER BY created_at",
  )
    .filter((row) => !envIds.has(row.id))
    .map((row): StoredDestination => ({ ...row, source: "admin" }));
  return [...fromEnv, ...stored];
}

export function findDestination(id: string): StoredDestination | null {
  return listDestinations().find((destination) => destination.id === id) ?? null;
}

export function createDestination(input: BackupDestination & ScheduleInput): StoredDestination {
  const destination = validateBackupDestination(input);
  const schedule = validateSchedule(input);
  const existing = listDestinations();
  if (existing.some((row) => row.id === destination.id)) throw new Error("A destination with that ID already exists");
  if (existing.length >= MAX_BACKUP_DESTINATIONS) throw new Error(`You can configure up to ${MAX_BACKUP_DESTINATIONS} destinations`);
  const timestamp = now();
  run(
    `INSERT INTO backup_destinations (id, name, kind, target, schedule, hour, weekday, keep, last_scheduled_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    destination.id, destination.name, destination.kind, destination.target,
    schedule.schedule, schedule.hour, schedule.weekday, schedule.keep, timestamp, timestamp, timestamp,
  );
  return findDestination(destination.id)!;
}

export function updateDestination(id: string, patch: Partial<Omit<BackupDestination, "id"> & ScheduleInput>): StoredDestination {
  const current = findDestination(id);
  if (!current) throw new Error("Destination not found");
  const schedule = validateSchedule({
    schedule: patch.schedule ?? current.schedule,
    hour: patch.hour ?? current.hour,
    weekday: patch.weekday ?? current.weekday,
    keep: patch.keep ?? current.keep,
  });
  const scheduleChanged = schedule.schedule !== current.schedule || schedule.hour !== current.hour || schedule.weekday !== current.weekday;
  const lastScheduled = scheduleChanged ? now() : current.last_scheduled_at;
  if (current.source === "environment") {
    if (patch.name !== undefined || patch.kind !== undefined || patch.target !== undefined) throw new Error("This destination is managed by the server environment; only its schedule can change here");
    run(
      `INSERT INTO backup_env_schedules (id, schedule, hour, weekday, keep, last_scheduled_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET schedule = excluded.schedule, hour = excluded.hour, weekday = excluded.weekday, keep = excluded.keep, last_scheduled_at = excluded.last_scheduled_at`,
      id, schedule.schedule, schedule.hour, schedule.weekday, schedule.keep, lastScheduled,
    );
    return findDestination(id)!;
  }
  const destination = validateBackupDestination({ id, name: patch.name ?? current.name, kind: patch.kind ?? current.kind, target: patch.target ?? current.target });
  changes(
    `UPDATE backup_destinations SET name = ?, kind = ?, target = ?, schedule = ?, hour = ?, weekday = ?, keep = ?, last_scheduled_at = ?, updated_at = ? WHERE id = ?`,
    destination.name, destination.kind, destination.target, schedule.schedule, schedule.hour, schedule.weekday, schedule.keep, lastScheduled, now(), id,
  );
  return findDestination(id)!;
}

export function deleteDestination(id: string): boolean {
  if (!BACKUP_ID_PATTERN.test(id)) return false;
  return changes("DELETE FROM backup_destinations WHERE id = ?", id) > 0;
}

export function markScheduled(destination: StoredDestination, at: number): void {
  if (destination.source === "environment") {
    run(
      `INSERT INTO backup_env_schedules (id, schedule, hour, weekday, keep, last_scheduled_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET last_scheduled_at = excluded.last_scheduled_at`,
      destination.id, destination.schedule, destination.hour, destination.weekday, destination.keep, at,
    );
  } else {
    changes("UPDATE backup_destinations SET last_scheduled_at = ? WHERE id = ?", at, destination.id);
  }
}

export function latestSlot(schedule: ScheduleInput, at: number): number | null {
  if (schedule.schedule === "manual") return null;
  const day = Math.floor(at / DAY_MS) * DAY_MS;
  let slot = day + schedule.hour * HOUR_MS;
  if (schedule.schedule === "daily") return slot <= at ? slot : slot - DAY_MS;
  const weekday = new Date(day).getUTCDay();
  slot -= ((weekday - schedule.weekday + 7) % 7) * DAY_MS;
  return slot <= at ? slot : slot - 7 * DAY_MS;
}

export function nextSlot(schedule: ScheduleInput, at: number): number | null {
  const latest = latestSlot(schedule, at);
  if (latest === null) return null;
  return latest + (schedule.schedule === "daily" ? DAY_MS : 7 * DAY_MS);
}

export function isDue(destination: Pick<StoredDestination, "schedule" | "hour" | "weekday" | "keep" | "last_scheduled_at">, at: number): boolean {
  const slot = latestSlot(destination, at);
  if (slot === null) return false;
  return (destination.last_scheduled_at ?? 0) < slot;
}

export function recordJobStart(job: Pick<BackupJobRow, "id" | "destination_id" | "destination_name" | "trigger">): void {
  run(
    "INSERT INTO backup_jobs (id, destination_id, destination_name, trigger, state, started_at) VALUES (?, ?, ?, ?, 'running', ?)",
    job.id, job.destination_id, job.destination_name, job.trigger, now(),
  );
  changes("DELETE FROM backup_jobs WHERE id NOT IN (SELECT id FROM backup_jobs ORDER BY started_at DESC LIMIT ?) AND state <> 'running'", JOB_HISTORY);
}

export function recordJobEnd(id: string, result: { state: "completed" | "failed"; bytes?: number | null; error?: string | null; location?: string | null }): void {
  changes(
    "UPDATE backup_jobs SET state = ?, finished_at = ?, bytes = ?, error = ?, location = ? WHERE id = ?",
    result.state, now(), result.bytes ?? null, result.error ?? null, result.location ?? null, id,
  );
}

export function markPruned(ids: readonly string[]): void {
  for (const id of ids) changes("UPDATE backup_jobs SET pruned = 1 WHERE id = ?", id);
}

export function failInterruptedJobs(): number {
  return changes("UPDATE backup_jobs SET state = 'failed', finished_at = ?, error = 'Interrupted by a server restart' WHERE state = 'running'", now());
}

export function listJobs(limit = 50): BackupJobRow[] {
  return all<BackupJobRow>("SELECT * FROM backup_jobs ORDER BY started_at DESC LIMIT ?", limit);
}

export function activeJob(): BackupJobRow | null {
  return one<BackupJobRow>("SELECT * FROM backup_jobs WHERE state = 'running' ORDER BY started_at DESC LIMIT 1");
}

export function pruneCandidates(destinationId: string, keep: number): string[] {
  if (keep <= 0) return [];
  return all<{ id: string }>(
    "SELECT id FROM backup_jobs WHERE destination_id = ? AND state = 'completed' AND pruned = 0 ORDER BY started_at DESC LIMIT -1 OFFSET ?",
    destinationId,
    Math.max(0, keep - 1),
  ).map((row) => row.id);
}

export function lastJobs(): Map<string, BackupJobRow> {
  const rows = all<BackupJobRow>(
    "SELECT j.* FROM backup_jobs j WHERE j.started_at = (SELECT MAX(started_at) FROM backup_jobs k WHERE k.destination_id = j.destination_id)",
  );
  return new Map(rows.map((row) => [row.destination_id, row]));
}

export function jobScriptPath(): string {
  return join(import.meta.dir, "../../tools/backup-job.ts");
}

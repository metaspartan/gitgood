import { isAbsolute } from "node:path";

export type BackupKind = "local" | "nas" | "google-drive";

export interface BackupDestination {
  id: string;
  name: string;
  kind: BackupKind;
  target: string;
}

export const MAX_BACKUP_DESTINATIONS = 12;
export const BACKUP_ID_PATTERN = /^[a-z][a-z0-9-]{0,39}$/;

export function validateBackupDestination(value: unknown): BackupDestination {
  if (!value || typeof value !== "object") throw new Error("Invalid destination");
  const d = value as Record<string, unknown>;
  if (typeof d.id !== "string" || !BACKUP_ID_PATTERN.test(d.id)) throw new Error("Use a short lowercase ID: letters, digits and dashes");
  if (typeof d.name !== "string" || !d.name.trim() || d.name.length > 80) throw new Error("Give the destination a name of up to 80 characters");
  if (d.kind !== "local" && d.kind !== "nas" && d.kind !== "google-drive") throw new Error("Unsupported destination kind");
  if (typeof d.target !== "string" || !d.target || d.target.length > 1024 || /[\x00-\x1f]/.test(d.target)) throw new Error("Enter a destination path or remote");
  if (d.kind === "google-drive") {
    if (!/^[a-zA-Z][a-zA-Z0-9_-]*:[^\\]*$/.test(d.target) || d.target.slice(d.target.indexOf(":") + 1).split("/").includes("..")) {
      throw new Error("Use a configured rclone remote and folder, for example drive:GitGood");
    }
  } else if (!isAbsolute(d.target)) {
    throw new Error("Local and NAS targets must be absolute mounted paths");
  }
  return { id: d.id, name: d.name.trim(), kind: d.kind, target: d.target };
}

export function parseBackupDestinations(raw: string | undefined): BackupDestination[] {
  if (!raw) return [];
  const values: unknown = JSON.parse(raw);
  if (!Array.isArray(values) || values.length > MAX_BACKUP_DESTINATIONS) throw new Error(`Expected up to ${MAX_BACKUP_DESTINATIONS} backup destinations`);
  const ids = new Set<string>();
  return values.map((value: unknown) => {
    const destination = validateBackupDestination(value);
    if (ids.has(destination.id)) throw new Error("Invalid or duplicate destination ID");
    ids.add(destination.id);
    return destination;
  });
}

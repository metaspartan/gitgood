import { isAbsolute } from "node:path";

export type BackupKind = "local" | "nas" | "google-drive" | "rclone";

export interface BackupDestination {
  id: string;
  name: string;
  kind: BackupKind;
  target: string;
  account_id?: number | null;
}

export const MAX_BACKUP_DESTINATIONS = 12;
export const BACKUP_ID_PATTERN = /^[a-z][a-z0-9-]{0,39}$/;
export const DEFAULT_DRIVE_FOLDER = "GitGood Backups";
const RCLONE_REMOTE = /^[a-zA-Z][a-zA-Z0-9_-]*:[^\\]*$/;
const KINDS: readonly BackupKind[] = ["local", "nas", "google-drive", "rclone"];

export function validateBackupDestination(value: unknown): BackupDestination {
  if (!value || typeof value !== "object") throw new Error("Invalid destination");
  const d = value as Record<string, unknown>;
  if (typeof d.id !== "string" || !BACKUP_ID_PATTERN.test(d.id)) throw new Error("Use a short lowercase ID: letters, digits and dashes");
  if (typeof d.name !== "string" || !d.name.trim() || d.name.length > 80) throw new Error("Give the destination a name of up to 80 characters");
  if (typeof d.kind !== "string" || !KINDS.includes(d.kind as BackupKind)) throw new Error("Unsupported destination kind");
  if (typeof d.target !== "string" || !d.target || d.target.length > 1024 || /[\x00-\x1f]/.test(d.target)) throw new Error("Enter a destination path, folder or remote");
  let kind = d.kind as BackupKind;
  const accountId = typeof d.account_id === "number" && Number.isInteger(d.account_id) && d.account_id > 0 ? d.account_id : null;
  if (kind === "google-drive" && accountId === null && RCLONE_REMOTE.test(d.target)) kind = "rclone";
  if (kind === "google-drive") {
    if (accountId === null) throw new Error("Choose a connected Google account");
    const folder = d.target.trim();
    if (!folder || folder.length > 100 || /[\/\\:]/.test(folder)) throw new Error("Use a Google Drive folder name of up to 100 characters without / \\ or :");
    return { id: d.id, name: d.name.trim(), kind, target: folder, account_id: accountId };
  }
  if (kind === "rclone") {
    if (!RCLONE_REMOTE.test(d.target) || d.target.slice(d.target.indexOf(":") + 1).split("/").includes("..")) {
      throw new Error("Use a configured rclone remote and folder, for example s3:bucket/gitgood");
    }
  } else if (!isAbsolute(d.target)) {
    throw new Error("Local and NAS targets must be absolute mounted paths");
  }
  return { id: d.id, name: d.name.trim(), kind, target: d.target, account_id: null };
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

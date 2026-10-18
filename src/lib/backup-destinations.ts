import { isAbsolute } from "node:path";

export interface BackupDestination {
  id: string;
  name: string;
  kind: "local" | "nas" | "google-drive";
  target: string;
}

export function parseBackupDestinations(raw: string | undefined): BackupDestination[] {
  if (!raw) return [];
  const values: unknown = JSON.parse(raw);
  if (!Array.isArray(values) || values.length > 12) throw new Error("Expected up to 12 backup destinations");
  const ids = new Set<string>();
  return values.map((value: unknown) => {
    if (!value || typeof value !== "object") throw new Error("Invalid destination");
    const d = value as Record<string, unknown>;
    if (typeof d.id !== "string" || !/^[a-z][a-z0-9-]{0,39}$/.test(d.id) || ids.has(d.id)) throw new Error("Invalid or duplicate destination ID");
    if (typeof d.name !== "string" || !d.name.trim() || d.name.length > 80) throw new Error("Invalid destination name");
    if (d.kind !== "local" && d.kind !== "nas" && d.kind !== "google-drive") throw new Error("Unsupported destination kind");
    if (typeof d.target !== "string" || !d.target || /[\x00-\x1f]/.test(d.target)) throw new Error("Invalid destination target");
    if (d.kind === "google-drive") {
      if (!/^[a-zA-Z][a-zA-Z0-9_-]*:[^\\]*$/.test(d.target) || d.target.slice(d.target.indexOf(":") + 1).split("/").includes("..")) throw new Error("Use a configured rclone remote and folder");
    } else if (!isAbsolute(d.target)) throw new Error("Local and NAS targets must be absolute mounted paths");
    ids.add(d.id);
    return { id: d.id, name: d.name.trim(), kind: d.kind, target: d.target };
  });
}

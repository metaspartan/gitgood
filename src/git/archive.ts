import { gitStream, type SpawnedGit } from "./run.ts";

export type ArchiveFormat = "tar.gz" | "zip";

interface FormatInfo {
  extension: string;
  mime: string;
  gitFormat: string;
}

const FORMATS: Readonly<Record<ArchiveFormat, FormatInfo>> = {
  "tar.gz": { extension: "tar.gz", mime: "application/gzip", gitFormat: "tar.gz" },
  zip: { extension: "zip", mime: "application/zip", gitFormat: "zip" },
};

export const ARCHIVE_FORMATS: readonly ArchiveFormat[] = ["tar.gz", "zip"];

export const DEFAULT_ARCHIVE_FORMAT: ArchiveFormat = "tar.gz";

export function parseArchiveFormat(raw: string | undefined): ArchiveFormat | null {
  if (raw === undefined || raw === "") return DEFAULT_ARCHIVE_FORMAT;
  const normalized = raw.toLowerCase();
  if (normalized === "tar.gz" || normalized === "targz" || normalized === "tgz") return "tar.gz";
  if (normalized === "zip") return "zip";
  return null;
}

export function archiveFormatInfo(format: ArchiveFormat): FormatInfo {
  return FORMATS[format];
}

export function sanitizeName(input: string): string {
  const cleaned = input
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/["\\/]/g, "-")
    .replace(/\.\.+/g, ".")
    .replace(/^[.-]+/, "")
    .trim();
  return cleaned.length === 0 ? "archive" : cleaned.slice(0, 100);
}

export function archiveFilename(repoName: string, ref: string, format: ArchiveFormat): string {
  return `${sanitizeName(repoName)}-${sanitizeName(ref)}.${FORMATS[format].extension}`;
}

export interface ArchiveOptions {
  cwd: string;
  ref: string;
  format: ArchiveFormat;
  prefix: string;
  path?: string;
}

export async function archiveStream(options: ArchiveOptions): Promise<SpawnedGit> {
  const args: string[] = [
    "archive",
    `--format=${FORMATS[options.format].gitFormat}`,
    `--prefix=${sanitizeName(options.prefix)}/`,
    options.ref,
  ];
  if (options.path) args.push("--", options.path);

  return gitStream(args, { cwd: options.cwd });
}

export function looksLikeArchive(bytes: Uint8Array, format: ArchiveFormat): boolean {
  if (format === "zip") return bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b;
  return bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
}

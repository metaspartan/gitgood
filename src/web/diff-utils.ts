import type { DiffFile } from "./types.ts";

export const DIFF_FILE_INDEX_THRESHOLD = 8;

export const LARGE_DIFF_MAX_OPEN_FILES = 20;
export const LARGE_DIFF_MAX_OPEN_LINES = 1500;

export function shouldAutoCollapse(file: DiffFile): boolean {
  return file.binary || file.omitted === "binary" || file.omitted === "too_large" || file.hunks.length === 0;
}

export function initialCollapsedFiles(
  files: DiffFile[],
  keepOpen: (file: DiffFile) => boolean = () => false,
): Set<string> {
  const placeholders = files.filter((file) => shouldAutoCollapse(file) && !keepOpen(file)).map((file) => file.path);
  const totalChanged = files.reduce((sum, file) => sum + file.additions + file.deletions, 0);
  if (files.length > LARGE_DIFF_MAX_OPEN_FILES || totalChanged > LARGE_DIFF_MAX_OPEN_LINES) {
    return new Set(files.map((file) => file.path));
  }
  return new Set(placeholders);
}

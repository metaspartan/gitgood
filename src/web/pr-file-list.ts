export const PR_FILE_LIST_BATCH = 100;

export function visibleFileRows(total: number, pages: number): number {
  if (!Number.isSafeInteger(total) || total < 0) throw new Error("total must be a non-negative integer");
  if (!Number.isSafeInteger(pages) || pages < 0) throw new Error("pages must be a non-negative integer");
  return Math.min(total, pages * PR_FILE_LIST_BATCH);
}

export function hasMoreFileRows(total: number, pages: number): boolean {
  return visibleFileRows(total, pages) < total;
}

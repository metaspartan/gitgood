import type { DiffFile } from "./types.ts";

export const EXPAND_BATCH_SIZE = 10;

export function expandBatch(collapsed: ReadonlySet<string>, files: DiffFile[], count: number): Set<string> {
  if (!Number.isSafeInteger(count) || count < 1) throw new Error("Expansion batch must be a positive integer");
  const next = new Set(collapsed);
  let remaining = count;
  for (const file of files) {
    if (remaining === 0) break;
    if (next.delete(file.path)) remaining -= 1;
  }
  return next;
}

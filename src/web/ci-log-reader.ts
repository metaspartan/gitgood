import type { CiLogLine } from "./types.ts";

export function createCiLogReader(load: (after: number, signal?: AbortSignal) => Promise<{ items: CiLogLine[] }>, maxLines = 4000) {
  let cursor = 0;
  let items: CiLogLine[] = [];
  let finished = false;
  let truncated = false;
  return async (terminal: boolean, signal?: AbortSignal) => {
    if (finished) return { items, truncated };
    for (let page = 0; page < 4; page++) {
      signal?.throwIfAborted();
      const result = await load(cursor, signal);
      signal?.throwIfAborted();
      const fresh = result.items.filter(line => line.seq >= cursor).sort((a, b) => a.seq - b.seq);
      if (!fresh.length) { if (terminal) finished = true; break; }
      const last = fresh[fresh.length - 1]!;
      if (last.seq < cursor) throw new Error("Build log cursor did not advance");
      cursor = last.seq + 1;
      const unique = fresh.filter((line, index) => index === 0 || line.seq !== fresh[index - 1]!.seq);
      const remaining = maxLines - items.length;
      items = [...items, ...unique.slice(0, remaining)];
      if (unique.length > remaining) { truncated = true; finished = true; break; }
    }
    return { items, truncated };
  };
}

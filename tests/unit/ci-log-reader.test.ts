import { expect, test } from "bun:test";
import { createCiLogReader } from "../../src/web/ci-log-reader.ts";

const lines = (count: number) => Array.from({ length: count }, (_, seq) => ({ seq, text: `line ${seq}` }));

test("reads below, at and above API page size without duplicate boundary rows", async () => {
  for (const count of [499, 500, 501, 2001]) {
    const all = lines(count); const offsets: number[] = [];
    const read = createCiLogReader(async after => { offsets.push(after); return { items: all.slice(after, after + 500) }; });
    let result = await read(true);
    expect(offsets.length).toBeLessThanOrEqual(4);
    result = await read(true);
    expect(result.items).toEqual(all);
    const calls = offsets.length; await read(true); expect(offsets.length).toBe(calls);
    expect(new Set(result.items.map(line => line.seq)).size).toBe(count);
  }
});

test("running log appends only new lines and completed logs stop network requests", async () => {
  let all = lines(2); const cursors: number[] = [];
  const read = createCiLogReader(async cursor => { cursors.push(cursor); return { items: all.filter(x => x.seq >= cursor) }; });
  expect((await read(false)).items).toHaveLength(2);
  all = lines(4); expect((await read(true)).items).toEqual(all);
  expect(cursors).toEqual([0, 2, 2, 4]); await read(true); expect(cursors).toHaveLength(4);
});

test("display cap retains exactly its limit and detects smallest excess", async () => {
  for (const count of [3, 4, 5]) {
    const read = createCiLogReader(async cursor => ({ items: lines(count).slice(cursor) }), 4);
    const result = await read(true);
    expect(result.items).toEqual(lines(Math.min(count, 4)));
    expect(result.truncated).toBe(count > 4);
  }
});

test("failed page preserves cursor so retry does not lose log data", async () => {
  let fail = true; const cursors: number[] = [];
  const read = createCiLogReader(async cursor => { cursors.push(cursor); if (fail) { fail = false; throw new Error("network"); } return { items: lines(2).slice(cursor) }; });
  await expect(read(false)).rejects.toThrow("network");
  expect((await read(true)).items).toEqual(lines(2)); expect(cursors).toEqual([0, 0, 2]);
});

test("aborted page is not committed and a fresh caller can retry", async () => {
  const controller = new AbortController(); let calls = 0;
  const read = createCiLogReader(async cursor => { calls++; if (calls === 1) controller.abort(); return { items: lines(2).slice(cursor) }; });
  await expect(read(false, controller.signal)).rejects.toThrow();
  expect((await read(true)).items).toEqual(lines(2));
});

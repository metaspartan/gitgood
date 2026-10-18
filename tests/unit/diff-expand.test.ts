import { expect, test } from "bun:test";
import { expandBatch, EXPAND_BATCH_SIZE } from "../../src/web/diff-expand.ts";
import type { DiffFile } from "../../src/web/types.ts";

function files(paths: string[]): DiffFile[] {
  return paths.map((path) => ({ path, old_path: null, status: "modified", binary: false, omitted: null, language: null, additions: 1, deletions: 0, hunks: [] }));
}

test("batch expansion opens files in display order, below, at and above the batch size", () => {
  const list = files(["a", "b", "c"]);
  const all = new Set(list.map((f) => f.path));
  expect([...expandBatch(all, list, 2)]).toEqual(["c"]);
  expect([...expandBatch(all, list, 3)]).toEqual([]);
  expect([...expandBatch(all, list, 99)]).toEqual([]);
  expect([...expandBatch(new Set(["b", "c"]), list, 1)]).toEqual(["c"]);
  expect([...expandBatch(new Set(["b", "c"]), list, 2)]).toEqual([]);
  expect(expandBatch(new Set(), list, 5).size).toBe(0);
});

test("batch size is a bounded constant and invalid counts fail closed", () => {
  expect(EXPAND_BATCH_SIZE).toBeGreaterThanOrEqual(5);
  expect(EXPAND_BATCH_SIZE).toBeLessThanOrEqual(50);
  const list = files(["a"]);
  expect(() => expandBatch(new Set(["a"]), list, 0)).toThrow();
  expect(() => expandBatch(new Set(["a"]), list, -1)).toThrow();
});

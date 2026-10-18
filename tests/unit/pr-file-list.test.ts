import { expect, test } from "bun:test";
import { hasMoreFileRows, PR_FILE_LIST_BATCH, visibleFileRows } from "../../src/web/pr-file-list.ts";

test("renders nothing for an empty or not-yet-expanded list", () => {
  expect(visibleFileRows(0, 0)).toBe(0);
  expect(visibleFileRows(500, 0)).toBe(0);
  expect(hasMoreFileRows(500, 0)).toBe(true);
});

test("batch boundary is exact, then never exceeds the real file count", () => {
  expect(visibleFileRows(PR_FILE_LIST_BATCH, 1)).toBe(PR_FILE_LIST_BATCH);
  expect(hasMoreFileRows(PR_FILE_LIST_BATCH, 1)).toBe(false);
  expect(visibleFileRows(PR_FILE_LIST_BATCH + 1, 1)).toBe(PR_FILE_LIST_BATCH);
  expect(hasMoreFileRows(PR_FILE_LIST_BATCH + 1, 1)).toBe(true);
  expect(visibleFileRows(7, 1)).toBe(7);
  expect(hasMoreFileRows(7, 1)).toBe(false);
  expect(visibleFileRows(5_000, 3)).toBe(300);
});

test("invalid inputs fail closed rather than rendering everything", () => {
  expect(() => visibleFileRows(-1, 1)).toThrow();
  expect(() => visibleFileRows(1.5, 1)).toThrow();
  expect(() => visibleFileRows(10, -1)).toThrow();
  expect(() => visibleFileRows(10, 0.5)).toThrow();
});

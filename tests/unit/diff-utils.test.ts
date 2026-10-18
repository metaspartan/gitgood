import { expect, test } from "bun:test";
import { DIFF_FILE_INDEX_THRESHOLD, LARGE_DIFF_MAX_OPEN_FILES, LARGE_DIFF_MAX_OPEN_LINES, initialCollapsedFiles, shouldAutoCollapse } from "../../src/web/diff-utils.ts";
import type { DiffFile } from "../../src/web/types.ts";

function file(path: string, overrides: Partial<DiffFile> = {}): DiffFile {
  return {
    path,
    old_path: null,
    status: "modified",
    binary: false,
    omitted: null,
    language: null,
    additions: 1,
    deletions: 0,
    hunks: [{ header: "@@", old_start: 1, new_start: 1, lines: [] }],
    ...overrides,
  };
}

test("binary, omitted and metadata-only files auto-collapse; textual files stay open", () => {
  expect(shouldAutoCollapse(file("bin.dat", { binary: true }))).toBe(true);
  expect(shouldAutoCollapse(file("big.txt", { omitted: "too_large" }))).toBe(true);
  expect(shouldAutoCollapse(file("img.bin", { omitted: "binary" }))).toBe(true);
  expect(shouldAutoCollapse(file("meta.txt", { hunks: [] }))).toBe(true);
  expect(shouldAutoCollapse(file("src.ts"))).toBe(false);
});

test("initial collapse set contains exactly placeholder files for small diffs", () => {
  const files = [file("src.ts"), file("bin.dat", { binary: true }), file("meta.txt", { hunks: [] })];
  const collapsed = initialCollapsedFiles(files);
  expect(collapsed.has("src.ts")).toBe(false);
  expect(collapsed.has("bin.dat")).toBe(true);
  expect(collapsed.has("meta.txt")).toBe(true);
});

test("large diffs start fully collapsed regardless of file kind", () => {
  const manyFiles = Array.from({ length: LARGE_DIFF_MAX_OPEN_FILES + 1 }, (_, i) => file(`f${i}.ts`));
  let collapsed = initialCollapsedFiles(manyFiles);
  expect(collapsed.size).toBe(manyFiles.length);
  const bigChanges = [file("one.ts", { additions: LARGE_DIFF_MAX_OPEN_LINES + 1 })];
  collapsed = initialCollapsedFiles(bigChanges);
  expect(collapsed.has("one.ts")).toBe(true);
  const small = [file("a.ts"), file("b.ts", { binary: true })];
  collapsed = initialCollapsedFiles(small);
  expect([...collapsed]).toEqual(["b.ts"]);
});

test("small diffs stay under the index threshold", () => {
  expect(DIFF_FILE_INDEX_THRESHOLD).toBeGreaterThanOrEqual(8);
  expect(Array.from({ length: 7 }, (_, i) => file(`f${i}`)).length).toBeLessThan(DIFF_FILE_INDEX_THRESHOLD);
});

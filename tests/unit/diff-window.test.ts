import { expect, test } from "bun:test";
import { diffHunkWindow, DIFF_FILE_RENDER_WINDOW } from "../../src/web/diff-view-window.ts";
import type { DiffFile, DiffHunk } from "../../src/web/types.ts";

function hunks(counts: number[]): DiffHunk[] {
  return counts.map((n, i) => ({
    header: `@@ -${i},${n} +${i},${n} @@`,
    old_start: i,
    new_start: i,
    lines: Array.from({ length: n }, (_, j) => ({ kind: "context" as const, text: `l${j}`, old_line: j, new_line: j })),
  }));
}
function file(h: DiffHunk[]): DiffFile {
  return { path: "a.txt", old_path: null, status: "modified", binary: false, omitted: null, language: null, additions: 0, deletions: 0, hunks: h };
}

test("small diffs below the window render fully with source indices preserved", () => {
  const result = diffHunkWindow(file(hunks([3, 4])), false);
  expect(result.windowed).toBe(false);
  expect(result.render).toHaveLength(2);
  expect(result.render.every((r) => r.sourceIndex >= 0 && r.lineLimit === null)).toBe(true);
  expect(result.hiddenLines).toBe(0);
});

test("boundary at exactly the limit stays unwindowed; one above truncates equally", () => {
  const at = diffHunkWindow(file(hunks([DIFF_FILE_RENDER_WINDOW])), false);
  expect(at.windowed).toBe(false);
  const oneMore = diffHunkWindow(file(hunks([DIFF_FILE_RENDER_WINDOW, 1])), false);
  expect(oneMore.windowed).toBe(true);
  expect(oneMore.hiddenLines).toBe(1);
  expect(oneMore.render[0]!.sourceIndex).toBe(0);
  expect(oneMore.render[0]!.lineLimit).toBeNull();
  expect(oneMore.render[1]!.sourceIndex).toBe(1);
  expect(oneMore.render[1]!.lineLimit).toBe(0);
});

test("truncated hunk keeps its source index for aligned highlighting and captures hidden lines", () => {
  const result = diffHunkWindow(file(hunks([700, 700])), false, 1000);
  expect(result.windowed).toBe(true);
  expect(result.render).toHaveLength(2);
  expect(result.render[0]!.lineLimit).toBeNull();
  expect(result.render[1]!.sourceIndex).toBe(1);
  expect(result.render[1]!.lineLimit).toBe(300);
  expect(result.hiddenLines).toBe(400);
});

test("expanded mode renders whole hunks and reports no windowing", () => {
  const result = diffHunkWindow(file(hunks([2000])), true);
  expect(result.windowed).toBe(false);
  expect(result.render).toHaveLength(1);
  expect(result.render[0]!.lineLimit).toBeNull();
  expect(result.hiddenLines).toBe(0);
});

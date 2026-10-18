import type { DiffFile, DiffHunk } from "./types.ts";

export const DIFF_FILE_RENDER_WINDOW = 1200;

export interface DiffRenderHunk {
  hunk: DiffHunk;
  sourceIndex: number;
  lineLimit: number | null;
}

export interface DiffHunkWindow {
  windowed: boolean;
  render: DiffRenderHunk[];
  hiddenLines: number;
}

export function diffHunkWindow(file: DiffFile, expanded: boolean, limit = DIFF_FILE_RENDER_WINDOW): DiffHunkWindow {
  if (expanded) {
    return {
      windowed: false,
      render: file.hunks.map((hunk, sourceIndex) => ({ hunk, sourceIndex, lineLimit: null })),
      hiddenLines: 0,
    };
  }
  let visible = 0;
  const render: DiffRenderHunk[] = [];
  let hiddenLines = 0;
  let truncated = false;
  for (let sourceIndex = 0; sourceIndex < file.hunks.length; sourceIndex++) {
    const hunk = file.hunks[sourceIndex]!;
    visible += hunk.lines.length;
    if (visible <= limit) {
      render.push({ hunk, sourceIndex, lineLimit: null });
    } else {
      const remaining = limit - (visible - hunk.lines.length);
      render.push({ hunk, sourceIndex, lineLimit: Math.max(0, remaining) });
      hiddenLines += hunk.lines.length - Math.max(0, remaining);
      truncated = true;
      break;
    }
  }
  if (truncated) {
    for (let i = render.length; i < file.hunks.length; i++) hiddenLines += file.hunks[i]!.lines.length;
  }
  return { windowed: hiddenLines > 0, render, hiddenLines };
}

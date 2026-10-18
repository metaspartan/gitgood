export interface LineSelection {
  start: number;
  end: number;
}

export function parseLineSelection(hash: string, first: number, count: number): LineSelection | null {
  const match = /^#L([1-9]\d*)(?:-L([1-9]\d*))?$/.exec(hash);
  if (!match || count < 1) return null;
  const a = Number(match[1]);
  const b = Number(match[2] ?? match[1]);
  const start = Math.min(a, b);
  const end = Math.max(a, b);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < first || end >= first + count) return null;
  return { start, end };
}

export function lineSelectionHash(selection: LineSelection): string {
  const start = Math.min(selection.start, selection.end);
  const end = Math.max(selection.start, selection.end);
  return start === end ? `#L${start}` : `#L${start}-L${end}`;
}

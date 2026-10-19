import { expect, test } from "bun:test";
import { calendarWeeks, contributionLevel, describeDay, monthLabels } from "../../src/web/components/ContributionGraph.tsx";
import { toggleReaction } from "../../src/web/components/CommentThread.tsx";
import { identiconCells } from "../../src/web/components.tsx";

const range = (start: string, count: number) =>
  Array.from({ length: count }, (_, i) => ({ date: new Date(Date.parse(`${start}T00:00:00Z`) + i * 86_400_000).toISOString().slice(0, 10), count: i % 3 }));

test("contribution levels scale to the busiest day", () => {
  expect([0, 1, 3, 5, 6, 8, 10].map((count) => contributionLevel(count, 8))).toEqual([0, 1, 2, 3, 3, 4, 4]);
  expect(contributionLevel(3, 0)).toBe(0);
});

test("the calendar starts its first column on Sunday and keeps every day", () => {
  const days = range("2026-10-14", 10);
  const weeks = calendarWeeks(days);
  expect(weeks[0]!.slice(0, 3)).toEqual([null, null, null]);
  expect(weeks[0]![3]).toEqual(days[0]);
  expect(weeks.flat().filter((cell) => cell !== null)).toEqual(days);
  expect(calendarWeeks([])).toEqual([]);
});

test("month labels follow each week's Sunday, like GitHub, and never crowd the first column", () => {
  const rolling = monthLabels(calendarWeeks(range("2025-10-19", 365)));
  expect(rolling.map((label) => label.label)).toEqual(["Oct", "Nov", "Dec", "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct"]);
  expect(rolling[1]).toEqual({ week: 2, label: "Nov" });
  const tight = monthLabels(calendarWeeks(range("2025-10-26", 365)));
  expect(tight[0]!.label).toBe("Nov");
  const year = monthLabels(calendarWeeks(range("2026-01-01", 365)));
  expect(year[0]).toEqual({ week: 0, label: "Jan" });
  expect(year).toHaveLength(12);
});

test("day descriptions read like GitHub's tooltips", () => {
  expect(describeDay({ date: "2026-10-01", count: 0 })).toBe("No contributions on October 1st.");
  expect(describeDay({ date: "2026-10-12", count: 1 })).toBe("1 contribution on October 12th.");
  expect(describeDay({ date: "2026-10-22", count: 5 })).toBe("5 contributions on October 22nd.");
});

test("identicons are deterministic, horizontally symmetric and never blank", () => {
  for (const name of ["seed", "octocat", "a", "Carsen", ""]) {
    const cells = identiconCells(name);
    expect(cells).toHaveLength(25);
    expect(cells.some(Boolean)).toBe(true);
    for (let row = 0; row < 5; row += 1) {
      expect(cells[row * 5]).toBe(cells[row * 5 + 4]);
      expect(cells[row * 5 + 1]).toBe(cells[row * 5 + 3]);
    }
    expect(identiconCells(name.toUpperCase())).toEqual(cells);
  }
  expect(identiconCells("seed")).not.toEqual(identiconCells("octocat"));
});

test("toggling a reaction adds, removes and keeps GitHub's order", () => {
  const start = [{ content: "heart" as const, count: 2, me: false }];
  const added = toggleReaction(start, "+1");
  expect(added).toEqual({ adding: true, next: [{ content: "+1", count: 1, me: true }, { content: "heart", count: 2, me: false }] });
  const removed = toggleReaction(toggleReaction(added.next, "heart").next, "+1");
  expect(removed).toEqual({ adding: false, next: [{ content: "heart", count: 3, me: true }] });
});

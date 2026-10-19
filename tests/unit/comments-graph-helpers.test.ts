import { expect, test } from "bun:test";
import { calendarWeeks, contributionLevel } from "../../src/web/components/ContributionGraph.tsx";
import { toggleReaction } from "../../src/web/components/CommentThread.tsx";

test("contribution levels scale to the busiest day", () => {
  expect([0, 1, 3, 5, 6, 8, 10].map((count) => contributionLevel(count, 8))).toEqual([0, 1, 2, 3, 3, 4, 4]);
  expect(contributionLevel(3, 0)).toBe(0);
});

test("the calendar starts its first column on Sunday and keeps every day", () => {
  const days = Array.from({ length: 10 }, (_, i) => ({ date: new Date(Date.UTC(2026, 9, 14 + i)).toISOString().slice(0, 10), count: i }));
  const weeks = calendarWeeks(days);
  expect(new Date("2026-10-14T00:00:00Z").getUTCDay()).toBe(3);
  expect(weeks[0]!.slice(0, 3)).toEqual([null, null, null]);
  expect(weeks[0]![3]).toEqual(days[0]);
  expect(weeks.flat().filter((cell) => cell !== null)).toEqual(days);
  expect(weeks.every((week, index) => index === weeks.length - 1 || week.length === 7)).toBe(true);
  expect(calendarWeeks([])).toEqual([]);
});

test("toggling a reaction adds, removes and keeps GitHub's order", () => {
  const start = [{ content: "heart" as const, count: 2, me: false }];
  const added = toggleReaction(start, "+1");
  expect(added).toEqual({ adding: true, next: [{ content: "+1", count: 1, me: true }, { content: "heart", count: 2, me: false }] });
  const joined = toggleReaction(added.next, "heart");
  expect(joined.next[1]).toEqual({ content: "heart", count: 3, me: true });
  const removed = toggleReaction(joined.next, "+1");
  expect(removed).toEqual({ adding: false, next: [{ content: "heart", count: 3, me: true }] });
});

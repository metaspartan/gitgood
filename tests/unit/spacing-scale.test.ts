import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const styles = readFileSync(join(import.meta.dir, "..", "..", "src", "web", "styles.css"), "utf8");

function scaleValues(): number[] {
  const matches = [...styles.matchAll(/--s(\d+):\s*(\d+)px;/g)];
  const values = matches.map((match) => Number(match[2]));
  for (let i = 1; i < values.length; i += 1) {
    expect(values[i]!).toBeGreaterThan(values[i - 1]!);
  }
  return values;
}

test("the spacing scale exists and increases", () => {
  const values = scaleValues();
  expect(values.length).toBeGreaterThanOrEqual(5);
  expect(values).toContain(8);
  expect(values).toContain(16);
});

test("shared layout classes use the scale rather than ad-hoc pixel values", () => {
  const values = scaleValues();
  const base = [
    ".row {",
    ".card + .card {",
    ".grid {",
    "main.container {",
  ];
  for (const selector of base) {
    const line = styles.split("\n").find((candidate) => candidate.trim().startsWith(selector));
    expect(line, `${selector} should be defined in the base layer`).toBeDefined();
    const rule = line!.slice(line!.indexOf("{"));
    for (const match of rule.matchAll(/(?:gap|margin|padding)[^:]*:\s*(\d+)px/g)) {
      const value = Number(match[1]);
      const nearest = values.reduce((best, step) => (Math.abs(step - value) < Math.abs(best - value) ? step : best));
      expect(
        values.includes(value),
        `${selector.trim()} uses ${value}px, which is off-scale. Use var(--sN); the closest step is ${nearest}px`,
      ).toBe(true);
    }
  }
});

test("no layout selector is defined twice at the same nesting level", () => {
  const seen = new Map<string, number>();
  const duplicates: string[] = [];
  let depth = 0;
  for (const line of styles.split("\n")) {
    const trimmed = line.trim();
    const match = /^\.([a-z][a-z0-9-]*)\s*\{/.exec(trimmed);
    if (match && depth === 0) {
      const key = match[1]!;
      seen.set(key, (seen.get(key) ?? 0) + 1);
      if (seen.get(key) === 2) duplicates.push(key);
    }
    depth += (line.match(/{/g) ?? []).length - (line.match(/}/g) ?? []).length;
  }
  expect(
    duplicates,
    `these selectors are declared twice at the top level, so the later one silently wins: ${duplicates.join(", ")}`,
  ).toEqual([]);
});

test("the stylesheet has balanced braces", () => {
  const open = (styles.match(/{/g) ?? []).length;
  const close = (styles.match(/}/g) ?? []).length;
  expect(open).toBe(close);
});

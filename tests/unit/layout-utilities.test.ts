import { expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const webRoot = join(import.meta.dir, "..", "..", "src", "web");
const styles = readFileSync(join(webRoot, "styles.css"), "utf8");

const LAYOUT_UTILITIES = [
  "stack",
  "stack-tight",
  "row",
  "grid",
  "card",
  "tabs",
  "measure",
  "spacer",
] as const;

function tsxFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) tsxFiles(full, out);
    else if (entry.endsWith(".tsx")) out.push(full);
  }
  return out;
}

const allTsx = tsxFiles(webRoot);
const allSource = allTsx.map((file) => ({ file, text: readFileSync(file, "utf8") }));

test("the layout utilities used across the UI are all defined in the stylesheet", () => {
  const undefinedClasses: string[] = [];
  for (const name of LAYOUT_UTILITIES) {
    const defined = new RegExp(`(?:^|[\\s,>+~])\\.${name}(?![\\w-])`, "m").test(styles);
    if (!defined) {
      undefinedClasses.push(name);
      continue;
    }
    const used = allSource.some(({ text }) => new RegExp(`className="[^"]*\\b${name}\\b`).test(text));
    expect(used, `.${name} is defined but never used`).toBe(true);
  }
  expect(undefinedClasses, `these layout classes are used but never defined: ${undefinedClasses.join(", ")}`).toEqual([]);
});

test("no page uses a bare stack class without the rule it depends on", () => {
  const stacksOnDivs = allSource.filter(({ text }) => /<div[^>]*className="[^"]*\bstack\b/.test(text));
  expect(stacksOnDivs.length, "expected at least one page to lay out with .stack").toBeGreaterThan(0);
  expect(styles).toMatch(/^\.stack \{[^}]*flex-direction:\s*column/m);
});

test("the tab treatment covers buttons, not only anchors", () => {
  const tabButtons = allSource.filter(({ text }) => /className=\{?[^}]*\btab\b/.test(text) && /<button/.test(text));
  expect(tabButtons.length, "expected at least one button-based tab strip").toBeGreaterThan(0);
  const rule = styles.slice(styles.indexOf(".tabs a,"), styles.indexOf(".tabs a.active"));
  expect(rule).toContain(".tabs button.tab");
});

test("every button-based tab strip declares a pressed state, not a tabpanel", () => {
  for (const { file, text } of allSource) {
    if (!/<button[\s\S]{0,400}?className=\{?[^}]*\btab\b/.test(text)) continue;
    expect(text, `${file} renders a button tab`).toContain("aria-pressed");
    expect(text, `${file} should not claim a tablist it has no panel for`).not.toContain('role="tablist"');
  }
});

test("the spacing scale is used rather than invented values in the utilities", () => {
  const baseLayer = styles.slice(0, styles.indexOf("/* ====") === -1 ? styles.length : styles.indexOf("/* ===="));
  for (const name of [".stack", ".stack-tight", ".row", ".grid", ".measure"]) {
    const start = baseLayer.indexOf(name);
    expect(start, `${name} should exist in the base layer`).toBeGreaterThan(-1);
    const rule = baseLayer.slice(start, baseLayer.indexOf("}", start));
    for (const match of rule.matchAll(/:\s*(\d+)px/g)) {
      expect(
        /var\(--s/.test(rule) || Number(match[1]) <= 2,
        `${name} uses a hand-picked ${match[1]}px where the scale should be used`,
      ).toBe(true);
    }
  }
});

test("the page container states the vertical rhythm, not a sibling pattern", () => {
  expect(styles).toMatch(/main\.container\s*>\s*\*\s*\+\s*\*\s*\{/m);

  const rule = styles.slice(
    styles.indexOf("main.container > * + *"),
    styles.indexOf("}", styles.indexOf("main.container > * + *")),
  );
  expect(rule).toContain("var(--s4)");
  expect(rule).not.toMatch(/\d+px/);
});

test("no block-level element hard-codes a vertical margin inline", () => {
  const offenders: string[] = [];
  for (const { file, text } of allSource) {
    for (const match of text.matchAll(/className="(?:stack|card|list|metric-row|thread-controls)"[^>]*style=\{\{([^}]*)\}/g)) {
      if (/margin(?:Top|-top|Bottom):\s*["']?\d/.test(match[1] ?? "")) {
        offenders.push(`${file.split(/[\\/]/).pop()}`);
      }
    }
  }
  expect(
    offenders,
    `these block-level elements set a hard-coded vertical margin: ${[...new Set(offenders)].join(", ")}`,
  ).toEqual([]);
});

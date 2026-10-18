import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const css = readFileSync(new URL("../../src/web/styles.css", import.meta.url), "utf8");
const app = readFileSync(new URL("../../src/web/App.tsx", import.meta.url), "utf8");
const router = readFileSync(new URL("../../src/web/router.tsx", import.meta.url), "utf8");

describe("interaction affordances", () => {
  test("the stylesheet is balanced, so a bad append cannot ship a broken sheet", () => {
    const open = (css.match(/\{/g) ?? []).length;
    const close = (css.match(/\}/g) ?? []).length;
    expect(open).toBe(close);
  });

  test("anchors declare a pointer cursor explicitly", () => {
    expect(css).toMatch(/a\[href\][\s\S]{0,400}cursor:\s*pointer/);
  });

  test("the controls that are not anchors get a pointer too", () => {
    for (const selector of ["select", "summary", ".switch-track", ".switch-label", 'label[for]']) {
      expect(css).toContain(selector);
    }
    const start = css.indexOf("a[href],");
    expect(start).toBeGreaterThan(-1);
    const close = css.indexOf(")", start);
    expect(close).toBeGreaterThan(start);
    const rule = css.slice(start, css.indexOf("{", close));
    for (const selector of ["button", "select", "summary", '[role="button"]', '[role="tab"]', "label[for]"]) {
      expect(rule, `the pointer rule should cover ${selector}`).toContain(selector);
    }
    const body = css.slice(css.indexOf("{", close), css.indexOf("}", close));
    expect(body).toContain("cursor: pointer");
  });

  test("disabled controls say so with the cursor, not only with opacity", () => {
    expect(css).toMatch(/cursor:\s*not-allowed/);
    expect(css).toMatch(/button:disabled/);
  });

  test("text inputs keep the caret cursor", () => {
    expect(css).toMatch(/input:not\(\[type\]\)[\s\S]{0,120}cursor:\s*text/);
  });

  test("keyboard focus is visible on controls, not only on inputs", () => {
    const start = css.indexOf(":where(a[href], button, select, summary");
    expect(start).toBeGreaterThan(-1);
    const block = css.slice(start, start + 1200);
    expect(block).toContain("outline:");
    expect(block).toMatch(/\bbutton\b/);
    expect(block).toContain(":focus-visible");
  });

  test("motion is suppressed for a reader who asked for that", () => {
    expect(css).toContain("prefers-reduced-motion: reduce");
    expect(css).toContain("prefers-reduced-motion: no-preference");
  });

  test("the skip link has a destination that exists", () => {
    expect(app).toContain('className="skip-link"');
    expect(app).toContain('href="#main"');
    expect(app).toMatch(/id="main"/);
  });

  test("Link can mark the current page for assistive technology", () => {
    expect(router).toContain("ariaCurrent");
    expect(router).toContain("aria-current");
  });

  test("a clickable table row declares the pointer in the stylesheet, not inline", () => {
    expect(css).toContain("tr.rowlink { cursor: pointer; }");
    expect(css).toContain("tr.rowlink:hover td");
  });

  test("a row that opens something gives keyboard users a real control", () => {
    const actions = readFileSync(new URL("../../src/web/pages/Actions.tsx", import.meta.url), "utf8");
    if (actions.includes('className="rowlink"')) {
      expect(actions).toContain('button type="button" className="linklike"');
      expect(css).toContain("button.linklike {");
      expect(actions).toContain("event.stopPropagation()");
    }
    const pages = readdirSyncPages();
    for (const name of pages) {
      expect(name).not.toMatch(/cursor:\s*"pointer"/);
    }
  });
});

function readdirSyncPages(): string[] {
  const out: string[] = [];
  const stack = [new URL("../../src/web/pages/", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")];
  while (stack.length > 0) {
    const dir = stack.pop() as string;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.name.endsWith(".tsx")) out.push(readFileSync(full, "utf8"));
    }
  }
  return out;
}

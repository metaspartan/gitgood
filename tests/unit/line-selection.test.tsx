import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { CodeView } from "../../src/web/components/CodeView.tsx";
import { lineSelectionHash, parseLineSelection } from "../../src/web/line-selection.ts";

describe("code line links", () => {
  test("single lines and reversed ranges round trip", () => {
    for (const [hash, start, end] of [["#L1", 1, 1], ["#L2-L5", 2, 5], ["#L5-L2", 2, 5]] as const) {
      const selection = parseLineSelection(hash, 1, 5);
      expect(selection).toEqual({ start, end });
      expect(parseLineSelection(lineSelectionHash(selection!), 1, 5)).toEqual(selection);
    }
  });
  test("bounds and malformed fragments fail closed", () => {
    for (const hash of ["#L0", "#L6", "#L1-L6", "#L-1", "#L1x", "#L1-L2-extra", "#L9007199254740992", "#L01"])
      expect(parseLineSelection(hash, 1, 5)).toBeNull();
    expect(parseLineSelection("#L1", 1, 0)).toBeNull();
    expect(parseLineSelection("#L9", 10, 3)).toBeNull();
    expect(parseLineSelection("#L10-L12", 10, 3)).toEqual({ start: 10, end: 12 });
    expect(parseLineSelection("#L13", 10, 3)).toBeNull();
  });
  test("opt-in gutters are real accessible anchors and preserve escaped code", () => {
    const html = renderToStaticMarkup(<CodeView code={'<script>\nsecond'} language={null} startLine={10} lineLinks />);
    expect(html).toContain('href="#L10"');
    expect(html).toContain('id="L11"');
    expect(html).toContain('aria-label="Link to line 10"');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('role="status"');
  });
  test("non-blob viewers do not create duplicate line IDs", () => {
    expect(renderToStaticMarkup(<CodeView code="one" language={null} />)).not.toContain('id="L1"');
  });
  test("initial rendering remains bounded below, at and above its limit", () => {
    for (const count of [2, 3, 4]) {
      const html = renderToStaticMarkup(<CodeView code={Array(count).fill('x').join('\n')} language={null} initialLines={3} lineLinks />);
      expect((html.match(/class="code-line"/g) ?? []).length).toBe(Math.min(count, 3));
      expect(html.includes('Show all')).toBe(count > 3);
    }
  });
});

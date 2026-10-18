import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { CodeView } from "../../src/web/components/CodeView.tsx";

function code(n: number): string {
  return Array.from({ length: n }, (_, i) => `line ${i + 1}`).join("\n");
}

test("small files render all lines with a single plain body", () => {
  const html = renderToStaticMarkup(<CodeView code={code(120)} language={null} />);
  expect((html.match(/class="code-line"/g) ?? []).length).toBe(120);
  expect(html).not.toContain("code-spacer");
});

test("large files are windowed and only a bounded number of rows mount", () => {
  const html = renderToStaticMarkup(<CodeView code={code(3000)} language={null} initialLines={5000} />);
  expect((html.match(/class="code-line"/g) ?? []).length).toBeLessThan(3000);
  expect(html).toContain("3,000");
  expect(html).toContain("Showing a window around your scroll position");
});

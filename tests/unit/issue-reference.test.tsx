import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { renderMarkdown } from "../../src/web/markdown.tsx";
import { referenceHref } from "../../src/web/issue-reference.ts";

const render = (src: string, resolveReference?: (raw: string) => string | null) =>
  renderToStaticMarkup(<>{renderMarkdown(src, { resolveReference, referenceMode: resolveReference !== undefined })}</>);

test("issue reference helper resolves local and cross-repo refs and rejects malformed", () => {
  expect(referenceHref("acme", "repo", "#123")).toBe("/acme/repo/issues/123");
  expect(referenceHref("acme", "repo", "other/repo#7")).toBe("/other/repo/issues/7");
  for (const bad of ["#x", "acme#1", "acme/repo/x", "#", "acme/repo#0"]) expect(referenceHref("acme", "repo", bad)).toBeNull();
});

test("markdown renders issue references as links and leaves plain numbers alone when disabled", () => {
  const src = "Fix #42 but not #x or 7. Cross repo acme/x#3.";
  const html = render(src, (raw) => referenceHref("acme", "repo", raw));
  expect(html).toContain('class="markdown-ref"'); expect(html).toContain('href="/acme/repo/issues/42"');
  expect(html).toContain('href="/acme/x/issues/3"');
  const disabled = render(src); expect(disabled).toContain("#42"); expect(disabled).not.toContain("markdown-ref");
});

test("references inside inline code are not linked", () => {
  const html = render("use `#99` here", (raw) => referenceHref("acme", "repo", raw));
  expect(html).not.toContain('href="/acme/repo/issues/99"');
  expect(html).toContain("markdown-inline-code");
});

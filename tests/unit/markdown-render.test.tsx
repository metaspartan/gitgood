import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { renderMarkdown } from "../../src/web/markdown.tsx";

const render = (src: string, opts?: { resolveImageUrl?: (s: string) => string | null }) =>
  renderToStaticMarkup(<>{renderMarkdown(src, opts)}</>);

test("block structure: headings, lists, quotes, fenced code and horizontal rules render", () => {
  const html = render("# Title\n\n- one\n- two\n\n> a quote\n\n```js\nconst x = 1;\n```\n\n---\n");
  expect(html).toContain("<h1>"); expect(html).toContain("<ul>"); expect(html).toContain("<li>");
  expect(html).toContain("<blockquote>"); expect(html).toContain("class=\"markdown-pre\""); expect(html).toContain('class="language-js"');
  expect(html).toContain("<hr/>");
});

test("inline emphasis, code and links are proper elements", () => {
  const html = render("**bold** and *italic* and `inline` and [label](https://example.com)");
  expect(html).toContain("<strong>bold</strong>"); expect(html).toContain("<em>italic</em>");
  expect(html).toContain("markdown-inline-code"); expect(html).toContain("<a href=\"https://example.com\"");
});

test("raw HTML in source is not treated as markup (no XSS via dangerouslySetInnerHTML)", () => {
  const html = render("before <script>alert(1)</script> after");
  expect(html).not.toContain("<script>");
  expect(html).toContain("&lt;script&gt;");
});

test("javascript: links are refused by safeHref", () => {
  const html = render("[x](javascript:alert(1))");
  expect(html).toContain("markdown-broken-link"); expect(html).not.toContain("javascript:");
});

test("relative images resolve through resolveImageUrl and absolute images render directly", () => {
  const html = render("![shot](docs/x.png)", { resolveImageUrl: (s) => `/raw/${s}` });
  expect(html).toContain("src=\"/raw/docs/x.png\""); expect(html).toContain('alt="shot"');
  const abs = render("![logo](https://cdn.example.com/logo.png)");
  expect(abs).toContain("src=\"https://cdn.example.com/logo.png\"");
});

test("resolved image falling back to alt text when resolver returns null", () => {
  const html = render("![missing](nope.png)", { resolveImageUrl: () => null });
  expect(html).toContain("markdown-alt"); expect(html).toContain("missing");
});


test("GFM tables, nested tasks, strikethrough and ordered starts", () => {
  const html = render("| Feature | State |\n| :--- | ---: |\n| **Tables** | ready |\n\n- [x] Parent\n  - Nested child\n- [ ] Todo\n\n3. Third\n4. Fourth\n\n~~old~~");
  expect(html).toContain("<table>"); expect(html).toContain("<thead>"); expect(html).toContain('style="text-align:right"');
  expect(html).toContain('type="checkbox"'); expect(html).toContain("disabled"); expect(html).toContain("Nested child");
  expect(html).toContain('<ol start="3">'); expect(html).toContain("<del>old</del>");
});

test("reference links, balanced parentheses, escapes and multiline quotes follow Markdown grammar", () => {
  const html = render("[docs][d] and [nested](https://example.com/a_(b))\n\n[d]: https://example.com/docs\n\n> First\n>\n> Second\n\nSetext\n======\n\nfoo_bar_baz");
  expect(html).toContain('href="https://example.com/docs"'); expect(html).toContain('href="https://example.com/a_(b)"');
  expect((html.match(/<blockquote>/g) ?? [])).toHaveLength(1); expect(html).toContain("<h1>Setext</h1>"); expect(html).toContain("foo_bar_baz");
});

test("raw HTML and dangerous image resolver results cannot execute", () => {
  const html = render('<img src=x onerror="alert(1)">\n\n![x](image.png)', {resolveImageUrl: () => 'javascript:alert(1)'});
  expect(html).not.toContain('<img'); expect(html).toContain('&lt;img'); expect(html).toContain('markdown-alt');
});

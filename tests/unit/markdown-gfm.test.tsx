import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { headingSlug, renderMarkdown, safeUrl } from "../../src/web/markdown.tsx";

const render = (src: string) => renderToStaticMarkup(<>{renderMarkdown(src)}</>);

test("headings get GitHub-style prefixed, de-duplicated ids so in-page links work without clobbering app ids", () => {
  const html = render("# Main\n\n## Install & Run!\n\n## Install & Run!");
  expect(html).toContain('<h1 id="user-content-main">Main</h1>');
  expect(html).toContain('id="user-content-install--run"');
  expect(html).toContain('id="user-content-install--run-1"');
  expect(headingSlug("  Ünïcode Title 2 ")).toBe("ünïcode-title-2");
});

test("badges (images inside links), reference images and bare emails render like GitHub", () => {
  const html = render("[![ci](https://x.y/b.svg)](https://x.y/ci) ![logo][l] mail me@example.com.\n\n[l]: https://x.y/l.png");
  expect(html).toContain('<a href="https://x.y/ci" rel="noreferrer"><img src="https://x.y/b.svg" alt="ci"');
  expect(html).toContain('src="https://x.y/l.png"');
  expect(html).toContain('<a href="mailto:me@example.com" rel="noreferrer">me@example.com</a>.');
});

test("HTML blocks and comments stay inert text, never markup", () => {
  const html = render('<p align="center"><img src=x onerror=alert(1)></p>\n\n<!-- a\nb -->\nafter');
  expect(html).not.toContain("<img");
  expect(html).toContain("&lt;p align=&quot;center&quot;&gt;");
  expect(html).toContain("<p>after</p>");
});

test("URL safety: only http(s), mailto, irc(s), xmpp and relative URLs survive, including obfuscated schemes", () => {
  for (const ok of ["https://a.b/c", "/docs", "docs/x.md", "#anchor", "mailto:a@b.c", "?q=1"]) expect(safeUrl(ok)).toBe(ok);
  for (const bad of ["javascript:alert(1)", " JaVaScRiPt:alert(1)", "java\tscript:alert(1)", "java\nscript:x", "vbscript:x", "data:text/html,x", "\u0001javascript:x"]) {
    expect(safeUrl(bad)).toBe("");
  }
  expect(safeUrl("a b")).toBe("a%20b");
  expect(render("[x](java&#09;script:alert(1))")).not.toContain("href=");
});

test("hard breaks, entities and escapes", () => {
  expect(render("one  \ntwo\\\nthree")).toBe("<p>one<br/>two<br/>three</p>");
  expect(render("&copy; &#x1F600; &bogus; \\*lit\\*")).toBe("<p>© 😀 &amp;bogus; *lit*</p>");
});

test("hostile inputs stay fast and never overflow the stack", () => {
  const inputs = [">".repeat(5000) + " x", "[".repeat(20000), "![".repeat(20000), "*a".repeat(20000), "`a ".repeat(20000), Array.from({ length: 400 }, (_, i) => "  ".repeat(i) + "- x").join("\n")];
  for (const input of inputs) {
    const started = performance.now();
    expect(() => render(input)).not.toThrow();
    expect(performance.now() - started).toBeLessThan(2000);
  }
});

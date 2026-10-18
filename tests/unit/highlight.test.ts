import { describe, expect, test } from "bun:test";
import { HIGHLIGHT_LIMITS, highlightLines, highlightToHtml, tokenize } from "../../src/web/highlight.ts";

function spansBalanced(html: string): boolean {
  const opens = (html.match(/<span class="[^"]*">/g) ?? []).length;
  const closes = (html.match(/<\/span>/g) ?? []).length;
  return opens === closes;
}

describe("highlighter output shape", () => {
  test("produces exactly one entry per source line", () => {
    const code = "line one\nline two\nline three";
    expect(highlightLines(code, "typescript").lines).toHaveLength(3);
  });

  test("counts a trailing newline as a final empty line", () => {
    expect(highlightLines("a\nb\n", "typescript").lines).toHaveLength(3);
  });

  test("every line has balanced spans, including across a multi-line block comment", () => {
    const code = ["const a = 1;", "/* a comment", "   still a comment", "*/", "const b = 2;"].join("\n");
    const { lines } = highlightLines(code, "typescript");
    expect(lines).toHaveLength(5);
    for (const line of lines) {
      expect(spansBalanced(line)).toBe(true);
    }
    expect(lines[1]).toContain("tok-comment");
    expect(lines[2]).toContain("tok-comment");
    expect(lines[4]).not.toContain("tok-comment");
  });

  test("multi-line template literals stay strings on every line", () => {
    const code = "const q = `select *\nfrom table\nwhere x = 1`;";
    const { lines } = highlightLines(code, "typescript");
    expect(lines[0]).toContain("tok-string");
    expect(lines[1]).toContain("tok-string");
    expect(lines[1]).not.toContain("tok-keyword");
  });

  test("classifies keywords, strings, numbers and comments", () => {
    const html = highlightToHtml('const n = 42; // note\nconst s = "text";', "typescript");
    expect(html).toContain('<span class="tok-keyword">const</span>');
    expect(html).toContain('<span class="tok-number">42</span>');
    expect(html).toContain('<span class="tok-string">&quot;text&quot;</span>');
    expect(html).toContain('<span class="tok-comment">// note</span>');
  });

  test("JSON keys are distinguished from string values", () => {
    const html = highlightToHtml('{"name": "value"}', "json");
    expect(html).toContain('<span class="tok-key">&quot;name&quot;</span>');
    expect(html).toContain('<span class="tok-string">&quot;value&quot;</span>');
  });

  test("html emits tag and attribute tokens", () => {
    const html = highlightToHtml('<a href="/x">link</a>', "html");
    expect(html).toContain('<span class="tok-tag">&lt;a</span>');
    expect(html).toContain('<span class="tok-attr">href</span>');
  });

  test("identifiers followed by a paren are marked as functions", () => {
    const html = highlightToHtml("doThing(1);", "typescript");
    expect(html).toContain('<span class="tok-function">doThing</span>');
  });
});

describe("highlighter safety", () => {
  test("source HTML is escaped, never emitted as markup", () => {
    const html = highlightToHtml('<script>alert("xss")</script>', "typescript");
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  test("an unterminated block comment does not leak a span", () => {
    const { lines } = highlightLines("const a = 1;\n/* never closed", "typescript");
    for (const line of lines) expect(spansBalanced(line)).toBe(true);
  });

  test("a stray backtick does not break later lines", () => {
    const { lines } = highlightLines("const a = `;\nconst b = 2;", "typescript");
    for (const line of lines) expect(spansBalanced(line)).toBe(true);
  });

  test("escapes quotes inside attribute-free contexts", () => {
    const html = highlightToHtml(`const s = 'a > b && c < d';`, "typescript");
    expect(html).toContain("&gt;");
    expect(html).toContain("&amp;&amp;");
    expect(html).toContain("&lt;");
  });
});

describe("highlighter limits", () => {
  test("refuses to highlight past the line budget and still returns every line", () => {
    const code = Array.from({ length: HIGHLIGHT_LIMITS.maxLines + 10 }, (_, i) => `const x${i} = ${i};`).join("\n");
    const result = highlightLines(code, "typescript");
    expect(result.highlighted).toBe(false);
    expect(result.lines).toHaveLength(HIGHLIGHT_LIMITS.maxLines + 10);
    expect(result.lines[0]).not.toContain("<span");
  });

  test("refuses to highlight past the byte budget", () => {
    const code = `const a = 1; // ${"x".repeat(HIGHLIGHT_LIMITS.maxBytes)}`;
    expect(highlightLines(code, "typescript").highlighted).toBe(false);
  });

  test("custom limits are honoured", () => {
    const code = "const a = 1;\nconst b = 2;\nconst c = 3;";
    expect(highlightLines(code, "typescript", { maxLines: 2 }).highlighted).toBe(false);
    expect(highlightLines(code, "typescript", { maxLines: 3 }).highlighted).toBe(true);
  });

  test("a language with no rules is reported as unhighlighted", () => {
    const result = highlightLines("# Title", "markdown");
    expect(result.highlighted).toBe(false);
    expect(result.language).toBeNull();
  });

  test("an unknown language degrades to plain text", () => {
    const result = highlightLines("some text", "cobol");
    expect(result.highlighted).toBe(false);
    expect(result.language).toBeNull();
  });
});

describe("highlighter performance", () => {
  test("tokenizing 2,000 lines stays well within a frame budget", () => {
    const unitLines = [
      "import { thing } from './thing.ts';",
      "",
      "export function compute(input: string): number {",
      "  // a comment with 'quotes' and `backticks`",
      '  const value = { key: "value", list: [1, 2, 3] };',
      "  return value.list.length + input.length;",
      "}",
    ];
    const code = Array.from({ length: 2000 }, (_, i) => unitLines[i % unitLines.length] ?? "").join("\n");

    const started = performance.now();
    const result = highlightLines(code, "typescript");
    const elapsed = performance.now() - started;

    expect(result.highlighted).toBe(true);
    expect(result.lines).toHaveLength(2000);
    expect(elapsed).toBeLessThan(750);
  });

  test("tokenize is linear in input size", () => {
    const line = "const value = compute(1, 2) + other.thing;\n";
    const small = line.repeat(500);
    const large = line.repeat(4000);

    const timeOf = (input: string): number => {
      const started = performance.now();
      tokenize(input, "typescript");
      return performance.now() - started;
    };

    timeOf(small);
    const smallMs = Math.max(0.5, timeOf(small));
    const largeMs = timeOf(large);
    expect(largeMs / smallMs).toBeLessThan(40);
  });
});

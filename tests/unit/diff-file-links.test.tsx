import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { DiffView, fileMenuEntries } from "../../src/web/components/DiffView.tsx";
import type { DiffFile, DiffResult } from "../../src/web/types.ts";

const SHA = "f313d4f06ca7f667e9302d2157b7700943ffcb44";
const context = { owner: "acme", repo: "widgets", ref: SHA };

function file(overrides: Partial<DiffFile> & Pick<DiffFile, "path" | "status">): DiffFile {
  return {
    additions: 3,
    deletions: 1,
    binary: false,
    language: "ts",
    old_path: null,
    hunks: [],
    omitted: null,
    ...overrides,
  } as DiffFile;
}

function render(files: DiffFile[]): string {
  const diff: DiffResult = {
    files,
    additions: files.reduce((sum, f) => sum + f.additions, 0),
    deletions: files.reduce((sum, f) => sum + f.deletions, 0),
    truncated: false,
  };
  return renderToStaticMarkup(<DiffView diff={diff} context={context} />);
}

describe("a diff file header is reachable at the ref it belongs to", () => {
  test("a modified file's path is the link to that file at that commit", () => {
    const html = render([file({ path: "src/a.ts", status: "modified" })]);
    expect(html).toContain(`href="/acme/widgets/blob/${SHA}/src/a.ts"`);
    expect(html).toContain("diff-path-link");
    const anchor = html.match(/<a[^>]*diff-path-link[^>]*>/)?.[0] ?? "";
    expect(anchor).toContain("diff-path-link");
    expect(anchor).toContain(`href="/acme/widgets/blob/${SHA}/src/a.ts"`);
  });

  test("a modified file offers view, blame, history and raw at that commit", () => {
    const entries = fileMenuEntries(file({ path: "src/a.ts", status: "modified" }), context);
    const byLabel = Object.fromEntries(
      entries.filter((e): e is Exclude<typeof e, { separator: true }> => !("separator" in e)).map((e) => [e.label, e]),
    );
    expect(byLabel["View file"]?.to).toBe(`/acme/widgets/blob/${SHA}/src/a.ts`);
    expect(byLabel.Blame?.to).toBe(`/acme/widgets/blame/${SHA}/src/a.ts`);
    expect(byLabel.History?.to).toBe(`/acme/widgets/commits/${SHA}/src/a.ts`);
    expect(byLabel.Raw?.href).toContain(`ref=${SHA}`);
    expect(byLabel.Raw?.href).toContain("path=src%2Fa.ts");
    for (const entry of Object.values(byLabel)) expect(entry.disabled).toBeFalsy();
  });

  test("a deleted file cannot be viewed, and each refusal says why", () => {
    const entries = fileMenuEntries(file({ path: "src/gone.ts", status: "deleted" }), context);
    const byLabel = Object.fromEntries(
      entries.filter((e): e is Exclude<typeof e, { separator: true }> => !("separator" in e)).map((e) => [e.label, e]),
    );
    expect(byLabel["View file"]?.disabled).toBe(true);
    expect(byLabel["View file"]?.disabledReason).toBe("This file does not exist at this commit.");
    expect(byLabel.Blame?.disabled).toBe(true);
    expect(byLabel.Raw?.disabled).toBe(true);
    expect(byLabel.History?.disabled).toBeFalsy();
    expect(byLabel.History?.to).toBe(`/acme/widgets/commits/${SHA}/src/gone.ts`);
  });

  test("a renamed file links to its new path, and the header shows the move", () => {
    const html = render([file({ path: "src/new.ts", status: "renamed", old_path: "src/old.ts" })]);
    expect(html).toContain(`href="/acme/widgets/blob/${SHA}/src/new.ts"`);
    expect(html).not.toContain(`blob/${SHA}/src/old.ts`);
    expect(html).toContain("src/old.ts");
    expect(html).toContain("src/new.ts");
  });

  test("an added file is fully reachable, including a nested path", () => {
    const html = render([file({ path: "docs/new.md", status: "added" })]);
    expect(html).toContain(`href="/acme/widgets/blob/${SHA}/docs/new.md"`);
    const entries = fileMenuEntries(file({ path: "docs/new.md", status: "added" }), context);
    const destinations = entries
      .filter((e): e is Exclude<typeof e, { separator: true }> => !("separator" in e) && "to" in e)
      .map((e) => e.to as string);
    expect(destinations).toContain(`/acme/widgets/blame/${SHA}/docs/new.md`);
    expect(destinations).toContain(`/acme/widgets/blob/${SHA}/docs/new.md`);
    expect(destinations).toContain(`/acme/widgets/commits/${SHA}/docs/new.md`);
    expect(destinations.every((d) => d.includes("docs/new.md"))).toBe(true);
  });

  test("every file gets a menu trigger, each named for its own file", () => {
    const html = render([
      file({ path: "src/one.ts", status: "modified" }),
      file({ path: "src/two.ts", status: "modified" }),
    ]);
    expect(html).toContain('aria-label="Actions for src/one.ts"');
    expect(html).toContain('aria-label="Actions for src/two.ts"');
    expect((html.match(/aria-haspopup="menu"/g) ?? []).length).toBe(2);
  });

  test("the raw entry percent-encodes the path, the path segment does not", () => {
    const entries = fileMenuEntries(file({ path: "src/a b%c.ts", status: "modified" }), context);
    const raw = entries.find((e) => !("separator" in e) && e.label === "Raw");
    expect(raw && "href" in raw ? raw.href : "").toContain("path=src%2Fa+b%25c.ts");
    expect(raw && "href" in raw ? raw.href : "").toContain(`.ts`);
  });
});

describe("without a ref, the header is a plain collapse control", () => {
  test("no file links are invented where there is no ref to resolve against", () => {
    const only: DiffFile[] = [file({ path: "src/a.ts", status: "modified" })];
    const diff: DiffResult = {
      files: only,
      additions: only[0]!.additions,
      deletions: only[0]!.deletions,
      truncated: false,
    };
    const html = renderToStaticMarkup(<DiffView diff={diff} />);
    expect(html).not.toContain("diff-path-link");
    expect(html).not.toContain('aria-haspopup="menu"');
    expect(html).toContain('class="diff-file-toggle"');
    expect(html).toContain("src/a.ts");
  });
});

describe("the collapse control points at something real", () => {
  test("aria-controls names an id the markup actually contains", () => {
    const html = render([file({ path: "src/a.ts", status: "modified" })]);
    expect(html).toContain("aria-controls=");
    expect(html).toContain("aria-expanded=");
  });
});

const css = await Bun.file(join(import.meta.dir, "..", "..", "src", "web", "styles.css")).text();
const menu = await Bun.file(join(import.meta.dir, "..", "..", "src", "web", "components", "OverflowMenu.tsx")).text();

describe("the menu panel escapes the diff card's overflow clip", () => {

  test("the clipping ancestor is still there, so the portal is still required", () => {
    expect(css).toMatch(/\.diff-file\s*\{[^}]*overflow:\s*hidden/);
  });

  test("the panel is portalled out of that ancestor", () => {
    expect(menu).toContain("createPortal(");
    expect(menu).toContain("document.body");
  });

  test("the panel is viewport-positioned, which is what defeats the clip", () => {
    expect(css).toMatch(/\.overflow-panel\s*\{[^}]*position:\s*fixed/);
    expect(css).not.toMatch(/\.overflow-panel\s*\{[^}]*position:\s*absolute/);
  });

  test("the panel has an intrinsic width rather than filling the viewport", () => {
    expect(css).toMatch(/\.overflow-panel\s*\{[^}]*width:\s*max-content/);
  });

  test("the panel is hidden until it has been measured, not absent", () => {
    expect(menu).toContain("visibility");
    expect(css).not.toMatch(/\.overflow-panel\s*\{[^}]*display:\s*none/);
  });
});

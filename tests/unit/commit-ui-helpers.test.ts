import { describe, expect, test } from "bun:test";
import { groupCommitsByDay, hueFromString } from "../../src/web/components/CommitHistory.tsx";
import { imageDiffSides, isLfsPointerDiff, isPreviewableImage } from "../../src/web/components/ImageDiff.tsx";
import { initialCollapsedFiles } from "../../src/web/diff-utils.ts";
import { splitBatchOutput } from "../../src/lfs/usage.ts";
import type { Commit, DiffFile } from "../../src/web/types.ts";

function commit(sha: string, at: Date): Commit {
  return { sha, short_sha: sha.slice(0, 7), message: sha, author: { name: "a", email: "a@x" }, authored_at: at.getTime(), parents: [] };
}

function file(overrides: Partial<DiffFile> & Pick<DiffFile, "path" | "status">): DiffFile {
  return { old_path: null, binary: false, additions: 1, deletions: 1, omitted: null, language: null, hunks: [], ...overrides };
}

const pointerHunk = (oidOld: string, oidNew: string) => ({
  header: "@@ -1,3 +1,3 @@",
  old_start: 1,
  new_start: 1,
  lines: [
    { kind: "context" as const, text: "version https://git-lfs.github.com/spec/v1", old_line: 1, new_line: 1 },
    { kind: "del" as const, text: `oid sha256:${oidOld}`, old_line: 2, new_line: null },
    { kind: "add" as const, text: `oid sha256:${oidNew}`, old_line: null, new_line: 2 },
    { kind: "context" as const, text: "size 584", old_line: 3, new_line: 3 },
  ],
});

describe("commit history grouping", () => {
  test("consecutive commits on one local day share a group, in input order", () => {
    const groups = groupCommitsByDay(
      [commit("c3", new Date(2026, 9, 13, 18)), commit("c2", new Date(2026, 9, 13, 9)), commit("c1", new Date(2026, 9, 12, 23))],
      "en-US",
    );
    expect(groups.map((g) => g.key)).toEqual(["2026-10-13", "2026-10-12"]);
    expect(groups[0]!.commits.map((c) => c.sha)).toEqual(["c3", "c2"]);
    expect(groups[0]!.label).toBe("Oct 13, 2026");
  });

  test("a commit out of date order starts a new group rather than being moved", () => {
    const groups = groupCommitsByDay([
      commit("a", new Date(2026, 9, 13)),
      commit("b", new Date(2026, 9, 11)),
      commit("c", new Date(2026, 9, 13)),
    ]);
    expect(groups.map((g) => g.commits.map((c) => c.sha))).toEqual([["a"], ["b"], ["c"]]);
  });

  test("empty input yields no groups, and hues are stable per author", () => {
    expect(groupCommitsByDay([])).toEqual([]);
    expect(hueFromString("dev@example.com")).toBe(hueFromString("dev@example.com"));
    expect(hueFromString("x")).toBeGreaterThanOrEqual(0);
    expect(hueFromString("x")).toBeLessThan(360);
  });
});

describe("image diff decisions", () => {
  test("image extensions are recognised case-insensitively, others are not", () => {
    for (const path of ["a.png", "b/C.JPG", "d.webp", "icon.svg", "x.avif"]) expect(isPreviewableImage(path)).toBe(true);
    for (const path of ["a.ts", "png", "a.", "notes.pngx", "Makefile"]) expect(isPreviewableImage(path)).toBe(false);
  });

  test("a diff of only pointer lines is recognised as LFS churn", () => {
    expect(isLfsPointerDiff(file({ path: "a.png", status: "modified", hunks: [pointerHunk("a".repeat(64), "b".repeat(64))] }))).toBe(true);
  });

  test("real text changes are never mistaken for an LFS pointer", () => {
    const hunk = pointerHunk("a".repeat(64), "b".repeat(64));
    hunk.lines.push({ kind: "add", text: "console.log('hi')", old_line: null, new_line: 4 });
    expect(isLfsPointerDiff(file({ path: "a.png", status: "modified", hunks: [hunk] }))).toBe(false);
    expect(isLfsPointerDiff(file({ path: "a.png", status: "modified", hunks: [] }))).toBe(false);
  });

  test("sides follow the file status and the presence of a parent", () => {
    const sha = "f".repeat(40);
    const parent = "e".repeat(40);
    expect(imageDiffSides(file({ path: "a.png", status: "modified" }), sha, parent)).toEqual({
      before: { ref: parent, path: "a.png" },
      after: { ref: sha, path: "a.png" },
    });
    expect(imageDiffSides(file({ path: "a.png", status: "added" }), sha, parent).before).toBeNull();
    expect(imageDiffSides(file({ path: "a.png", status: "deleted" }), sha, parent).after).toBeNull();
    expect(imageDiffSides(file({ path: "new.png", old_path: "old.png", status: "renamed" }), sha, parent).before).toEqual({
      ref: parent,
      path: "old.png",
    });
    expect(imageDiffSides(file({ path: "a.png", status: "modified" }), sha, null).before).toBeNull();
  });

  test("previewable binaries stay open, other binaries still collapse", () => {
    const files = [
      file({ path: "logo.png", status: "modified", binary: true, omitted: "binary" }),
      file({ path: "blob.bin", status: "modified", binary: true, omitted: "binary" }),
    ];
    const collapsed = initialCollapsedFiles(files, (f) => isPreviewableImage(f.path));
    expect(collapsed.has("logo.png")).toBe(false);
    expect(collapsed.has("blob.bin")).toBe(true);
    expect(initialCollapsedFiles(files).has("logo.png")).toBe(true);
  });
});

describe("cat-file --batch parsing", () => {
  const enc = new TextEncoder();
  test("records are split by declared size, so content may contain newlines", () => {
    const a = "line one\nline two";
    const b = "x";
    const output = enc.encode(`${"1".repeat(40)} blob ${a.length}\n${a}\n${"2".repeat(40)} blob ${b.length}\n${b}\n`);
    expect(splitBatchOutput(output).map((r) => new TextDecoder().decode(r))).toEqual([a, b]);
  });

  test("missing objects are skipped and truncated output stops cleanly", () => {
    const output = enc.encode(`${"3".repeat(40)} missing\n${"4".repeat(40)} blob 3\nabc\n${"5".repeat(40)} blob 99\nshort`);
    expect(splitBatchOutput(output).map((r) => new TextDecoder().decode(r))).toEqual(["abc"]);
  });
});

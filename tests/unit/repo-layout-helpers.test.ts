import { describe, expect, test } from "bun:test";
import { languageBreakdown, languageFor, parseTreeListing } from "../../src/git/tree-index.ts";
import { fuzzyScore, rankPaths } from "../../src/web/components/FileFinder.tsx";
import { threadStateIcon } from "../../src/web/components/ThreadRow.tsx";

const enc = new TextEncoder();
const record = (mode: string, type: string, size: string, path: string) =>
  `${mode} ${type} ${"a".repeat(40)} ${size.padStart(7)}\t${path}\0`;

describe("ls-tree -r -l -z parsing", () => {
  test("blobs are listed with sizes; trees, submodules and symlinks are not", () => {
    const out = enc.encode(
      record("100644", "blob", "120", "src/a.ts") +
        record("100755", "blob", "9", "run.sh") +
        record("120000", "blob", "11", "link") +
        record("160000", "commit", "-", "vendor/sub") +
        record("100644", "blob", "5", "dir with space/é.md"),
    );
    const index = parseTreeListing(out, 10);
    expect(index.files).toEqual([
      { path: "src/a.ts", size: 120 },
      { path: "run.sh", size: 9 },
      { path: "dir with space/é.md", size: 5 },
    ]);
    expect(index.total).toBe(3);
    expect(index.truncated).toBe(false);
  });

  test("the cap keeps the first N files and reports the true total", () => {
    const out = enc.encode([1, 2, 3, 4].map((n) => record("100644", "blob", "1", `f${n}`)).join(""));
    const index = parseTreeListing(out, 2);
    expect(index.files.map((f) => f.path)).toEqual(["f1", "f2"]);
    expect(index.total).toBe(4);
    expect(index.truncated).toBe(true);
  });
});

describe("language breakdown", () => {
  test("bytes are attributed by extension and special file names", () => {
    expect(languageFor("src/app.tsx")?.name).toBe("TypeScript");
    expect(languageFor("Dockerfile")?.name).toBe("Dockerfile");
    expect(languageFor("tools/CMakeLists.txt")?.name).toBe("CMake");
    expect(languageFor("assets/model.glb")).toBeNull();
    expect(languageFor("README.md")).toBeNull();
  });

  test("vendored, generated and lockfile paths do not count", () => {
    for (const path of ["node_modules/x/index.js", "vendor/lib.go", "dist/app.js", "a/b.min.js", "package-lock.json", "build/out.c"]) {
      expect(languageFor(path), path).toBeNull();
    }
  });

  test("shares sum to ~100, are sorted, and tiny languages fold into Other", () => {
    const shares = languageBreakdown([
      { path: "a.ts", size: 9_000 },
      { path: "b.rs", size: 990 },
      { path: "c.sh", size: 5 },
      { path: "d.py", size: 5 },
      { path: "image.png", size: 1_000_000 },
    ]);
    expect(shares.map((s) => s.name)).toEqual(["TypeScript", "Rust", "Other"]);
    expect(shares[0]!.percent).toBe(90);
    const sum = shares.reduce((total, s) => total + s.percent, 0);
    expect(sum).toBeGreaterThan(99.8);
    expect(sum).toBeLessThan(100.2);
    expect(languageBreakdown([{ path: "x.png", size: 10 }])).toEqual([]);
  });
});

describe("Go to file matching", () => {
  test("subsequence matches only, with match positions", () => {
    expect(fuzzyScore("src/module-17/file-297.ts", "mod17fil29")?.positions.length).toBe(10);
    expect(fuzzyScore("src/app.ts", "xyz")).toBeNull();
    expect(fuzzyScore("README.md", "")).toEqual({ score: 0, positions: [] });
  });

  test("file-name and segment-start matches outrank scattered ones", () => {
    const ranked = rankPaths(["docs/api/readme-old.md", "src/server/app.ts", "test/fixtures/src/app.ts", "a/p/p.txt"], "app");
    expect(ranked[0]!.path).toBe("src/server/app.ts");
    expect(ranked.map((r) => r.path)).toContain("test/fixtures/src/app.ts");
  });

  test("results are capped and an empty query lists files in order", () => {
    const paths = Array.from({ length: 500 }, (_, i) => `f/${i}.ts`);
    expect(rankPaths(paths, "ts").length).toBe(50);
    expect(rankPaths(paths, "  ").map((r) => r.path).slice(0, 2)).toEqual(["f/0.ts", "f/1.ts"]);
  });
});

describe("thread state icons", () => {
  test("issues and pull requests map to GitHub's states", () => {
    expect(threadStateIcon("issue", "open").tone).toBe("is-open");
    expect(threadStateIcon("issue", "closed").icon).toBe("issueClosed");
    expect(threadStateIcon("pull", "merged")).toMatchObject({ icon: "pullMerged", tone: "is-done" });
    expect(threadStateIcon("pull", "closed")).toMatchObject({ icon: "pullClosed", tone: "is-closed" });
    expect(threadStateIcon("pull", "open").icon).toBe("pull");
  });
});

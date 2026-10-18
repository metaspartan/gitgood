import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..", "..");

const PROTECTED = ["src", "types"] as const;

function git(args: string[]): string | null {
  try {
    return execFileSync("git", args, { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return null;
  }
}

const hasRepository = git(["rev-parse", "--is-inside-work-tree"])?.trim() === "true";

function walkFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === ".git") continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walkFiles(full, out);
    else out.push(full);
  }
  return out;
}

function walkDirectories(prefix: string, out: string[] = []): string[] {
  const absolute = join(ROOT, prefix);
  if (!existsSync(absolute)) return out;
  for (const entry of readdirSync(absolute, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === "node_modules" || entry.name === ".git") continue;
    const rel = `${prefix}/${entry.name}`;
    out.push(rel);
    walkDirectories(rel, out);
  }
  return out;
}

function gitPath(absolute: string): string {
  return absolute.slice(ROOT.length + 1).split("\\").join("/");
}

describe("repository completeness", () => {
  test.skipIf(!hasRepository)("every file in a protected tree is tracked", () => {
    const tracked = new Set(
      (git(["ls-files"]) ?? "")
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean),
    );

    const untracked: string[] = [];
    let scanned = 0;

    for (const tree of PROTECTED) {
      const absolute = join(ROOT, tree);
      if (!existsSync(absolute) || !statSync(absolute).isDirectory()) continue;
      for (const file of walkFiles(absolute)) {
        scanned += 1;
        const rel = gitPath(file);
        if (!tracked.has(rel)) untracked.push(rel);
      }
    }

    expect(scanned).toBeGreaterThan(20);
    expect(
      untracked.length === 0
        ? ""
        : `${untracked.length} file(s) under ${PROTECTED.join(" or ")} are not tracked, so a fresh clone would not have them:\n` +
          `${untracked.join("\n")}\n\n` +
          "Run `git add`, or - if the file is genuinely generated - add an anchored ignore rule\n" +
          "and the path to the ignored-but-deliberate list in this test.",
    ).toBe("");
  });

  test.skipIf(!hasRepository)("no ignore rule shadows a directory inside a protected tree", () => {
    const ignorePath = join(ROOT, ".gitignore");
    expect(existsSync(ignorePath)).toBe(true);

    const floatingRules = readFileSync(ignorePath, "utf8")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith("#") && !line.startsWith("!"))
      .filter((rule) => rule.endsWith("/") && !rule.startsWith("/"))
      .map((rule) => rule.replace(/\/$/, ""));

    const directories = PROTECTED.flatMap((tree) => walkDirectories(tree));
    const shadowed: string[] = [];

    for (const rule of floatingRules) {
      for (const directory of directories) {
        const base = directory.slice(directory.lastIndexOf("/") + 1);
        if (base === rule) shadowed.push(`${directory}  (swallowed by the floating rule "${rule}/")`);
      }
    }

    expect(
      shadowed.length === 0
        ? ""
        : `A floating ignore rule matches a directory inside ${PROTECTED.join(" or ")}:\n` +
          `${shadowed.join("\n")}\n\n` +
          'Anchor it with a leading slash: "/data/" instead of "data/".',
    ).toBe("");
  });
});

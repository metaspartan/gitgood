import { expect, test } from "bun:test";
import { parseUnifiedDiff } from "../../src/git/diff.ts";

const patch = [
  "diff --git a/src/app.ts b/src/app.ts",
  "index 1111111..2222222 100644",
  "--- a/src/app.ts",
  "+++ b/src/app.ts",
  "@@ -62,6 +62,7 @@ import {",
  " a",
  " b",
  " c",
  "+inserted",
  " d",
  " e",
  " f",
  "@@ -154,6 +155,5 @@ function x()",
  " g",
  "-removed one",
  "-removed two",
  "+replacement",
  " h",
  " i",
  " j",
  "",
].join("\n");

test("diff line numbers follow each hunk's own old and new cursors", () => {
  const [file] = parseUnifiedDiff(patch).files;
  const numbers = file!.hunks.map((hunk) => hunk.lines.map((line) => [line.kind, line.oldLine, line.newLine]));
  expect(numbers[0]).toEqual([
    ["context", 62, 62],
    ["context", 63, 63],
    ["context", 64, 64],
    ["add", null, 65],
    ["context", 65, 66],
    ["context", 66, 67],
    ["context", 67, 68],
  ]);
  expect(numbers[1]).toEqual([
    ["context", 154, 155],
    ["del", 155, null],
    ["del", 156, null],
    ["add", null, 156],
    ["context", 157, 157],
    ["context", 158, 158],
    ["context", 159, 159],
  ]);
  expect(file!.additions).toBe(2);
  expect(file!.deletions).toBe(2);
});

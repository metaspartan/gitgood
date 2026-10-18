import { expect, test } from "bun:test";
import { joinRepoPath } from "../../src/web/repo-path.ts";

test("joinRepoPath folds dot segments textually and cannot climb above the root", () => {
  expect(joinRepoPath("docs", "img.png")).toBe("docs/img.png");
  expect(joinRepoPath("docs/deep", "../img.png")).toBe("docs/img.png");
  expect(joinRepoPath("", "img.png")).toBe("img.png");
  expect(joinRepoPath("docs", "./img.png")).toBe("docs/img.png");
  expect(joinRepoPath("a", "../../../etc/passwd")).toBe("etc/passwd");
});

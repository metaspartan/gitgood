import { expect, test } from "bun:test";
import { branchFromTail } from "../../src/web/components/ComparePrompt.tsx";
test("a tree/blob route tail resolves to the branch it starts with, longest name first", () => {
  const branches = ["main", "feature", "feature/x", "release"];
  expect(branchFromTail("feature/x/models/a.glb", branches)).toBe("feature/x");
  expect(branchFromTail("feature/readme.md", branches)).toBe("feature");
  expect(branchFromTail("release", branches)).toBe("release");
  expect(branchFromTail("main/src", branches)).toBe("main");
  expect(branchFromTail("f313d4f06ca7f667e9302d2157b7700943ffcb44/src", branches)).toBeNull();
  expect(branchFromTail("mainline/x", branches)).toBeNull();
});

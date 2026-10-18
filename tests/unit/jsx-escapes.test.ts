import { expect, test } from "bun:test";
import { Glob } from "bun";
import { join } from "node:path";

const root = join(import.meta.dir, "..", "..", "src", "web");

test("JSX text and attribute strings contain no literal \\u escapes, which React would render verbatim", async () => {
  const offenders: string[] = [];
  for (const file of new Glob("**/*.tsx").scanSync(root)) {
    const lines = (await Bun.file(join(root, file)).text()).split("\n");
    lines.forEach((line, index) => {
      if (/>[^<>{}`"]*\\u[0-9a-fA-F]{4}[^<>{}`]*</.test(line) || /\s[a-zA-Z-]+="[^"{}]*\\u[0-9a-fA-F]{4}[^"]*"/.test(line)) {
        offenders.push(`${file}:${index + 1}: ${line.trim().slice(0, 100)}`);
      }
    });
  }
  expect(offenders).toEqual([]);
});

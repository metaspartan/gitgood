import { expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const distDir = join(import.meta.dir, "..", "..", "dist", "web");

function bundle(): string {
  let text = "";
  for (const entry of readdirSync(distDir)) {
    if (entry.endsWith(".js")) text += readFileSync(join(distDir, entry), "utf8");
  }
  return text;
}

test("the production bundle does not leave NODE_ENV unresolved", () => {
  expect(readdirSync(distDir).some((entry) => entry.endsWith(".js"))).toBe(true);
  const source = bundle();
  expect(source.length).toBeGreaterThan(0);
  expect(
    source.includes("process.env.NODE_ENV"),
    "process.env.NODE_ENV survived the build, so React is running in development mode and StrictMode is doubling every effect",
  ).toBe(false);
});

test("the production bundle does not ship React's development-only warnings", () => {
  const source = bundle();
  expect(source.includes("Warning: React")).toBe(false);
  expect(source.includes("act(...)")).toBe(false);
});

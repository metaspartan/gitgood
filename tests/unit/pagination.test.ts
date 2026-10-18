import { describe, expect, test } from "bun:test";
import { parsePage } from "../../src/lib/pagination.ts";

describe("page parsing", () => {
  test("defaults are bounded and sane", () => {
    const page = parsePage(new URL("http://x/api/repos"));
    expect(page.page).toBe(1);
    expect(page.offset).toBe(0);
    expect(page.perPage).toBeGreaterThan(0);
    expect(page.perPage).toBeLessThanOrEqual(100);
  });

  test("per_page is honoured within a ceiling", () => {
    expect(parsePage(new URL("http://x/api/repos?per_page=25")).perPage).toBe(25);
    expect(parsePage(new URL("http://x/api/repos?per_page=100000")).perPage).toBeLessThanOrEqual(100);
  });

  test("offset is derived from the page rather than supplied separately", () => {
    const first = parsePage(new URL("http://x/api/repos?page=1&per_page=10"));
    const third = parsePage(new URL("http://x/api/repos?page=3&per_page=10"));
    expect(first.offset).toBe(0);
    expect(third.offset).toBe(20);
  });

  test("garbage input falls back rather than throwing", () => {
    for (const q of ["?page=abc", "?page=-5", "?page=0", "?per_page=abc", "?per_page=-1"]) {
      const page = parsePage(new URL("http://x/api/repos" + q));
      expect(Number.isInteger(page.page)).toBe(true);
      expect(page.page).toBeGreaterThanOrEqual(1);
      expect(Number.isInteger(page.perPage)).toBe(true);
      expect(page.perPage).toBeGreaterThanOrEqual(1);
      expect(page.offset).toBeGreaterThanOrEqual(0);
    }
  });

  test("a fractional page is treated as an integer", () => {
    const page = parsePage(new URL("http://x/api/repos?page=2.9&per_page=10"));
    expect(Number.isInteger(page.page)).toBe(true);
    expect(Number.isInteger(page.offset)).toBe(true);
  });
});

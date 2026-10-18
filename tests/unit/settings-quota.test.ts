import { expect, test } from "bun:test";
import { parseQuotaInput, MAX_QUOTA_BYTES } from "../../src/web/quota-input.ts";

test("quota distinguishes inherited, unlimited and exact byte counts", () => {
  expect(parseQuotaInput("")).toBeNull(); expect(parseQuotaInput("  ")).toBeNull();
  expect(parseQuotaInput("0")).toBe(0); expect(parseQuotaInput(" 1024 ")).toBe(1024);
  for (const value of [MAX_QUOTA_BYTES - 1, MAX_QUOTA_BYTES]) expect(parseQuotaInput(String(value))).toBe(value);
  expect(() => parseQuotaInput(String(MAX_QUOTA_BYTES + 1))).toThrow();
});
test("partial and ambiguous quota strings are never silently truncated", () => {
  for (const value of ["10GB", "1.5", "1e6", "-1", "+1", "1,000", "Infinity", "NaN", "0x10", "9007199254740993"])
    expect(() => parseQuotaInput(value)).toThrow();
});

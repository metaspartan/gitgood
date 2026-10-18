import { describe, expect, test } from "bun:test";
import {
  array,
  boolean,
  enumOf,
  nullable,
  number,
  object,
  optional,
  strictObject,
  string,
  toInt,
  withDefault,
} from "../../src/lib/validate.ts";
import { AppError } from "../../src/lib/errors.ts";

describe("validators", () => {
  test("string trims, enforces length and reports the path", () => {
    const schema = string({ min: 2, max: 4 });
    expect(schema.parse("  abc  ", "body.name")).toBe("abc");
    expect(() => schema.parse("a", "body.name")).toThrow(AppError);
    try {
      schema.parse("toolong", "body.name");
    } catch (error) {
      expect(error).toBeInstanceOf(AppError);
      expect((error as AppError).details?.path).toBe("body.name");
    }
  });

  test("number coerces numeric strings and rejects NaN", () => {
    expect(number({ int: true }).parse("42", "n")).toBe(42);
    expect(() => number({ min: 5 }).parse(3, "n")).toThrow(AppError);
    expect(() => number().parse("abc", "n")).toThrow(AppError);
  });

  test("boolean accepts the common string forms", () => {
    expect(boolean().parse("true", "b")).toBe(true);
    expect(boolean().parse("0", "b")).toBe(false);
    expect(() => boolean().parse("maybe", "b")).toThrow(AppError);
  });

  test("enumOf is exhaustive", () => {
    const schema = enumOf(["open", "closed"] as const);
    expect(schema.parse("open", "state")).toBe("open");
    expect(() => schema.parse("merged", "state")).toThrow(AppError);
  });

  test("object infers optional keys and fills defaults", () => {
    const schema = object({
      title: string({ min: 1 }),
      body: optional(string()),
      per_page: withDefault(number({ int: true, min: 1 }), 30),
    });
    const value = schema.parse({ title: "hello" }, "body");
    expect(value.title).toBe("hello");
    expect(value.body).toBeUndefined();
    expect(value.per_page).toBe(30);
  });

  test("strictObject accepts known fields and rejects unknown ones", () => {
    const strict = strictObject({ name: string() });
    expect(strict.parse({ name: "x" }, "body").name).toBe("x");
    expect(() => strict.parse({ name: "x", extra: true }, "body")).toThrow(AppError);
    expect(() => strict.parse([], "body")).toThrow(AppError);
  });

  test("array enforces max length and element type", () => {
    const schema = array(string(), { max: 2 });
    expect(schema.parse(["a", "b"], "a")).toEqual(["a", "b"]);
    expect(() => schema.parse(["a", "b", "c"], "a")).toThrow(AppError);
    expect(() => schema.parse("nope", "a")).toThrow(AppError);
  });

  test("toInt clamps and falls back", () => {
    expect(toInt(null, 7)).toBe(7);
    expect(toInt("abc", 7)).toBe(7);
    expect(toInt("9999", 7, 1, 100)).toBe(100);
  });
});

test("nullable passes an explicit null through, and optional alone would not", () => {
  expect(nullable(string({ min: 1 })).parse(null, "due")).toBeNull();
  expect(nullable(string({ min: 1 })).parse("x", "due")).toBe("x");
  expect(nullable(string({ min: 1 })).parse(undefined, "due")).toBeUndefined();

  expect(optional(string({ min: 1 })).parse(null, "due")).toBeUndefined();
  expect(() => object({ due: optional(nullable(string({ min: 1 }))) }).parse({ due: null }, "")).not.toThrow();
  const schema = object({ due: nullable(string({ min: 1 })) });
  const parsed = schema.parse({ due: null }, "");
  expect(parsed.due).toBeNull();
});

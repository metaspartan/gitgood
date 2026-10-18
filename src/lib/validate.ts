import { badRequest } from "./errors.ts";

export interface Validator<T> {
  readonly out: T;
  parse(value: unknown, path: string): T;
}

export type Infer<V> = V extends Validator<infer T> ? T : never;

function fail(path: string, message: string): never {
  throw badRequest(`Invalid input at ${path || "<root>"}: ${message}`, { path });
}

export function string(options?: {
  min?: number;
  max?: number;
  pattern?: RegExp;
  trim?: boolean;
}): Validator<string> {
  return {
    out: "",
    parse(value, path) {
      if (typeof value !== "string") fail(path, "expected a string");
      const result = options?.trim === false ? value : value.trim();
      if (options?.min !== undefined && result.length < options.min) {
        fail(path, `must be at least ${options.min} characters`);
      }
      if (options?.max !== undefined && result.length > options.max) {
        fail(path, `must be at most ${options.max} characters`);
      }
      if (options?.pattern && !options.pattern.test(result)) {
        fail(path, `does not match the required format`);
      }
      return result;
    },
  };
}

export function number(options?: { int?: boolean; min?: number; max?: number }): Validator<number> {
  return {
    out: 0,
    parse(value, path) {
      const parsed = typeof value === "string" ? Number(value) : value;
      if (typeof parsed !== "number" || !Number.isFinite(parsed)) {
        fail(path, "expected a finite number");
      }
      if (options?.int && !Number.isInteger(parsed)) fail(path, "expected an integer");
      if (options?.min !== undefined && parsed < options.min) {
        fail(path, `must be >= ${options.min}`);
      }
      if (options?.max !== undefined && parsed > options.max) {
        fail(path, `must be <= ${options.max}`);
      }
      return parsed;
    },
  };
}

export function boolean(): Validator<boolean> {
  return {
    out: false,
    parse(value, path) {
      if (typeof value === "boolean") return value;
      if (value === "true" || value === "1" || value === 1) return true;
      if (value === "false" || value === "0" || value === 0) return false;
      fail(path, "expected a boolean");
    },
  };
}

export function literal<T extends string | number | boolean | null>(expected: T): Validator<T> {
  return {
    out: expected,
    parse(value, path) {
      if (value !== expected) fail(path, `expected ${JSON.stringify(expected)}`);
      return expected;
    },
  };
}

export function enumOf<const T extends readonly string[]>(values: T): Validator<T[number]> {
  const allowed = new Set<string>(values);
  return {
    out: values[0] as T[number],
    parse(value, path) {
      if (typeof value !== "string" || !allowed.has(value)) {
        fail(path, `expected one of ${values.join(", ")}`);
      }
      return value as T[number];
    },
  };
}

export function array<I extends Validator<unknown>>(
  inner: I,
  options?: { max?: number },
): Validator<Infer<I>[]> {
  return {
    out: [] as Infer<I>[],
    parse(value, path) {
      if (!Array.isArray(value)) fail(path, "expected an array");
      if (options?.max !== undefined && value.length > options.max) {
        fail(path, `must contain at most ${options.max} items`);
      }
      return value.map((item, index) => inner.parse(item, `${path}[${index}]`)) as Infer<I>[];
    },
  };
}

export function optional<V extends Validator<unknown>>(
  inner: V,
): Validator<Infer<V> | undefined> {
  return {
    out: undefined as Infer<V> | undefined,
    parse(value, path) {
      if (value === undefined || value === null) return undefined;
      return inner.parse(value, path) as Infer<V> | undefined;
    },
  };
}

export function withDefault<V extends Validator<unknown>>(
  inner: V,
  fallback: Infer<V>,
): Validator<Infer<V>> {
  return {
    out: fallback,
    parse(value, path) {
      if (value === undefined || value === null) return fallback;
      return inner.parse(value, path) as Infer<V>;
    },
  };
}

export function nullable<V extends Validator<unknown>>(inner: V): Validator<Infer<V> | null> {
  return {
    out: null,
    parse(value, path) {
      if (value === null) return null;
      if (value === undefined) return undefined as Infer<V>;
      return inner.parse(value, path) as Infer<V>;
    },
  };
}

type Shape = Record<string, Validator<unknown>>;
type RequiredKeys<S extends Shape> = {
  [K in keyof S]: undefined extends Infer<S[K]> ? never : K;
}[keyof S];
type OptionalKeys<S extends Shape> = Exclude<keyof S, RequiredKeys<S>>;

export type ObjectOutput<S extends Shape> = {
  [K in RequiredKeys<S>]: Infer<S[K]>;
} & {
  [K in OptionalKeys<S>]?: Exclude<Infer<S[K]>, undefined>;
};

export function object<S extends Shape>(shape: S): Validator<ObjectOutput<S>> {
  const keys = Object.keys(shape);
  return {
    out: {} as ObjectOutput<S>,
    parse(value, path) {
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        fail(path, "expected an object");
      }
      const record = value as Record<string, unknown>;
      const result: Record<string, unknown> = {};
      for (const key of keys) {
        const validator = shape[key];
        if (!validator) continue;
        result[key] = validator.parse(record[key], `${path}.${key}`);
      }
      return result as ObjectOutput<S>;
    },
  };
}

export function strictObject<S extends Shape>(shape: S): Validator<ObjectOutput<S>> {
  const base = object(shape);
  const allowed = new Set(Object.keys(shape));
  return {
    out: base.out,
    parse(value, path) {
      const parsed = base.parse(value, path);
      if (typeof value === "object" && value !== null) {
        for (const key of Object.keys(value)) {
          if (!allowed.has(key)) fail(path, `unexpected field "${key}"`);
        }
      }
      return parsed;
    },
  };
}

export function toInt(value: string | null, fallback: number, min = 1, max = 1000): number {
  if (value === null || value === "") return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
}

export function union<V extends readonly Validator<unknown>[]>(
  variants: V,
): Validator<V[number] extends Validator<infer O> ? O : never> {
  return {
    parse(input: unknown, path: string): never {
      const errors: string[] = [];
      for (const variant of variants) {
        try {
          // @ts-expect-error the variants disagree on output type by design
          return variant.parse(input, path);
        } catch (error) {
          errors.push(error instanceof Error ? error.message : String(error));
        }
      }
      throw badRequest(errors[0] ?? `${path} matched no variant`);
    },
  } as unknown as Validator<V[number] extends Validator<infer O> ? O : never>;
}

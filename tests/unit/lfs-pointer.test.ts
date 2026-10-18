import { describe, expect, test } from "bun:test";
import { parseLfsPointer } from "../../src/lfs/pointer.ts";
import { classifyBlob, contentTypeForBlob } from "../../src/lib/file-types.ts";

const OID = "2755d5887a778620b5ecaca9cf7b067ffebbc1a2b3c4d5e6f708192a3b4c5d6e";
const encode = (text: string): Uint8Array => new TextEncoder().encode(text);

const POINTER = `version https://git-lfs.github.com/spec/v1\noid sha256:${OID}\nsize 12857\n`;

describe("lfs pointer", () => {
  test("parses a well-formed pointer", () => {
    const parsed = parseLfsPointer(encode(POINTER));
    expect(parsed).not.toBeNull();
    expect(parsed?.oid).toBe(OID);
    expect(parsed?.size).toBe(12857);
  });

  test("accepts a pointer written with CRLF", () => {
    const parsed = parseLfsPointer(encode(POINTER.replace(/\n/g, "\r\n")));
    expect(parsed?.oid).toBe(OID);
    expect(parsed?.size).toBe(12857);
  });

  test("rejects a file that merely contains the version string", () => {
    const parsed = parseLfsPointer(encode(`See the docs:\n${POINTER}`));
    expect(parsed).toBeNull();
  });

  test("rejects a pointer with a short or non-hex oid", () => {
    expect(parseLfsPointer(encode(`version https://git-lfs.github.com/spec/v1\noid sha256:abc\nsize 1\n`))).toBeNull();
    expect(
      parseLfsPointer(encode(`version https://git-lfs.github.com/spec/v1\noid sha256:${"z".repeat(64)}\nsize 1\n`)),
    ).toBeNull();
  });

  test("rejects an upper-case oid", () => {
    const upper = OID.toUpperCase();
    expect(parseLfsPointer(encode(`version https://git-lfs.github.com/spec/v1\noid sha256:${upper}\nsize 1\n`))).toBeNull();
  });

  test("rejects a missing size line", () => {
    expect(parseLfsPointer(encode(`version https://git-lfs.github.com/spec/v1\noid sha256:${OID}\n`))).toBeNull();
  });

  test("rejects anything larger than a pointer could be", () => {
    const huge = encode(`version https://git-lfs.github.com/spec/v1\noid sha256:${OID}\nsize 1\n${"x".repeat(4096)}`);
    expect(parseLfsPointer(huge)).toBeNull();
  });

  test("returns null for binary content rather than throwing", () => {
    expect(parseLfsPointer(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff]))).toBeNull();
  });
});

describe("content type for a blob", () => {
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);

  test("magic bytes beat the extension", () => {
    expect(contentTypeForBlob("notes.txt", png)).toBe("image/png");
  });

  test("a text file wearing an image extension is not served as an image", () => {
    const text = encode("version 1\nplain text pretending to be a png\n");
    const type = contentTypeForBlob("fake.png", text);
    expect(type).not.toStartWith("image/");
    expect(type).toBe("text/plain; charset=utf-8");
  });

  test("unknown extensions fall back to text or octet-stream by content", () => {
    expect(contentTypeForBlob("thing.weird", encode("hello\n"))).toBe("text/plain; charset=utf-8");
    expect(contentTypeForBlob("thing.weird", new Uint8Array([1, 2, 0, 3]))).toBe("application/octet-stream");
  });

  test("an explicit binary flag overrides the heuristic", () => {
    expect(contentTypeForBlob("thing.weird", encode("hello\n"), { binary: true })).toBe(
      "application/octet-stream",
    );
  });

  test("classifyBlob agrees with contentTypeForBlob for the same bytes", () => {
    const text = encode("not an image\n");
    const classification = classifyBlob("fake.png", text, { binary: false });
    const contentType = contentTypeForBlob("fake.png", text, { binary: false });
    expect(classification.kind).toBe("text");
    expect(contentType.startsWith("text/")).toBe(true);
  });
});

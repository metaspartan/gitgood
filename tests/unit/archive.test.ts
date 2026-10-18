import { describe, expect, test } from "bun:test";
import {
  ARCHIVE_FORMATS,
  archiveFilename,
  archiveFormatInfo,
  DEFAULT_ARCHIVE_FORMAT,
  looksLikeArchive,
  parseArchiveFormat,
  sanitizeName,
} from "../../src/git/archive.ts";

describe("archive format parsing", () => {
  test("defaults when no format is given", () => {
    expect(parseArchiveFormat(undefined)).toBe(DEFAULT_ARCHIVE_FORMAT);
    expect(parseArchiveFormat("")).toBe(DEFAULT_ARCHIVE_FORMAT);
  });

  test("accepts the supported spellings", () => {
    expect(parseArchiveFormat("tar.gz")).toBe("tar.gz");
    expect(parseArchiveFormat("TAR.GZ")).toBe("tar.gz");
    expect(parseArchiveFormat("tgz")).toBe("tar.gz");
    expect(parseArchiveFormat("targz")).toBe("tar.gz");
    expect(parseArchiveFormat("zip")).toBe("zip");
    expect(parseArchiveFormat("ZIP")).toBe("zip");
  });

  test("rejects anything else rather than guessing", () => {
    for (const value of ["tar", "rar", "7z", "../zip", "zip; rm -rf /", "tar.bz2"]) {
      expect(parseArchiveFormat(value)).toBeNull();
    }
  });

  test("every advertised format resolves to a real spec", () => {
    for (const format of ARCHIVE_FORMATS) {
      const info = archiveFormatInfo(format);
      expect(info.mime.startsWith("application/")).toBe(true);
      expect(info.extension.length).toBeGreaterThan(0);
    }
  });
});

describe("name sanitisation", () => {
  test("keeps ordinary names untouched", () => {
    expect(sanitizeName("main")).toBe("main");
    expect(sanitizeName("release-1.2.3")).toBe("release-1.2.3");
  });

  test("turns path separators into dashes so a ref cannot look like a path", () => {
    expect(sanitizeName("feature/nested/branch")).toBe("feature-nested-branch");
    expect(sanitizeName("..\\windows\\path")).toBe("windows-path");
  });

  test("collapses traversal sequences", () => {
    for (const hostile of ["../../etc/passwd", "..\\..\\win", "a/../../b", "...."]) {
      const clean = sanitizeName(hostile);
      expect(clean.includes("..")).toBe(false);
      expect(clean.includes("/")).toBe(false);
      expect(clean.includes("\\")).toBe(false);
    }
  });

  test("strips control characters that would break a header", () => {
    const clean = sanitizeName("main\r\nX-Injected: 1");
    expect(clean.includes("\r")).toBe(false);
    expect(clean.includes("\n")).toBe(false);
    expect(clean.includes(":")).toBe(true);
  });

  test("strips quotes so a Content-Disposition value cannot be closed early", () => {
    expect(sanitizeName('main" ; filename="evil.sh"')).not.toContain('"');
  });

  test("never returns an empty name", () => {
    expect(sanitizeName("")).toBe("archive");
    expect(sanitizeName("...")).toBe("archive");
    expect(sanitizeName("///")).toBe("archive");
  });

  test("bounds the length", () => {
    expect(sanitizeName("x".repeat(500)).length).toBeLessThanOrEqual(100);
  });
});

describe("download filenames", () => {
  test("combines repo, ref and extension", () => {
    expect(archiveFilename("gitgood-demo", "main", "tar.gz")).toBe("gitgood-demo-main.tar.gz");
    expect(archiveFilename("gitgood-demo", "main", "zip")).toBe("gitgood-demo-main.zip");
  });

  test("sanitises both halves of the name", () => {
    const name = archiveFilename('re"po', "feature/x", "zip");
    expect(name).not.toContain('"');
    expect(name).not.toContain("/");
    expect(name.endsWith(".zip")).toBe(true);
  });

  test("cannot be steered outside the download directory", () => {
    const name = archiveFilename("repo", "../../../etc/passwd", "tar.gz");
    expect(name.includes("..")).toBe(false);
    expect(name.includes("/")).toBe(false);
  });
});

describe("magic-byte checks", () => {
  test("recognises gzip and zip", () => {
    expect(looksLikeArchive(Uint8Array.from([0x1f, 0x8b, 0x08, 0x00]), "tar.gz")).toBe(true);
    expect(looksLikeArchive(Uint8Array.from([0x50, 0x4b, 0x03, 0x04]), "zip")).toBe(true);
  });

  test("rejects the wrong format and short input", () => {
    expect(looksLikeArchive(Uint8Array.from([0x50, 0x4b, 0x03, 0x04]), "tar.gz")).toBe(false);
    expect(looksLikeArchive(Uint8Array.from([0x1f, 0x8b]), "zip")).toBe(false);
    expect(looksLikeArchive(Uint8Array.from([]), "tar.gz")).toBe(false);
    expect(looksLikeArchive(Uint8Array.from([0x1f]), "tar.gz")).toBe(false);
  });
});

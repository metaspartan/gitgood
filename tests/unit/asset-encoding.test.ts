import { describe, expect, test } from "bun:test";
import { acceptsGzip, makeAsset } from "../../src/web/assets.ts";

describe("gzip negotiation", () => {
  test("an explicit gzip token is accepted", () => {
    for (const header of ["gzip", "gzip, deflate", "deflate, gzip, br", "GZIP", "gzip;q=1.0"]) {
      const request = new Request("http://x/", { headers: { "accept-encoding": header } });
      expect(acceptsGzip(request)).toBe(true);
    }
  });

  test("a wildcard is accepted, because that is what the specification means", () => {
    const request = new Request("http://x/", { headers: { "accept-encoding": "*" } });
    expect(acceptsGzip(request)).toBe(true);
  });

  test("anything that does not name gzip is refused", () => {
    for (const header of ["identity", "br", "deflate", "identity, br"]) {
      const request = new Request("http://x/", { headers: { "accept-encoding": header } });
      expect(acceptsGzip(request)).toBe(false);
    }
  });

  test("a missing header is a refusal, not a default yes", () => {
    expect(acceptsGzip(new Request("http://x/"))).toBe(false);
  });
});

describe("precompressed assets", () => {
  test("a large text asset gets a gzipped form and its own validator", () => {
    const body = new TextEncoder().encode("export const value = 1;\n".repeat(500));
    const asset = makeAsset(body, "text/javascript; charset=utf-8");
    expect(asset.gzipped).not.toBeNull();
    expect(asset.gzipped!.byteLength).toBeLessThan(body.byteLength);
    expect(asset.gzipEtag).not.toBeNull();
    expect(asset.gzipEtag).not.toBe(asset.etag);
    expect(asset.gzipEtag).toContain("-gz");
  });

  test("the identity form is kept, so a non-gzip client still works", () => {
    const body = new TextEncoder().encode("a".repeat(4096));
    const asset = makeAsset(body, "text/javascript");
    expect(asset.body.byteLength).toBe(body.byteLength);
    expect(asset.etag).not.toContain("-gz");
  });

  test("already-compressed types are not compressed again", () => {
    for (const type of ["image/png", "font/woff2", "application/octet-stream"]) {
      const asset = makeAsset(new Uint8Array(4096).fill(7), type);
      expect(asset.gzipped).toBeNull();
      expect(asset.gzipEtag).toBeNull();
    }
  });

  test("a small payload is left alone", () => {
    const asset = makeAsset(new TextEncoder().encode("tiny"), "text/html");
    expect(asset.gzipped).toBeNull();
  });

  test("incompressible content is not stored twice", () => {
    const random = new Uint8Array(4096);
    crypto.getRandomValues(random);
    const asset = makeAsset(random, "text/plain");
    expect(asset.gzipped).toBeNull();
  });

  test("the gzipped body decodes back to the original bytes", () => {
    const original = new TextEncoder().encode("const x = 42;\n".repeat(300));
    const asset = makeAsset(original, "text/javascript");
    expect(asset.gzipped).not.toBeNull();
    const decoded = Bun.gunzipSync(asset.gzipped as Uint8Array<ArrayBuffer>);
    expect(new Uint8Array(decoded)).toEqual(original);
  });
});

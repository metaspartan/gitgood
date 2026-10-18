import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assetFor, loadPrebuiltBundle } from "../../src/web/assets.ts";

const created: string[] = [];

function scratchDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "gg-web-"));
  created.push(dir);
  return dir;
}

function writeBundle(
  dir: string,
  options: { entries?: Array<{ name: string; contentType: string; content: string }>; manifest?: string } = {},
): void {
  mkdirSync(dir, { recursive: true });
  const entries = options.entries ?? [
    { name: "chunk-abc.js", contentType: "text/javascript; charset=utf-8", content: "console.log(1)" },
  ];
  for (const entry of entries) writeFileSync(join(dir, entry.name), entry.content);
  writeFileSync(join(dir, "index.html"), '<div id="root"></div><script src="/_assets/chunk-abc.js"></script>');
  writeFileSync(
    join(dir, "manifest.json"),
    options.manifest ??
      JSON.stringify({
        builtAt: new Date().toISOString(),
        assets: entries.map((entry) => ({
          name: entry.name,
          contentType: entry.contentType,
          bytes: entry.content.length,
        })),
      }),
  );
}

afterEach(() => {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("prebuilt bundle loader", () => {
  test("returns null when the directory does not exist", () => {
    expect(loadPrebuiltBundle(join(tmpdir(), "gg-web-does-not-exist"))).toBeNull();
  });

  test("returns null when index.html is missing", () => {
    const dir = scratchDir();
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "manifest.json"), JSON.stringify({ buildAt: "", assets: [] }));
    expect(loadPrebuiltBundle(dir)).toBeNull();
  });

  test("returns null rather than throwing on a corrupt manifest", () => {
    const dir = scratchDir();
    writeBundle(dir, { manifest: "{not json" });
    expect(loadPrebuiltBundle(dir)).toBeNull();
  });

  test("returns null when the manifest names an asset that is not on disk", () => {
    const dir = scratchDir();
    writeBundle(dir);
    rmSync(join(dir, "chunk-abc.js"));
    expect(loadPrebuiltBundle(dir)).toBeNull();
  });

  test("loads assets with their declared content type", () => {
    const dir = scratchDir();
    writeBundle(dir, {
      entries: [
        { name: "chunk-abc.js", contentType: "text/javascript; charset=utf-8", content: "console.log(1)" },
        { name: "chunk-abc.css", contentType: "text/css; charset=utf-8", content: "body{}" },
      ],
    });

    const bundle = loadPrebuiltBundle(dir);
    expect(bundle).not.toBeNull();
    expect(bundle?.source).toBe("prebuilt");
    expect(bundle?.assets.size).toBe(2);
    expect(bundle?.assets.get("chunk-abc.js")?.contentType).toContain("javascript");
    expect(bundle?.assets.get("chunk-abc.css")?.contentType).toContain("css");
    expect(new TextDecoder().decode(bundle?.indexHtml)).toContain("id=\"root\"");
  });

  test("etags are stable for identical content and differ for different content", () => {
    const first = scratchDir();
    const second = scratchDir();
    writeBundle(first);
    writeBundle(second);
    const a = loadPrebuiltBundle(first);
    const b = loadPrebuiltBundle(second);
    expect(a?.assets.get("chunk-abc.js")?.etag).toBe(b?.assets.get("chunk-abc.js")?.etag);

    const third = scratchDir();
    writeBundle(third, {
      entries: [
        { name: "chunk-abc.js", contentType: "text/javascript; charset=utf-8", content: "console.log(2)" },
      ],
    });
    expect(loadPrebuiltBundle(third)?.assets.get("chunk-abc.js")?.etag).not.toBe(a?.assets.get("chunk-abc.js")?.etag);
  });

  test("assetFor only serves names inside the bundle and blocks traversal", () => {
    const dir = scratchDir();
    writeBundle(dir);
    const bundle = loadPrebuiltBundle(dir);
    expect(bundle).not.toBeNull();
    if (!bundle) return;

    expect(assetFor(bundle, "/_assets/chunk-abc.js")?.contentType).toContain("javascript");
    expect(assetFor(bundle, "/_assets/../../package.json")).toBeNull();
    expect(assetFor(bundle, "/_assets/nested/chunk-abc.js")).toBeNull();
    expect(assetFor(bundle, "/_assets/missing.js")).toBeNull();
    expect(assetFor(bundle, "/owner/repo")).toBeNull();
  });
});

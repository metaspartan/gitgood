import { mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { vendorAssets } from "../src/web/vendor-assets.ts";

const ASSET_PREFIX = "/_assets/";

const CONTENT_TYPES: Record<string, string> = {
  html: "text/html; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  css: "text/css; charset=utf-8",
  json: "application/json; charset=utf-8",
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  woff2: "font/woff2",
};

interface ManifestEntry {
  name: string;
  contentType: string;
  bytes: number;
}

interface WebManifest {
  builtAt: string;
  assets: ManifestEntry[];
}

function contentTypeFor(fileName: string): string {
  const dot = fileName.lastIndexOf(".");
  const extension = dot === -1 ? "" : fileName.slice(dot + 1).toLowerCase();
  return CONTENT_TYPES[extension] ?? "application/octet-stream";
}

function absolutiseAssetUrls(html: string): string {
  return html.replace(/(href|src)="\.\/([^"]+)"/g, (_match, attribute: string, file: string) => {
    return `${attribute}="${ASSET_PREFIX}${file}"`;
  });
}

async function main(): Promise<void> {
  const outdir = Bun.argv[2] ?? join(import.meta.dir, "..", "dist", "web");
  rmSync(outdir, { recursive: true, force: true });
  mkdirSync(outdir, { recursive: true });

  const started = performance.now();
  const result = await Bun.build({
    entrypoints: [join(import.meta.dir, "..", "src", "web", "index.html")],
    outdir,
    target: "browser",
    minify: true,
    sourcemap: "none",
    define: { "process.env.NODE_ENV": '"production"' },
    splitting: true,
  });

  if (!result.success) {
    for (const message of result.logs) console.error(String(message));
    throw new Error("web build failed");
  }

  const assets: ManifestEntry[] = [];
  for (const output of result.outputs) {
    const name = basename(output.path);
    if (name === "index.html") {
      const rewritten = absolutiseAssetUrls(await output.text());
      writeFileSync(join(outdir, "index.html"), rewritten);
      continue;
    }
    assets.push({ name, contentType: contentTypeFor(name), bytes: output.size });
  }

  for (const vendor of vendorAssets()) {
    writeFileSync(join(outdir, vendor.name), vendor.bytes);
    assets.push({ name: vendor.name, contentType: vendor.contentType, bytes: vendor.bytes.byteLength });
  }

  const manifest: WebManifest = { builtAt: new Date().toISOString(), assets };
  writeFileSync(join(outdir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);

  const totalBytes = assets.reduce((sum, asset) => sum + asset.bytes, 0);
  const elapsed = Math.round(performance.now() - started);
  console.log(`built ${assets.length} asset(s), ${(totalBytes / 1024).toFixed(1)} KiB in ${elapsed} ms`);
  for (const asset of assets) console.log(`  ${ASSET_PREFIX}${asset.name}  ${asset.bytes} bytes`);
  for (const entry of readdirSync(outdir)) {
    if (entry === "index.html" || entry === "manifest.json") {
      console.log(`  ${entry}  ${statSync(join(outdir, entry)).size} bytes`);
    }
  }
  console.log(`output: ${outdir}`);
}

await main();

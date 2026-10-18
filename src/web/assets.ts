import { existsSync, readFileSync, rmSync } from "node:fs";
import { basename, join } from "node:path";
import { config, isProduction } from "../config.ts";
import { log } from "../lib/logger.ts";
import { vendorAssets } from "./vendor-assets.ts";

export function acceptsGzip(request: Request): boolean {
  const header = request.headers.get("accept-encoding");
  if (!header) return false;
  return /\bgzip\b/i.test(header) || header.trim() === "*";
}

const ASSET_PREFIX = "/_assets/";

export interface WebAsset {
  body: Uint8Array;
  contentType: string;
  etag: string;
  gzipped: Uint8Array | null;
  gzipEtag: string | null;
}

export interface WebBundle {
  indexHtml: Uint8Array;
  indexEtag: string;
  indexGzipped: Uint8Array | null;
  assets: Map<string, WebAsset>;
  source: "prebuilt" | "runtime";
  buildMs: number;
}

function compressible(contentType: string): boolean {
  return /^(text\/|application\/(javascript|json|xml)|image\/svg)/.test(contentType);
}

function gzipFor(bytes: Uint8Array, contentType: string): Uint8Array | null {
  if (!compressible(contentType)) return null;
  if (bytes.byteLength < 1024) return null;
  const view = new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const compressed = Bun.gzipSync(view as Uint8Array<ArrayBuffer>);
  if (compressed.byteLength >= bytes.byteLength * 0.95) return null;
  return compressed as unknown as Uint8Array;
}

function gzipEtagFor(identityEtag: string): string {
  return `${identityEtag.slice(0, -1)}-gz"`;
}

export function makeAsset(body: Uint8Array, contentType: string): WebAsset {
  const gzipped = gzipFor(body, contentType);
  const etag = etagFor(body);
  return {
    body,
    contentType,
    etag,
    gzipped,
    gzipEtag: gzipped ? gzipEtagFor(etag) : null,
  };
}

interface ManifestEntry {
  name: string;
  contentType: string;
  bytes: number;
}

interface WebManifest {
  builtAt: string;
  assets: ManifestEntry[];
}

function etagFor(bytes: Uint8Array): string {
  const digest = new Bun.CryptoHasher("sha1").update(bytes).digest("hex").slice(0, 20);
  return `W/"${bytes.byteLength.toString(16)}-${digest}"`;
}

function absolutiseAssetUrls(html: string): string {
  return html.replace(/(href|src)="\.\/([^"]+)"/g, (_match, attribute: string, file: string) => {
    return `${attribute}="${ASSET_PREFIX}${file}"`;
  });
}

export function loadPrebuiltBundle(dir: string): WebBundle | null {
  const indexPath = join(dir, "index.html");
  const manifestPath = join(dir, "manifest.json");
  if (!existsSync(indexPath) || !existsSync(manifestPath)) return null;

  const started = performance.now();
  let manifest: WebManifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as WebManifest;
  } catch (error) {
    log.warn("prebuilt web manifest is unreadable, falling back to a runtime build", {
      dir,
      reason: error instanceof Error ? error.message : String(error),
    });
    return null;
  }

  const indexHtml = new Uint8Array(readFileSync(indexPath));
  const assets = new Map<string, WebAsset>();
  for (const entry of manifest.assets) {
    const filePath = join(dir, entry.name);
    if (!existsSync(filePath)) {
      log.warn("prebuilt web asset is missing, falling back to a runtime build", {
        dir,
        asset: entry.name,
      });
      return null;
    }
    const body = new Uint8Array(readFileSync(filePath));
    assets.set(entry.name, makeAsset(body, entry.contentType));
  }

  const compressedIndex = gzipFor(indexHtml, "text/html; charset=utf-8");
  return {
    indexHtml,
    indexEtag: etagFor(indexHtml),
    indexGzipped: compressedIndex,
    assets,
    source: "prebuilt",
    buildMs: Math.round(performance.now() - started),
  };
}

async function buildRuntimeBundle(): Promise<WebBundle> {
  const started = performance.now();
  const outdir = join(config.dataDir, "web");
  rmSync(outdir, { recursive: true, force: true });

  const result = await Bun.build({
    entrypoints: [join(import.meta.dir, "index.html")],
    outdir,
    target: "browser",
    minify: isProduction,
    sourcemap: "none",
  });

  if (!result.success) {
    for (const message of result.logs) log.error("web build error", { message: String(message) });
    throw new Error("Failed to build the web bundle");
  }

  const assets = new Map<string, WebAsset>();
  let indexHtml: Uint8Array | null = null;

  for (const output of result.outputs) {
    const name = basename(output.path);
    const bytes = new Uint8Array(await output.arrayBuffer());
    if (name === "index.html") {
      indexHtml = new TextEncoder().encode(absolutiseAssetUrls(new TextDecoder().decode(bytes)));
      continue;
    }
    assets.set(name, makeAsset(bytes, contentTypeFor(name)));
  }
  for (const vendor of vendorAssets()) assets.set(vendor.name, makeAsset(vendor.bytes, vendor.contentType));

  if (!indexHtml) throw new Error("Web build produced no index.html");
  return {
    indexHtml,
    indexEtag: etagFor(indexHtml),
    indexGzipped: gzipFor(indexHtml, "text/html; charset=utf-8"),
    assets,
    source: "runtime",
    buildMs: Math.round(performance.now() - started),
  };
}

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

function contentTypeFor(fileName: string): string {
  const dot = fileName.lastIndexOf(".");
  const extension = dot === -1 ? "" : fileName.slice(dot + 1).toLowerCase();
  return CONTENT_TYPES[extension] ?? "application/octet-stream";
}

let cached: Promise<WebBundle> | null = null;

export function webBundle(): Promise<WebBundle> {
  cached ??= (async () => {
    const prebuilt = loadPrebuiltBundle(config.webDist);
    if (prebuilt) {
      log.info("web bundle loaded", {
        source: prebuilt.source,
        assets: prebuilt.assets.size,
        loadMs: prebuilt.buildMs,
      });
      return prebuilt;
    }
    log.info("no prebuilt web bundle found, bundling at runtime", { dir: config.webDist });
    const bundle = await buildRuntimeBundle();
    log.info("web bundle built", { source: bundle.source, assets: bundle.assets.size, buildMs: bundle.buildMs });
    return bundle;
  })();
  return cached;
}

export async function preloadWebBundle(): Promise<boolean> {
  const prebuilt = loadPrebuiltBundle(config.webDist);
  if (!prebuilt) return false;
  cached = Promise.resolve(prebuilt);
  log.info("web bundle preloaded", {
    assets: prebuilt.assets.size,
    loadMs: prebuilt.buildMs,
  });
  return true;
}

export function assetFor(bundle: WebBundle, pathname: string): WebAsset | null {
  if (!pathname.startsWith(ASSET_PREFIX)) return null;
  const name = pathname.slice(ASSET_PREFIX.length);
  if (name.includes("/") || name.includes("..")) return null;
  return bundle.assets.get(name) ?? null;
}

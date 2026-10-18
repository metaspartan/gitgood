import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";

export interface VendorAsset {
  name: string;
  bytes: Uint8Array;
  contentType: string;
}

function threeRoot(): string {
  return dirname(Bun.resolveSync("three/package.json", import.meta.dir));
}

export function basisPrefix(): string {
  const version = (JSON.parse(readFileSync(join(threeRoot(), "package.json"), "utf8")) as { version: string }).version;
  return `three-r${version.split(".")[1]}-`;
}

export function vendorAssets(): VendorAsset[] {
  const dir = join(threeRoot(), "examples", "jsm", "libs", "basis");
  const prefix = basisPrefix();
  return [
    { name: `${prefix}basis_transcoder.js`, bytes: readFileSync(join(dir, "basis_transcoder.js")), contentType: "text/javascript; charset=utf-8" },
    { name: `${prefix}basis_transcoder.wasm`, bytes: readFileSync(join(dir, "basis_transcoder.wasm")), contentType: "application/wasm" },
  ];
}

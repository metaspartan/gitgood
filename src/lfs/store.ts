import { invalidateLfsTotals } from "./totals.ts";
import { mkdirSync, renameSync, existsSync, unlinkSync, statSync, readFileSync, openSync, readSync, closeSync } from "node:fs";
import { dirname, join } from "node:path";
import { config } from "../config.ts";
import { changes, now, one, run } from "../db/index.ts";
import { notFound, payloadTooLarge, unprocessable } from "../lib/errors.ts";
import { OID_PATTERN } from "../lib/ids.ts";

export interface LfsObjectRow {
  oid: string;
  size: number;
  created_at: number;
}

export function isValidOid(oid: string): boolean {
  return OID_PATTERN.test(oid);
}

export function objectPath(oid: string): string {
  return join(config.lfsRoot, "objects", oid.slice(0, 2), oid.slice(2, 4), oid);
}

export function objectExists(oid: string): boolean {
  if (!isValidOid(oid)) return false;
  return existsSync(objectPath(oid));
}

export function objectStat(oid: string): LfsObjectRow | null {
  if (!objectExists(oid)) return null;
  const row = one<LfsObjectRow>("SELECT * FROM lfs_objects WHERE oid = ?", oid);
  const size = statSync(objectPath(oid)).size;
  return { oid, size, created_at: row?.created_at ?? 0 };
}

export interface PutResult {
  oid: string;
  size: number;
  stored: boolean;
}

export async function putObjectFromStream(
  oid: string,
  stream: ReadableStream<Uint8Array>,
  maxBytes = config.maxLfsObjectBytes,
): Promise<PutResult> {
  if (!isValidOid(oid)) throw unprocessable("oid must be a 64-character lowercase SHA-256 hex digest");

  if (objectExists(oid)) {
    const row = one<LfsObjectRow>("SELECT * FROM lfs_objects WHERE oid = ?", oid);
    return { oid, size: row?.size ?? statSync(objectPath(oid)).size, stored: false };
  }

  const target = objectPath(oid);
  mkdirSync(dirname(target), { recursive: true });
  const temp = `${target}.upload-${crypto.randomUUID()}`;

  const hasher = new Bun.CryptoHasher("sha256");
  const writer = Bun.file(temp).writer({ highWaterMark: 1024 * 1024 });
  let size = 0;

  try {
    const reader = stream.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw payloadTooLarge(`LFS object exceeds the ${maxBytes} byte limit`);
      }
      hasher.update(value);
      writer.write(value);
    }
    await writer.end();
  } catch (error) {
    try {
      writer.end();
    } catch {
    }
    if (existsSync(temp)) unlinkSync(temp);
    throw error;
  }

  const computed = hasher.digest("hex");
  if (computed !== oid) {
    if (existsSync(temp)) unlinkSync(temp);
    throw unprocessable(`Content hash ${computed} does not match the declared oid ${oid}`);
  }

  if (objectExists(oid)) {
    unlinkSync(temp);
    const row = one<LfsObjectRow>("SELECT * FROM lfs_objects WHERE oid = ?", oid);
    return { oid, size: row?.size ?? size, stored: false };
  }

  renameSync(temp, target);
  run(
    "INSERT OR REPLACE INTO lfs_objects (oid, size, created_at) VALUES (?, ?, ?)",
    oid,
    size,
    now(),
  );
  return { oid, size, stored: true };
}

export function readObject(oid: string): Response {
  if (!objectExists(oid)) throw notFound("LFS object not found");
  const file = Bun.file(objectPath(oid));
  return new Response(file, {
    headers: {
      "content-type": "application/octet-stream",
      "content-length": String(file.size),
      "cache-control": "public, max-age=31536000, immutable",
      "x-content-type-options": "nosniff",
    },
  });
}

export function objectFile(oid: string): Bun.BunFile | null {
  if (!isValidOid(oid)) return null;
  const path = objectPath(oid);
  if (!existsSync(path)) return null;
  return Bun.file(path);
}

export function readObjectHead(oid: string, maxBytes: number): Uint8Array | null {
  if (!isValidOid(oid)) return null;
  const path = objectPath(oid);
  if (!existsSync(path)) return null;
  const size = statSync(path).size;
  if (size === 0) return new Uint8Array(0);

  const length = Math.min(maxBytes, size);
  const buffer = Buffer.alloc(length);
  const fd = openSync(path, "r");
  try {
    const read = readSync(fd, buffer, 0, length, 0);
    return new Uint8Array(buffer.subarray(0, read));
  } finally {
    closeSync(fd);
  }
}

export function readObjectBytes(oid: string, maxBytes: number): Uint8Array | null {
  if (!isValidOid(oid)) return null;
  const path = objectPath(oid);
  if (!existsSync(path)) return null;
  if (statSync(path).size > maxBytes) return null;
  return new Uint8Array(readFileSync(path));
}

export function deleteObject(oid: string): boolean {
  const path = objectPath(oid);
  if (!existsSync(path)) return false;
  unlinkSync(path);
  changes("DELETE FROM lfs_objects WHERE oid = ?", oid);
  invalidateLfsTotals();
  return true;
}

export interface LfsStoreStats {
  objects: number;
  bytes: number;
}

export function storeStats(): LfsStoreStats {
  const row = one<{ objects: number; bytes: number }>(
    "SELECT COUNT(*) AS objects, COALESCE(SUM(size), 0) AS bytes FROM lfs_objects",
  );
  return { objects: row?.objects ?? 0, bytes: row?.bytes ?? 0 };
}

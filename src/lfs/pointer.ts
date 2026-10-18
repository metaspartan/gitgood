export interface LfsPointer {
  oid: string;
  size: number;
}

const VERSION_LINE = "version https://git-lfs.github.com/spec/v1";
const MAX_POINTER_BYTES = 1024;

const OID_LINE = /^oid sha256:([0-9a-f]{64})$/m;
const SIZE_LINE = /^size ([0-9]+)$/m;

export function parseLfsPointer(bytes: Uint8Array): LfsPointer | null {
  if (bytes.byteLength > MAX_POINTER_BYTES) return null;
  const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes).replace(/\r\n/g, "\n");
  if (!text.startsWith(VERSION_LINE)) return null;

  const oid = OID_LINE.exec(text)?.[1];
  const size = SIZE_LINE.exec(text)?.[1];
  if (oid === undefined || size === undefined) return null;

  const parsedSize = Number.parseInt(size, 10);
  if (!Number.isSafeInteger(parsedSize) || parsedSize < 0) return null;

  return { oid, size: parsedSize };
}

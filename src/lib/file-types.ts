const SNIFF_BYTES = 32;

export interface ImageType {
  mime: string;
  extension: string;
}

function startsWith(bytes: Uint8Array, signature: readonly number[], offset = 0): boolean {
  if (bytes.length < offset + signature.length) return false;
  for (let i = 0; i < signature.length; i++) {
    if (bytes[offset + i] !== signature[i]) return false;
  }
  return true;
}

function ascii(bytes: Uint8Array, offset: number, text: string): boolean {
  if (bytes.length < offset + text.length) return false;
  for (let i = 0; i < text.length; i++) {
    if (bytes[offset + i] !== text.charCodeAt(i)) return false;
  }
  return true;
}

const IMAGE_EXTENSIONS: Record<string, ImageType> = {
  png: { mime: "image/png", extension: "png" },
  jpg: { mime: "image/jpeg", extension: "jpg" },
  jpeg: { mime: "image/jpeg", extension: "jpg" },
  gif: { mime: "image/gif", extension: "gif" },
  webp: { mime: "image/webp", extension: "webp" },
  bmp: { mime: "image/bmp", extension: "bmp" },
  ico: { mime: "image/x-icon", extension: "ico" },
  tif: { mime: "image/tiff", extension: "tiff" },
  tiff: { mime: "image/tiff", extension: "tiff" },
  avif: { mime: "image/avif", extension: "avif" },
  heic: { mime: "image/heic", extension: "heic" },
  svg: { mime: "image/svg+xml", extension: "svg" },
};

export interface MediaType {
  mime: string;
  kind: "audio" | "video" | "model";
  extension: string;
}

const MEDIA_EXTENSIONS: Record<string, MediaType> = {
  stl: { mime: "model/stl", kind: "model", extension: "stl" },
  obj: { mime: "model/obj", kind: "model", extension: "obj" },
  ply: { mime: "model/ply", kind: "model", extension: "ply" },
  gltf: { mime: "model/gltf+json", kind: "model", extension: "gltf" },
  glb: { mime: "model/gltf-binary", kind: "model", extension: "glb" },
  "3mf": { mime: "model/3mf", kind: "model", extension: "3mf" },
  mp3: { mime: "audio/mpeg", kind: "audio", extension: "mp3" },
  wav: { mime: "audio/wav", kind: "audio", extension: "wav" },
  ogg: { mime: "audio/ogg", kind: "audio", extension: "ogg" },
  oga: { mime: "audio/ogg", kind: "audio", extension: "oga" },
  flac: { mime: "audio/flac", kind: "audio", extension: "flac" },
  m4a: { mime: "audio/mp4", kind: "audio", extension: "m4a" },
  opus: { mime: "audio/opus", kind: "audio", extension: "opus" },
  mp4: { mime: "video/mp4", kind: "video", extension: "mp4" },
  m4v: { mime: "video/mp4", kind: "video", extension: "m4v" },
  webm: { mime: "video/webm", kind: "video", extension: "webm" },
  mov: { mime: "video/quicktime", kind: "video", extension: "mov" },
  mkv: { mime: "video/x-matroska", kind: "video", extension: "mkv" },
};

export function isSvgPath(filePath: string): boolean {
  return filePath.toLowerCase().endsWith(".svg");
}

export function imageTypeFromPath(filePath: string): ImageType | null {
  const dot = filePath.lastIndexOf(".");
  if (dot === -1) return null;
  return IMAGE_EXTENSIONS[filePath.slice(dot + 1).toLowerCase()] ?? null;
}

export function mediaTypeFromPath(filePath: string): MediaType | null {
  const dot = filePath.lastIndexOf(".");
  if (dot === -1) return null;
  return MEDIA_EXTENSIONS[filePath.slice(dot + 1).toLowerCase()] ?? null;
}

export function sniffImageType(bytes: Uint8Array): ImageType | null {
  if (bytes.length < 8) return null;

  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return { mime: "image/png", extension: "png" };
  }
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) {
    return { mime: "image/jpeg", extension: "jpg" };
  }
  if (ascii(bytes, 0, "GIF87a") || ascii(bytes, 0, "GIF89a")) {
    return { mime: "image/gif", extension: "gif" };
  }
  if (ascii(bytes, 0, "RIFF") && ascii(bytes, 8, "WEBP")) {
    return { mime: "image/webp", extension: "webp" };
  }
  if (ascii(bytes, 0, "BM")) {
    return { mime: "image/bmp", extension: "bmp" };
  }
  if (startsWith(bytes, [0x00, 0x00, 0x01, 0x00])) {
    return { mime: "image/x-icon", extension: "ico" };
  }
  if (startsWith(bytes, [0x49, 0x49, 0x2a, 0x00]) || startsWith(bytes, [0x4d, 0x4d, 0x00, 0x2a])) {
    return { mime: "image/tiff", extension: "tiff" };
  }
  if (ascii(bytes, 4, "ftyp")) {
    if (ascii(bytes, 8, "avif") || ascii(bytes, 8, "avis")) {
      return { mime: "image/avif", extension: "avif" };
    }
    if (ascii(bytes, 8, "heic") || ascii(bytes, 8, "heix") || ascii(bytes, 8, "mif1")) {
      return { mime: "image/heic", extension: "heic" };
    }
  }
  return null;
}

export function sniffMediaType(bytes: Uint8Array): MediaType | null {
  if (ascii(bytes, 0, "RIFF")) {
    if (ascii(bytes, 8, "WAVE")) return { mime: "audio/wav", kind: "audio", extension: "wav" };
  }
  if (ascii(bytes, 0, "OggS")) {
    return { mime: "audio/ogg", kind: "audio", extension: "ogg" };
  }
  if (ascii(bytes, 0, "fLaC")) {
    return { mime: "audio/flac", kind: "audio", extension: "flac" };
  }
  if (ascii(bytes, 0, "ID3") || (bytes[0] === 0xff && ((bytes[1] ?? 0) & 0xe6) === 0xe2)) {
    return { mime: "audio/mpeg", kind: "audio", extension: "mp3" };
  }
  if (ascii(bytes, 0, "glTF")) {
    return { mime: "model/gltf-binary", kind: "model", extension: "glb" };
  }
  if (ascii(bytes, 4, "ftyp")) {
    if (ascii(bytes, 8, "M4A ")) {
      return { mime: "audio/mp4", kind: "audio", extension: "m4a" };
    }
    if (ascii(bytes, 8, "qt  ")) {
      return { mime: "video/quicktime", kind: "video", extension: "mov" };
    }
    return { mime: "video/mp4", kind: "video", extension: "mp4" };
  }
  if (startsWith(bytes, [0x1a, 0x45, 0xdf, 0xa3])) {
    const head = new TextDecoder("latin1").decode(bytes.subarray(0, 40));
    return head.includes("webm")
      ? { mime: "video/webm", kind: "video", extension: "webm" }
      : { mime: "video/x-matroska", kind: "video", extension: "mkv" };
  }
  return null;
}

export function looksLikeSvg(bytes: Uint8Array): boolean {
  const head = new TextDecoder("utf-8", { fatal: false }).decode(bytes.subarray(0, 1024));
  const trimmed = head.replace(/^\uFEFF/, "").trimStart();
  return trimmed.startsWith("<?xml") || trimmed.startsWith("<svg") || trimmed.startsWith("<!DOCTYPE svg");
}

export interface InlineKind {
  kind: "text" | "image" | "audio" | "video" | "model" | "binary";
  mime: string;
  language: string | null;
}
export const LANGUAGE_EXTENSIONS: Readonly<Record<string, string>> = {
  ts: "typescript",
  tsx: "typescript",
  mts: "typescript",
  cts: "typescript",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  json: "json",
  jsonc: "json",
  css: "css",
  scss: "css",
  less: "css",
  html: "html",
  htm: "html",
  xml: "html",
  vue: "html",
  svelte: "html",
  py: "python",
  pyi: "python",
  rs: "rust",
  go: "go",
  java: "java",
  kt: "java",
  c: "c",
  h: "c",
  cc: "cpp",
  cpp: "cpp",
  cxx: "cpp",
  hpp: "cpp",
  cs: "csharp",
  rb: "ruby",
  php: "php",
  swift: "swift",
  sh: "shell",
  bash: "shell",
  zsh: "shell",
  fish: "shell",
  ps1: "shell",
  toml: "toml",
  ini: "toml",
  cfg: "toml",
  yml: "yaml",
  yaml: "yaml",
  sql: "sql",
  md: "markdown",
  markdown: "markdown",
  diff: "diff",
  patch: "diff",
  dockerfile: "docker",
  makefile: "make",
  cmake: "cmake",
  gradle: "java",
  lua: "lua",
  pl: "perl",
  r: "r",
  dart: "dart",
  scala: "scala",
  ex: "elixir",
  exs: "elixir",
  erl: "erlang",
  hs: "haskell",
  clj: "clojure",
  zig: "zig",
  gltf: "json",
};

const FILENAME_LANGUAGES: Readonly<Record<string, string>> = {
  dockerfile: "docker",
  "docker-compose.yml": "yaml",
  "docker-compose.yaml": "yaml",
  makefile: "make",
  gemfile: "ruby",
  rakefile: "ruby",
  "cmakelists.txt": "cmake",
};

export function languageForPath(filePath: string): string | null {
  const lower = filePath.toLowerCase();
  const lastSlash = Math.max(lower.lastIndexOf("/"), lower.lastIndexOf("\\"));
  const base = lower.slice(lastSlash + 1);

  const byName = FILENAME_LANGUAGES[base];
  if (byName) return byName;

  const dot = base.lastIndexOf(".");
  if (dot === -1 || dot === base.length - 1) return null;
  return LANGUAGE_EXTENSIONS[base.slice(dot + 1)] ?? null;
}

function looksLikeAsciiStl(bytes: Uint8Array): boolean {
  const head = new TextDecoder("utf-8", { fatal: false }).decode(bytes.subarray(0, 512));
  const trimmed = head.trimStart();
  return trimmed.startsWith("solid") && trimmed.includes("facet");
}

export function classifyBlob(
  filePath: string,
  bytes: Uint8Array,
  options: { binary: boolean },
): InlineKind {
  const sniffed = sniffImageType(bytes.subarray(0, SNIFF_BYTES));
  if (sniffed) return { kind: "image", mime: sniffed.mime, language: null };

  const media = sniffMediaType(bytes.subarray(0, SNIFF_BYTES));
  if (media) return { kind: media.kind, mime: media.mime, language: null };

  if (isSvgPath(filePath) && looksLikeSvg(bytes)) {
    return { kind: "image", mime: "image/svg+xml", language: "html" };
  }

  if (filePath.toLowerCase().endsWith(".stl") && looksLikeAsciiStl(bytes)) {
    return { kind: "model", mime: "model/stl", language: null };
  }

  if (options.binary) {
    const byExtension = mediaTypeFromPath(filePath);
    if (byExtension) return { kind: byExtension.kind, mime: byExtension.mime, language: null };
    return { kind: "binary", mime: "application/octet-stream", language: null };
  }

  return { kind: "text", mime: "text/plain; charset=utf-8", language: languageForPath(filePath) };
}

function looksBinary(bytes: Uint8Array): boolean {
  const probe = Math.min(bytes.length, 8000);
  for (let i = 0; i < probe; i++) if (bytes[i] === 0) return true;
  return false;
}

export function contentTypeForBlob(
  filePath: string,
  bytes: Uint8Array,
  options: { binary?: boolean } = {},
): string {
  const sniffed = sniffImageType(bytes.subarray(0, SNIFF_BYTES));
  if (sniffed) return sniffed.mime;

  const media = sniffMediaType(bytes.subarray(0, SNIFF_BYTES));
  if (media) return media.mime;

  if (isSvgPath(filePath) && looksLikeSvg(bytes)) return "image/svg+xml";

  const binary = options.binary ?? looksBinary(bytes);

  if (filePath.toLowerCase().endsWith(".stl") && looksLikeAsciiStl(bytes)) {
    return "model/stl";
  }

  if (binary) {
    const byExtension = mediaTypeFromPath(filePath);
    if (byExtension) return byExtension.mime;
  }

  const dot = filePath.lastIndexOf(".");
  const extension = dot === -1 ? "" : filePath.slice(dot + 1).toLowerCase();
  const BY_TEXT_EXTENSION: Readonly<Record<string, string>> = {
    ts: "text/plain; charset=utf-8",
    tsx: "text/plain; charset=utf-8",
    js: "text/plain; charset=utf-8",
    json: "application/json; charset=utf-8",
    md: "text/plain; charset=utf-8",
    txt: "text/plain; charset=utf-8",
    css: "text/css; charset=utf-8",
    html: "text/html; charset=utf-8",
    pdf: "application/pdf",
    zip: "application/zip",
    gz: "application/gzip",
    tar: "application/x-tar",
    woff2: "font/woff2",
    woff: "font/woff",
    ttf: "font/ttf",
    otf: "font/otf",
  };
  const byExtension = BY_TEXT_EXTENSION[extension];
  if (byExtension) return byExtension;

  return binary ? "application/octet-stream" : "text/plain; charset=utf-8";
}

export function downloadFilename(filePath: string): string {
  const lastSlash = Math.max(filePath.lastIndexOf("/"), filePath.lastIndexOf("\\"));
  const base = filePath.slice(lastSlash + 1);
  return base.length === 0 ? "download" : base;
}

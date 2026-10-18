import { AppError, badRequest, payloadTooLarge, toErrorResponse } from "./errors.ts";
import { config } from "../config.ts";
import type { Validator } from "./validate.ts";

const JSON_CONTENT_TYPE = "application/json; charset=utf-8";

const COMPRESSION_THRESHOLD_BYTES = 1024;

const CSP = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self'",
  "connect-src 'self' blob:",
  "worker-src 'self' blob:",
  "form-action 'self'",
  "base-uri 'none'",
  "object-src 'none'",
  "frame-ancestors 'none'",
].join("; ");

function securityHeaders(secure: boolean): Record<string, string> {
  const headers: Record<string, string> = {
    "content-security-policy": CSP,
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
    "referrer-policy": "strict-origin-when-cross-origin",
    "permissions-policy": "camera=(), microphone=(), geolocation=(), payment=()",
    "cross-origin-opener-policy": "same-origin",
  };
  if (secure) headers["strict-transport-security"] = "max-age=31536000; includeSubDomains";
  return headers;
}

function withSecurity(headers: Headers, secure: boolean): void {
  for (const [key, value] of Object.entries(securityHeaders(secure))) headers.set(key, value);
}

function gzipIfWorthwhile(
  request: Request,
  payload: string,
  headers: Headers,
): BodyInit {
  const accepts = request.headers.get("accept-encoding") ?? "";
  if (!/\bgzip\b/i.test(accepts)) return payload;

  const bytes = Buffer.byteLength(payload);
  if (bytes < COMPRESSION_THRESHOLD_BYTES) return payload;

  const compressed = Bun.gzipSync(payload);

  if (compressed.byteLength >= bytes) return payload;
  headers.set("content-encoding", "gzip");
  headers.set("vary", "accept-encoding");
  return compressed as unknown as BodyInit;
}

export function json(data: unknown, init?: ResponseInit): Response {
  return jsonFor(new Request("http://localhost/"), data, init);
}

export class RawJson {
  constructor(readonly text: string) {}
}

export function jsonFor(
  request: Request,
  data: unknown,
  init?: ResponseInit & { etag?: string },
): Response {
  const headers = new Headers(init?.headers);
  headers.set("content-type", JSON_CONTENT_TYPE);
  withSecurity(headers, isSecureRequest(request));

  const body = data instanceof RawJson ? data.text : JSON.stringify(data);

  if (init?.etag) {
    headers.set("etag", init.etag);
    if (isNotModified(request, init.etag)) {
      return new Response(null, { status: 304, headers });
    }
  }

  return new Response(gzipIfWorthwhile(request, body, headers), { ...init, headers });
}

export function isSecureRequest(request: Request): boolean {
  if (config.trustProxy) {
    const proto = request.headers.get("x-forwarded-proto");
    if (proto) return proto.split(",", 1)[0]?.trim() === "https";
  }
  try {
    return new URL(request.url).protocol === "https:";
  } catch {
    return false;
  }
}

export function errorResponse(error: unknown, request?: Request): Response {
  const shaped = toErrorResponse(error);
  const payload = JSON.stringify({
    error: { code: shaped.code, message: shaped.message, details: shaped.details ?? null },
  });
  const headers = new Headers({ "content-type": JSON_CONTENT_TYPE });
  withSecurity(headers, request ? isSecureRequest(request) : false);
  if (shaped.status === 401) headers.set("www-authenticate", 'Basic realm="GitGood"');
  const retryAfter = (shaped.details as { retry_after_seconds?: unknown } | null | undefined)?.retry_after_seconds;
  if (typeof retryAfter === "number" && Number.isFinite(retryAfter)) {
    headers.set("retry-after", String(Math.max(1, Math.ceil(retryAfter))));
  }
  return new Response(
    request ? gzipIfWorthwhile(request, payload, headers) : payload,
    { status: shaped.status, headers },
  );
}

export function text(body: string, status = 200, request?: Request): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8", ...securityHeaders(request ? isSecureRequest(request) : false) },
  });
}

export async function readJson<T>(request: Request, schema: Validator<T>): Promise<T> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > config.maxJsonBodyBytes) {
    throw payloadTooLarge(`JSON body exceeds ${config.maxJsonBodyBytes} bytes`);
  }
  const raw = await request.text();
  if (raw.length > config.maxJsonBodyBytes) {
    throw payloadTooLarge(`JSON body exceeds ${config.maxJsonBodyBytes} bytes`);
  }
  let parsed: unknown;
  try {
    parsed = raw.length === 0 ? {} : JSON.parse(raw);
  } catch {
    throw badRequest("Request body is not valid JSON");
  }
  return schema.parse(parsed, "body");
}

export function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get("cookie");
  if (!header) return null;
  let start = 0;
  while (start < header.length) {
    let end = header.indexOf(";", start);
    if (end === -1) end = header.length;
    let eq = header.indexOf("=", start);
    if (eq !== -1 && eq < end) {
      const key = header.slice(start, eq).trim();
      if (key === name) return decodeURIComponent(header.slice(eq + 1, end).trim());
    }
    start = end + 1;
  }
  return null;
}

export function serializeCookie(
  name: string,
  value: string,
  options: { maxAge?: number; path?: string; httpOnly?: boolean; sameSite?: string; secure?: boolean } = {},
): string {
  const parts = [`${name}=${encodeURIComponent(value)}`];
  parts.push(`Path=${options.path ?? "/"}`);
  if (options.maxAge !== undefined) parts.push(`Max-Age=${options.maxAge}`);
  if (options.httpOnly !== false) parts.push("HttpOnly");
  parts.push(`SameSite=${options.sameSite ?? "Lax"}`);
  if (options.secure) parts.push("Secure");
  return parts.join("; ");
}

export function isCrossSiteWrite(request: Request, url: URL): boolean {
  if (request.method === "GET" || request.method === "HEAD" || request.method === "OPTIONS") return false;
  if (request.headers.has("authorization")) return false;
  if (!request.headers.get("cookie")) return false;
  const site = request.headers.get("sec-fetch-site");
  if (site === "cross-site") return true;
  const origin = request.headers.get("origin");
  if (!origin || origin === "null") return origin === "null";
  return origin !== publicOrigin(request, url) && origin !== url.origin;
}

export function publicOrigin(request: Request, url: URL): string {
  if (config.trustProxy) {
    const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host");
    if (host) {
      const proto = request.headers.get("x-forwarded-proto") ?? url.protocol.replace(":", "");
      return `${proto}://${host}`;
    }
  }
  return url.origin;
}

export function clearCookie(name: string): string {
  return serializeCookie(name, "", { maxAge: 0 });
}

export function clientIp(request: Request, server?: { requestIP?: (r: Request) => { address: string } | null }): string {
  if (config.trustProxy) {
    const forwarded = request.headers.get("x-forwarded-for");
    if (forwarded) {
      const first = forwarded.split(",", 1)[0];
      if (first) return first.trim();
    }
    const real = request.headers.get("x-real-ip");
    if (real) return real.trim();
  }
  const fromServer = server?.requestIP?.(request);
  return fromServer?.address ?? "0.0.0.0";
}

export type AuthHeader =
  | { kind: "basic"; username: string; password: string }
  | { kind: "bearer"; token: string }
  | { kind: "none" };

export function parseAuthHeader(request: Request): AuthHeader {
  const header = request.headers.get("authorization");
  if (!header) return { kind: "none" };
  const space = header.indexOf(" ");
  if (space === -1) return { kind: "none" };
  const scheme = header.slice(0, space).toLowerCase();
  const value = header.slice(space + 1).trim();
  if (scheme === "basic") {
    const decoded = (() => {
      try {
        return Buffer.from(value, "base64").toString("utf8");
      } catch {
        return "";
      }
    })();
    const colon = decoded.indexOf(":");
    if (colon === -1) return { kind: "none" };
    return { kind: "basic", username: decoded.slice(0, colon), password: decoded.slice(colon + 1) };
  }
  if (scheme === "bearer" || scheme === "token") {
    return { kind: "bearer", token: value };
  }
  return { kind: "none" };
}

export function weakEtag(payload: string | ArrayBuffer | Uint8Array): string {
  const bytes =
    typeof payload === "string"
      ? new TextEncoder().encode(payload)
      : payload instanceof Uint8Array
        ? payload
        : new Uint8Array(payload);
  const digest = new Bun.CryptoHasher("sha1").update(bytes).digest("hex").slice(0, 20);
  return `W/"${bytes.byteLength.toString(16)}-${digest}"`;
}

export function binaryResponse(
  bytes: Uint8Array,
  headers: Record<string, string>,
  status = 200,
): Response {
  if (status === 204 || status === 304) {
    return new Response(null, { status, headers });
  }
  return new Response(bytes as unknown as BodyInit, { status, headers });
}

function withoutWeakness(tag: string): string {
  return tag.trim().replace(/^W\//i, "").trim();
}

export function isNotModified(request: Request, etag: string): boolean {
  const header = request.headers.get("if-none-match");
  if (header === null) return false;

  const value = header.trim();
  if (value === "*") return true;

  const target = withoutWeakness(etag);
  for (const candidate of value.split(",")) {
    if (candidate.trim().length === 0) continue;
    if (withoutWeakness(candidate) === target) return true;
  }
  return false;
}

export function methodNotAllowed(allowed: readonly string[]): AppError {
  const error = new AppError("bad_request", "Method not allowed");
  (error as { allowed?: string[] }).allowed = [...allowed];
  return error;
}

import { UploadThrottle, validateUploadRate } from "./upload-throttle.ts";

export const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.file";
export const DEFAULT_CHUNK_BYTES = 8 * 1024 * 1024;
const CHUNK_ALIGN = 256 * 1024;
const RESPONSE_LIMIT = 256 * 1024;
const REQUEST_TIMEOUT_MS = 30_000;
const CHUNK_TIMEOUT_MS = 10 * 60_000;
const MAX_ATTEMPTS = 5;
const FOLDER_MIME = "application/vnd.google-apps.folder";

export interface GoogleClient {
  clientId: string;
  clientSecret: string;
}

export interface TokenSource {
  token(): Promise<string>;
  refresh(): Promise<string>;
}

export class GoogleError extends Error {
  constructor(message: string, readonly reason: string, readonly status = 0) {
    super(message);
    this.name = "GoogleError";
  }
}

function oauthBase(): string {
  return process.env.GITGOOD_GOOGLE_ENDPOINT ?? "https://oauth2.googleapis.com";
}

function apiBase(): string {
  return process.env.GITGOOD_GOOGLE_ENDPOINT ?? "https://www.googleapis.com";
}

async function readLimited(response: Response): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > RESPONSE_LIMIT) {
      await reader.cancel();
      throw new GoogleError("Google returned an unexpectedly large response", "too_large", response.status);
    }
    parts.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(parts));
}

async function send(url: string, init: RequestInit, timeoutMs = REQUEST_TIMEOUT_MS, bodyFactory?: (signal: AbortSignal) => BodyInit): Promise<{ status: number; headers: Headers; body: Record<string, any> }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let response: Response;
    try {
      response = await fetch(url, {
        ...init,
        ...(bodyFactory ? { body: bodyFactory(controller.signal) } : {}),
        redirect: "manual",
        signal: controller.signal,
      });
    } catch {
      throw new GoogleError("Could not reach Google", "network");
    }
    const text = await readLimited(response);
    let body: Record<string, any> = {};
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = {};
      }
    }
    return { status: response.status, headers: response.headers, body };
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

function form(values: Record<string, string>): RequestInit {
  return { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(values).toString() };
}

function apiError(status: number, body: Record<string, any>): GoogleError {
  const reason = String(body?.error?.errors?.[0]?.reason ?? body?.error?.status ?? body?.error ?? "error");
  if (reason === "storageQuotaExceeded") return new GoogleError("Google Drive is out of storage space", reason, status);
  if (status === 401) return new GoogleError("Google rejected the access token", "unauthorized", status);
  if (reason === "accessNotConfigured" || reason === "SERVICE_DISABLED") return new GoogleError("The Google Drive API is not enabled for this OAuth client's project", reason, status);
  if (status === 403) return new GoogleError("Google Drive refused the request", reason, status);
  if (status === 404) return new GoogleError("The file or folder no longer exists in Google Drive", "notFound", status);
  return new GoogleError(`Google Drive returned an error (${status})`, reason, status);
}

export interface DeviceCode {
  deviceCode: string;
  userCode: string;
  verificationUrl: string;
  expiresIn: number;
  interval: number;
}

export async function requestDeviceCode(client: GoogleClient): Promise<DeviceCode> {
  const { status, body } = await send(`${oauthBase()}/device/code`, form({ client_id: client.clientId, scope: DRIVE_SCOPE }));
  if (status !== 200 || typeof body.device_code !== "string" || typeof body.user_code !== "string") {
    if (body.error === "invalid_client") throw new GoogleError("Google did not accept the OAuth client ID. Check it is a “TVs and Limited Input devices” client.", "invalid_client", status);
    if (body.error === "invalid_scope") throw new GoogleError("Google did not allow Drive access for this client", "invalid_scope", status);
    throw new GoogleError("Google could not start sign-in", String(body.error ?? "error"), status);
  }
  const verification = String(body.verification_url ?? body.verification_uri ?? "https://www.google.com/device");
  return {
    deviceCode: body.device_code,
    userCode: body.user_code,
    verificationUrl: /^https:\/\//.test(verification) ? verification : "https://www.google.com/device",
    expiresIn: Math.max(60, Math.min(1800, Number(body.expires_in) || 1800)),
    interval: Math.max(1, Math.min(60, Number(body.interval) || 5)),
  };
}

export type DevicePoll =
  | { state: "pending" | "slow_down" | "denied" | "expired" }
  | { state: "authorized"; accessToken: string; refreshToken: string };

export async function pollDeviceToken(client: GoogleClient, deviceCode: string): Promise<DevicePoll> {
  const { status, body } = await send(
    `${oauthBase()}/token`,
    form({ client_id: client.clientId, client_secret: client.clientSecret, device_code: deviceCode, grant_type: "urn:ietf:params:oauth:grant-type:device_code" }),
  );
  if (status === 200 && typeof body.access_token === "string") {
    if (typeof body.refresh_token !== "string") throw new GoogleError("Google did not return a refresh token", "no_refresh_token", status);
    return { state: "authorized", accessToken: body.access_token, refreshToken: body.refresh_token };
  }
  if (body.error === "authorization_pending") return { state: "pending" };
  if (body.error === "slow_down") return { state: "slow_down" };
  if (body.error === "access_denied") return { state: "denied" };
  if (body.error === "expired_token") return { state: "expired" };
  if (body.error === "invalid_client") throw new GoogleError("Google did not accept the OAuth client secret", "invalid_client", status);
  throw new GoogleError("Google sign-in failed", String(body.error ?? "error"), status);
}

export async function refreshAccessToken(client: GoogleClient, refreshToken: string): Promise<string> {
  const { status, body } = await send(
    `${oauthBase()}/token`,
    form({ client_id: client.clientId, client_secret: client.clientSecret, refresh_token: refreshToken, grant_type: "refresh_token" }),
  );
  if (status === 200 && typeof body.access_token === "string") return body.access_token;
  if (body.error === "invalid_grant") throw new GoogleError("Google access was revoked or expired; reconnect the account in Admin → Backups", "invalid_grant", status);
  if (body.error === "invalid_client") throw new GoogleError("Google did not accept the OAuth client credentials", "invalid_client", status);
  throw new GoogleError("Could not refresh Google access", String(body.error ?? "error"), status);
}

export function tokenSource(client: GoogleClient, refreshToken: string): TokenSource {
  let current: string | null = null;
  return {
    async token() {
      current ??= await refreshAccessToken(client, refreshToken);
      return current;
    },
    async refresh() {
      current = await refreshAccessToken(client, refreshToken);
      return current;
    },
  };
}

async function authorized(tokens: TokenSource, url: string, init: RequestInit = {}, timeoutMs = REQUEST_TIMEOUT_MS, bodyFactory?: (signal: AbortSignal) => BodyInit) {
  let result = await send(url, { ...init, headers: { ...(init.headers as Record<string, string>), authorization: `Bearer ${await tokens.token()}` } }, timeoutMs, bodyFactory);
  if (result.status === 401) {
    result = await send(url, { ...init, headers: { ...(init.headers as Record<string, string>), authorization: `Bearer ${await tokens.refresh()}` } }, timeoutMs, bodyFactory);
  }
  return result;
}

export interface DriveAccount {
  email: string;
  name: string;
  freeBytes: number | null;
}

export async function driveAccount(tokens: TokenSource): Promise<DriveAccount> {
  const { status, body } = await authorized(tokens, `${apiBase()}/drive/v3/about?fields=user(emailAddress,displayName),storageQuota(limit,usage)`);
  if (status !== 200) throw apiError(status, body);
  const limit = Number(body.storageQuota?.limit);
  const usage = Number(body.storageQuota?.usage ?? 0);
  return {
    email: String(body.user?.emailAddress ?? ""),
    name: String(body.user?.displayName ?? ""),
    freeBytes: Number.isFinite(limit) && limit > 0 ? Math.max(0, limit - usage) : null,
  };
}

function quoteQuery(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

export async function ensureFolder(tokens: TokenSource, name: string): Promise<string> {
  const q = `name = '${quoteQuery(name)}' and mimeType = '${FOLDER_MIME}' and trashed = false and 'root' in parents`;
  const found = await authorized(tokens, `${apiBase()}/drive/v3/files?${new URLSearchParams({ q, fields: "files(id)", pageSize: "1", spaces: "drive" })}`);
  if (found.status !== 200) throw apiError(found.status, found.body);
  const existing = found.body.files?.[0]?.id;
  if (typeof existing === "string") return existing;
  const created = await authorized(tokens, `${apiBase()}/drive/v3/files?fields=id`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name, mimeType: FOLDER_MIME, parents: ["root"] }),
  });
  if (created.status !== 200 || typeof created.body.id !== "string") throw apiError(created.status, created.body);
  return created.body.id;
}

export async function deleteDriveFile(tokens: TokenSource, fileId: string): Promise<boolean> {
  if (!/^[\w-]{10,200}$/.test(fileId)) return false;
  const { status, body } = await authorized(tokens, `${apiBase()}/drive/v3/files/${fileId}`, { method: "DELETE" });
  if (status === 204 || status === 200 || status === 404) return true;
  throw apiError(status, body);
}

export async function revokeGoogleToken(token: string): Promise<void> {
  await send(`${oauthBase()}/revoke`, form({ token })).catch(() => undefined);
}

export function driveFileUrl(fileId: string): string {
  return `https://drive.google.com/file/d/${fileId}/view`;
}

export function driveFileIdFromUrl(url: string | null): string | null {
  const match = /^https:\/\/drive\.google\.com\/file\/d\/([\w-]{10,200})\/view$/.exec(url ?? "");
  return match ? match[1]! : null;
}

export interface UploadResult {
  id: string;
  size: number;
  md5: string;
}

function acknowledged(headers: Headers): number {
  const range = headers.get("range");
  const match = range ? /^bytes=0-(\d+)$/.exec(range) : null;
  return match ? Number(match[1]) + 1 : 0;
}

function sameOrigin(candidate: string): boolean {
  try {
    return new URL(candidate).origin === new URL(apiBase()).origin;
  } catch {
    return false;
  }
}

export async function uploadStream(
  tokens: TokenSource,
  folderId: string,
  name: string,
  stream: ReadableStream<Uint8Array>,
  options: { chunkBytes?: number; mimeType?: string; bytesPerSecond?: number } = {},
): Promise<UploadResult> {
  const chunkBytes = Math.max(CHUNK_ALIGN, Math.floor((options.chunkBytes ?? DEFAULT_CHUNK_BYTES) / CHUNK_ALIGN) * CHUNK_ALIGN);
  const mimeType = options.mimeType ?? "application/x-tar";
  const bytesPerSecond = validateUploadRate(options.bytesPerSecond);
  const throttle = new UploadThrottle(bytesPerSecond);
  const start = await authorized(tokens, `${apiBase()}/upload/drive/v3/files?uploadType=resumable&fields=id,size,md5Checksum`, {
    method: "POST",
    headers: { "content-type": "application/json; charset=UTF-8", "x-upload-content-type": mimeType },
    body: JSON.stringify({ name, parents: [folderId], mimeType }),
  });
  const session = start.headers.get("location");
  if (start.status !== 200 || !session) throw apiError(start.status, start.body);
  if (!sameOrigin(session)) throw new GoogleError("Google returned an unexpected upload address", "bad_location");

  const hasher = new Bun.CryptoHasher("md5");
  const reader = stream.getReader();
  let pending: Uint8Array[] = [];
  let pendingBytes = 0;
  let offset = 0;
  let total = 0;
  let ended = false;

  const fill = async (): Promise<void> => {
    while (!ended && pendingBytes <= chunkBytes) {
      const { done, value } = await reader.read();
      if (done) {
        ended = true;
        break;
      }
      hasher.update(value);
      total += value.byteLength;
      pending.push(value);
      pendingBytes += value.byteLength;
    }
  };

  const take = (count: number): Uint8Array => {
    const joined = Buffer.concat(pending, pendingBytes);
    const head = joined.subarray(0, count);
    const rest = joined.subarray(count);
    pending = rest.byteLength ? [rest] : [];
    pendingBytes = rest.byteLength;
    return head;
  };

  const peek = (count: number): Uint8Array => Buffer.concat(pending, pendingBytes).subarray(0, count);

  try {
    for (;;) {
      await fill();
      const final = ended && pendingBytes <= chunkBytes;
      const size = final ? pendingBytes : chunkBytes;
      const body = peek(size);
      const range = size === 0 ? `bytes */${total}` : `bytes ${offset}-${offset + size - 1}/${final ? total : "*"}`;
      let result: Awaited<ReturnType<typeof send>> | null = null;
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
        try {
          const timeout = Math.min(2_147_483_647, CHUNK_TIMEOUT_MS + (bytesPerSecond > 0 ? Math.ceil((body.byteLength * 1000) / bytesPerSecond) : 0));
          result = await authorized(tokens, session, {
            method: "PUT",
            headers: { "content-range": range, "content-type": mimeType, "content-length": String(body.byteLength) },
            ...(bytesPerSecond === 0 ? { body: new Blob([body as Uint8Array<ArrayBuffer>]) } : {}),
          }, timeout, bytesPerSecond > 0 ? (signal) => throttle.body(body, signal) : undefined);
        } catch (error) {
          if (!(error instanceof GoogleError) || error.reason !== "network") throw error;
          result = null;
        }
        if (result && (result.status < 500 && result.status !== 429)) break;
        if (attempt === MAX_ATTEMPTS) throw new GoogleError("Google Drive kept failing during the upload", "retries_exhausted", result?.status ?? 0);
        await Bun.sleep(Math.min(16_000, 500 * 2 ** attempt));
        const probe = await authorized(tokens, session, { method: "PUT", headers: { "content-range": `bytes */${final ? total : "*"}` } }).catch(() => null);
        if (probe && (probe.status === 200 || probe.status === 201)) {
          result = probe;
          break;
        }
        if (probe?.status === 308) {
          const received = acknowledged(probe.headers);
          if (received > offset) {
            result = probe;
            break;
          }
        }
      }
      if (!result) throw new GoogleError("Google Drive kept failing during the upload", "retries_exhausted");
      if (result.status === 200 || result.status === 201) {
        const id = result.body.id;
        const md5 = String(result.body.md5Checksum ?? "");
        const uploaded = Number(result.body.size ?? total);
        const expected = hasher.digest("hex");
        if (typeof id !== "string") throw new GoogleError("Google Drive did not return the uploaded file", "no_id");
        if (uploaded !== total || (md5 && md5 !== expected)) throw new GoogleError("The uploaded file did not match what was sent", "checksum_mismatch");
        return { id, size: total, md5: expected };
      }
      if (result.status === 308) {
        const received = acknowledged(result.headers);
        if (received < offset) throw new GoogleError("Google Drive lost part of the upload", "regressed");
        if (received > offset) take(received - offset);
        offset = Math.max(offset, received);
        continue;
      }
      if (result.status === 404 || result.status === 410) throw new GoogleError("The Google Drive upload session expired", "session_expired", result.status);
      throw apiError(result.status, result.body);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

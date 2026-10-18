import { config } from "../config.ts";
import { badRequest, forbidden, notFound, unauthorized, unprocessable } from "../lib/errors.ts";
import { publicOrigin, readJson } from "../lib/http.ts";
import * as v from "../lib/validate.ts";
import { increment, observe } from "../lib/metrics.ts";
import { canRead, canWrite, type RepoRecord } from "../data/repos.ts";
import { createLock, deleteLock, listLocks } from "./locks.ts";
import { isValidOid, objectExists, objectStat, putObjectFromStream, readObject, streamMatchesOid } from "./store.ts";
import { repoCanAccessObject } from "./access.ts";
import { recordRepoObject } from "./usage.ts";
import type { Auth } from "../auth/service.ts";

const LFS_CONTENT_TYPE = "application/vnd.git-lfs+json";

function lfsJson(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": LFS_CONTENT_TYPE,
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}

function lfsError(status: number, message: string): Response {
  return lfsJson({ message, documentation_url: `${config.baseUrl}/docs/lfs` }, status);
}

const batchSchema = v.object({
  operation: v.enumOf(["download", "upload"] as const),
  transfers: v.optional(v.array(v.string())),
  ref: v.optional(v.object({ name: v.string() })),
  hash_algo: v.optional(v.string()),
  objects: v.array(
    v.object({
      oid: v.string(),
      size: v.number({ int: true, min: 0 }),
    }),
    { max: 1000 },
  ),
});

const verifySchema = v.object({
  oid: v.optional(v.string()),
  size: v.optional(v.number({ int: true, min: 0 })),
});

const lockSchema = v.object({
  path: v.string({ min: 1, max: 1024 }),
  ref: v.optional(v.object({ name: v.string() })),
});

const unlockSchema = v.object({ force: v.optional(v.boolean()) });

function assertReadAccess(repo: RepoRecord, auth: Auth): void {
  if (canRead(repo, auth)) return;
  throw auth.kind === "anonymous" ? unauthorized("Authentication required") : forbidden();
}

function assertWriteAccess(repo: RepoRecord, auth: Auth): void {
  if (auth.kind === "anonymous") throw unauthorized("Authentication required");
  if (!canWrite(repo, auth)) throw forbidden("You do not have write access to this repository");
  if (repo.lfs_enabled !== 1) throw forbidden("Git LFS is disabled for this repository");
}

function objectHref(repo: RepoRecord, oid: string, origin: string): string {
  return `${origin}/${repo.owner_username}/${repo.name}.git/info/lfs/objects/${oid}`;
}

function actionAuthHeaders(request: Request): { header?: Record<string, string> } {
  const incoming = request.headers.get("authorization");
  return incoming ? { header: { Authorization: incoming } } : {};
}

interface BatchResponseObject {
  oid: string;
  size: number;
  authenticated?: boolean;
  actions?: Record<string, { href: string; expires_in: number; header?: Record<string, string> }>;
  error?: { code: number; message: string };
}

async function handleBatch(
  request: Request,
  repo: RepoRecord,
  auth: Auth,
  origin: string,
): Promise<Response> {
  const body = await readJson(request, batchSchema);

  if (body.hash_algo !== undefined && body.hash_algo !== "sha256") {
    return lfsError(400, `Unsupported hash algorithm: ${body.hash_algo}`);
  }

  const isUpload = body.operation === "upload";
  if (isUpload) assertWriteAccess(repo, auth);
  else assertReadAccess(repo, auth);

  const authenticated = auth.kind === "user";
  const expiresIn = 3600;
  const objects: BatchResponseObject[] = [];
  const actionHeaders = actionAuthHeaders(request);

  for (const declared of body.objects) {
    if (!isValidOid(declared.oid)) {
      objects.push({
        oid: declared.oid,
        size: declared.size,
        error: { code: 422, message: "oid must be a 64-character lowercase SHA-256 hex digest" },
      });
      continue;
    }

    if (isUpload) {
      if (objectExists(declared.oid) && repoCanAccessObject(repo, declared.oid)) {
        objects.push({ oid: declared.oid, size: declared.size, authenticated });
        continue;
      }
      objects.push({
        oid: declared.oid,
        size: declared.size,
        authenticated,
        actions: {
          upload: { href: objectHref(repo, declared.oid, origin), expires_in: expiresIn, ...actionHeaders },
        },
      });
      continue;
    }

    const stat = repoCanAccessObject(repo, declared.oid) ? objectStat(declared.oid) : null;
    if (!stat) {
      objects.push({
        oid: declared.oid,
        size: declared.size,
        error: { code: 404, message: "Object does not exist" },
      });
      continue;
    }
    objects.push({
      oid: declared.oid,
      size: stat.size,
      authenticated,
      actions: {
        download: { href: objectHref(repo, declared.oid, origin), expires_in: expiresIn, ...actionHeaders },
      },
    });
  }

  increment("lfs_batch_requests_total");
  return lfsJson({ transfer: "basic", objects, hash_algo: "sha256" });
}

async function handleUpload(
  request: Request,
  repo: RepoRecord,
  auth: Auth,
  oid: string,
): Promise<Response> {
  assertWriteAccess(repo, auth);
  if (!request.body) throw badRequest("Missing LFS object body");
  const started = performance.now();
  if (isValidOid(oid) && objectExists(oid) && !repoCanAccessObject(repo, oid)) {
    if (!(await streamMatchesOid(request.body, oid))) throw unprocessable("Uploaded content does not match the object id");
    recordRepoObject(repo.id, oid);
    increment("lfs_objects_deduplicated_total");
    return new Response(null, { status: 200, headers: { "content-type": LFS_CONTENT_TYPE, "cache-control": "no-store" } });
  }
  const result = await putObjectFromStream(oid, request.body);
  recordRepoObject(repo.id, oid);
  increment(result.stored ? "lfs_objects_stored_total" : "lfs_objects_deduplicated_total");
  observe("lfs_upload_ms", performance.now() - started);
  return new Response(null, {
    status: 200,
    headers: { "content-type": LFS_CONTENT_TYPE, "cache-control": "no-store" },
  });
}

function handleDownload(repo: RepoRecord, auth: Auth, oid: string): Response {
  assertReadAccess(repo, auth);
  if (!isValidOid(oid) || !objectExists(oid) || !repoCanAccessObject(repo, oid)) throw notFound("LFS object not found");
  increment("lfs_objects_served_total");
  return readObject(oid);
}

export async function handleLfsRequest(
  request: Request,
  repo: RepoRecord,
  auth: Auth,
  segments: string[],
  url: URL,
): Promise<Response> {
  const [first, second, third] = segments;

  const origin = publicOrigin(request, url);

  if (first === "objects" && second === "batch" && request.method === "POST") {
    return handleBatch(request, repo, auth, origin);
  }
  if (first === "objects" && second && !third && request.method === "PUT") {
    return handleUpload(request, repo, auth, second);
  }
  if (first === "objects" && second && !third && request.method === "GET") {
    return handleDownload(repo, auth, second);
  }
  if ((first === "objects" && second === "verify") || (first === "verify")) {
    assertWriteAccess(repo, auth);
    const body = await readJson(request, verifySchema);
    increment("lfs_verify_requests_total");

    const oid = body.oid;
    if (oid === undefined || !isValidOid(oid)) {
      return lfsError(422, "oid must be a 64-character lowercase SHA-256 hex digest");
    }
    const stat = objectStat(oid);
    if (!stat) {
      return lfsError(404, "Object does not exist");
    }
    if (body.size !== undefined && body.size !== stat.size) {
      return lfsError(422, `Declared size ${body.size} does not match the stored size ${stat.size}`);
    }
    increment("lfs_verify_ok_total");
    return lfsJson({ oid, size: stat.size });
  }

  if (first === "locks") {
    return handleLocks(request, repo, auth, segments.slice(1), url);
  }

  return lfsError(404, `Unsupported LFS endpoint: ${segments.join("/")}`);
}

async function handleLocks(
  request: Request,
  repo: RepoRecord,
  auth: Auth,
  segments: string[],
  url: URL,
): Promise<Response> {
  const [first, second] = segments;

  if (first === undefined && request.method === "GET") {
    assertReadAccess(repo, auth);
    const id = url.searchParams.get("id");
    const path = url.searchParams.get("path");
    const limit = v.toInt(url.searchParams.get("limit"), 100, 1, 1000);
    const locks = listLocks(repo.id, {
      ...(id ? { id: Number.parseInt(id, 10) } : {}),
      ...(path ? { path } : {}),
    }).slice(0, limit);
    return lfsJson({ locks: locks.map(serializeLock), next_cursor: "" });
  }

  if (first === undefined && request.method === "POST") {
    assertWriteAccess(repo, auth);
    if (auth.kind !== "user") throw unauthorized();
    const body = await readJson(request, lockSchema);
    const lock = createLock(repo.id, body.path, auth.userId);
    increment("lfs_locks_created_total");
    return lfsJson({ lock: serializeLock(lock) }, 201);
  }

  if (first === "verify" && request.method === "POST") {
    assertReadAccess(repo, auth);
    const all = listLocks(repo.id);
    const ours = auth.kind === "user" ? all.filter((lock) => lock.user_id === auth.userId) : [];
    const theirs = auth.kind === "user" ? all.filter((lock) => lock.user_id !== auth.userId) : all;
    return lfsJson({ ours: ours.map(serializeLock), theirs: theirs.map(serializeLock), next_cursor: "" });
  }

  if (first !== undefined && second === "unlock" && request.method === "POST") {
    assertWriteAccess(repo, auth);
    const body = await readJson(request, unlockSchema);
    const id = Number.parseInt(first, 10);
    if (!Number.isFinite(id)) throw badRequest("Invalid lock id");
    const force = body.force === true && auth.kind === "user" && auth.scopes.includes("admin");
    const lock = deleteLock(repo.id, id, force ? null : auth.kind === "user" ? auth.userId : null);
    if (!lock) throw notFound("Lock not found or owned by another user");
    increment("lfs_locks_released_total");
    return lfsJson({ lock: serializeLock(lock) });
  }

  return lfsError(404, `Unsupported lock endpoint: ${segments.join("/")}`);
}

function serializeLock(lock: { id: number; path: string; user_id: number; created_at: number; owner_username: string }): Record<string, unknown> {
  return {
    id: String(lock.id),
    path: lock.path,
    locked_at: new Date(lock.created_at).toISOString(),
    owner: { name: lock.owner_username },
  };
}

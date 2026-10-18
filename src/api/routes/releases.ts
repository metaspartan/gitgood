import * as v from "../../lib/validate.ts";
import { badRequest, conflict, notFound } from "../../lib/errors.ts";
import { GIT_REF_PATTERN, GIT_REV_PATTERN } from "../../lib/ids.ts";
import { findUserById, requireWrite } from "../../auth/service.ts";
import { loadReadableRepo, loadWritableRepo, param } from "../helpers.ts";
import { createTag, resolveRef } from "../../git/repo.ts";
import { canWrite, repoDiskPath, type RepoRecord } from "../../data/repos.ts";
import { dispatchWebhooks } from "../../data/webhooks.ts";
import { invalidateRepo } from "../../data/git-reads.ts";
import {
  addAsset,
  assetPath,
  ensureAssetDir,
  countDownload,
  createRelease,
  deleteAsset,
  deleteRelease,
  getAsset,
  getRelease,
  getReleaseByTag,
  listAssets,
  listReleases,
  sha256Hex,
  updateRelease,
  type ReleaseAssetRow,
  type ReleaseWithAuthor,
} from "../../data/releases.ts";
import type { Router } from "../router.ts";

const MAX_ASSET_BYTES = 50 * 1024 * 1024;

function releaseJson(release: ReleaseWithAuthor, assets: ReleaseAssetRow[]): Record<string, unknown> {
  return {
    id: release.id,
    tag_name: release.tag_name,
    name: release.name,
    body: release.body,
    prerelease: release.prerelease === 1,
    draft: release.draft === 1,
    author: release.author_username,
    created_at: release.created_at,
    updated_at: release.updated_at,
    assets: assets.map((asset) => ({
      id: asset.id,
      name: asset.name,
      size: asset.size,
      content_type: asset.content_type,
      downloads: asset.downloads,
    })),
  };
}

async function ensureTag(repo: RepoRecord, tagName: string, target: string | undefined): Promise<string> {
  const path = repoDiskPath(repo);
  const existing = await resolveRef(path, tagName);
  if (existing) return existing;
  const sha = await resolveRef(path, target ?? repo.default_branch);
  if (!sha) throw notFound(`Cannot find the target revision: ${target ?? repo.default_branch}`);
  await createTag(path, tagName, sha);
  return sha;
}

export function registerReleaseRoutes(router: Router): void {
  router.get("/api/repos/:owner/:name/releases", (ctx) => {
    const repo = loadReadableRepo(ctx);
    const releases = listReleases(repo.id, canWrite(repo, ctx.auth));
    return jsonList(releases);
  });

  router.post("/api/repos/:owner/:name/releases", async (ctx) => {
    const repo = loadWritableRepo(ctx);
    const principal = requireWrite(ctx.auth);
    const author = findUserById(principal.userId);
    if (!author) throw badRequest("Unknown account");

    const body = await readJson(ctx.request, createSchema);
    if (getReleaseByTag(repo.id, body.tag_name)) {
      throw conflict(`A release for tag ${body.tag_name} already exists`);
    }
    const sha = await ensureTag(repo, body.tag_name, body.target);
    invalidateRepo(repo.id);

    const id = createRelease({
      repoId: repo.id,
      tagName: body.tag_name,
      name: body.name?.trim() ?? "",
      body: body.body ?? "",
      prerelease: body.prerelease ?? false,
      draft: body.draft ?? false,
      authorId: author.id,
    });
    const release = getRelease(repo.id, id);
    if (!release) throw badRequest("Release could not be read back");

    dispatchWebhooks(repo.id, {
      event: "release",
      payload: {
        action: "published",
        release: { tag_name: release.tag_name, name: release.name, prerelease: release.prerelease === 1 },
        tag_sha: sha,
      },
    });
    return created(releaseJson(release, listAssets(id)));
  });

  router.patch("/api/repos/:owner/:name/releases/:id", async (ctx) => {
    const repo = loadWritableRepo(ctx);
    requireWrite(ctx.auth);
    const id = parseId(ctx);
    const body = await readJson(ctx.request, patchSchema);
    if (!updateRelease(repo.id, id, body)) throw notFound("No such release");
    const release = getRelease(repo.id, id);
    if (!release) throw notFound("No such release");
    return jsonOk(releaseJson(release, listAssets(id)));
  });

  router.delete("/api/repos/:owner/:name/releases/:id", (ctx) => {
    const repo = loadWritableRepo(ctx);
    requireWrite(ctx.auth);
    if (!deleteRelease(repo.id, parseId(ctx))) throw notFound("No such release");
    return jsonOk({ ok: true });
  });

  router.post("/api/repos/:owner/:name/releases/:id/assets", async (ctx) => {
    const repo = loadWritableRepo(ctx);
    requireWrite(ctx.auth);
    const releaseId = parseId(ctx);
    const release = getRelease(repo.id, releaseId);
    if (!release) throw notFound("No such release");

    const name = sanitizeAssetName(ctx.url.searchParams.get("name") ?? "");
    if (!name) throw badRequest("An asset name is required (?name=...)");

    const declared = Number.parseInt(ctx.request.headers.get("content-length") ?? "", 10);
    if (Number.isFinite(declared) && declared > MAX_ASSET_BYTES) {
      throw badRequest(`Assets are limited to ${Math.floor(MAX_ASSET_BYTES / (1024 * 1024))} MiB`);
    }
    const bytes = new Uint8Array(await ctx.request.arrayBuffer());
    if (bytes.byteLength === 0) throw badRequest("The asset body is empty");
    if (bytes.byteLength > MAX_ASSET_BYTES) {
      throw badRequest(`Assets are limited to ${Math.floor(MAX_ASSET_BYTES / (1024 * 1024))} MiB`);
    }

    const assetId = addAsset({
      releaseId,
      name,
      size: bytes.byteLength,
      contentType: ctx.request.headers.get("content-type") ?? "application/octet-stream",
      sha256: sha256Hex(bytes),
    });
    try {
      ensureAssetDir(repo.id);
      await Bun.write(assetPath(repo.id, assetId), bytes);
    } catch (cause) {
      deleteAsset(repo.id, releaseId, assetId);
      throw cause instanceof Error ? cause : badRequest("Could not store the asset");
    }
    const asset = getAsset(repo.id, releaseId, assetId);
    return created({ asset: assetJson(asset) });
  });

  router.get("/api/repos/:owner/:name/releases/:id/assets/:assetId", (ctx) => {
    const repo = loadReadableRepo(ctx);
    const releaseId = parseId(ctx);
    const assetId = Number.parseInt(param(ctx, "assetId") ?? "", 10);
    if (!Number.isFinite(assetId)) throw badRequest("Invalid asset id");
    const release = getRelease(repo.id, releaseId);
    if (!release || (release.draft === 1 && !canWrite(repo, ctx.auth))) throw notFound("No such asset");
    const asset = getAsset(repo.id, releaseId, assetId);
    if (!asset) throw notFound("No such asset");
    countDownload(asset.id);
    const safeName = asset.name.replace(/[^\w.\- ]+/g, "_");
    return fileResponse(assetPath(repo.id, asset.id), asset, safeName);
  });
}

function assetJson(asset: ReleaseAssetRow | null): Record<string, unknown> {
  return {
    id: asset?.id ?? 0,
    name: asset?.name ?? "",
    size: asset?.size ?? 0,
    content_type: asset?.content_type ?? "application/octet-stream",
    downloads: asset?.downloads ?? 0,
  };
}

function sanitizeAssetName(raw: string): string {
  const trimmed = raw.trim().replace(/[/\\]/g, "_");
  if (trimmed.length === 0 || trimmed.length > 200) return "";
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) return "";
  return trimmed;
}

function parseId(ctx: { params: Record<string, string | undefined> }): number {
  const id = Number.parseInt(param(ctx as never, "id") ?? "", 10);
  if (!Number.isFinite(id)) throw badRequest("Invalid release id");
  return id;
}

function jsonList(releases: ReleaseWithAuthor[]): Response {
  const payload = releases.map((release) => releaseJson(release, listAssets(release.id)));
  return new Response(JSON.stringify({ items: payload }), {
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function created(payload: Record<string, unknown>): Response {
  return new Response(JSON.stringify(payload), {
    status: 201,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function jsonOk(payload: Record<string, unknown>): Response {
  return new Response(JSON.stringify(payload), {
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function fileResponse(path: string, asset: ReleaseAssetRow, safeName: string): Response {
  return new Response(Bun.file(path), {
    headers: {
      "content-type": asset.content_type,
      "content-length": String(asset.size),
      "content-disposition": `attachment; filename="${safeName}"`,
      "x-content-type-options": "nosniff",
    },
  });
}

const createSchema = v.strictObject({
  tag_name: v.string({ min: 1, max: 255, pattern: GIT_REF_PATTERN }),
  name: v.optional(v.string({ max: 200 })),
  body: v.optional(v.string({ max: 100_000 })),
  prerelease: v.optional(v.boolean()),
  draft: v.optional(v.boolean()),
  target: v.optional(v.string({ min: 1, max: 255, pattern: GIT_REV_PATTERN })),
});

const patchSchema = v.strictObject({
  name: v.optional(v.string({ max: 200 })),
  body: v.optional(v.string({ max: 100_000 })),
  prerelease: v.optional(v.boolean()),
  draft: v.optional(v.boolean()),
});

import { readJson } from "../../lib/http.ts";

import { binaryResponse, isNotModified, json, jsonFor, RawJson, readJson, weakEtag } from "../../lib/http.ts";
import { badRequest, forbidden, notFound, unprocessable } from "../../lib/errors.ts";
import { envelope, parsePage } from "../../lib/pagination.ts";
import * as v from "../../lib/validate.ts";
import { checkEgress } from "../../lib/egress.ts";
import { config } from "../../config.ts";
import { increment, observe } from "../../lib/metrics.ts";
import { log } from "../../lib/logger.ts";
import {
  canRead,
  isOwner,
  canWrite,
  countVisibleRepos,
  createRepository,
  deleteRepository,
  listVisibleRepos,
  listVisibleReposWithTopic,
  repoDiskPath,
  repoGitStats,
  repoStats,
  statsFromCounts,
  updateRepository,
  type RepoRecord,
  type Visibility,
} from "../../data/repos.ts";
import { createLabel, deleteLabel, listLabels } from "../../data/labels.ts";
import {
  listTopicsForRepo,
  normalizeTopic,
  popularTopics,
  pruneTopic,
  setTopicsForRepo,
  topicsPayload,
} from "../../data/topics.ts";
import { topicIdForName } from "../../data/repos.ts";
import { assertOrgRole, findOrg } from "../../data/orgs.ts";
import {
  createWebhook,
  deleteWebhook,
  findWebhook,
  listDeliveries,
  listWebhooksWithStats,
  WEBHOOK_EVENTS,
} from "../../data/webhooks.ts";
import { listLocks } from "../../lfs/locks.ts";
import * as gitRepo from "../../git/repo.ts";
import { assertDirectBranchWriteAllowed } from "../../data/branch-protection.ts";
import * as gitReads from "../../data/git-reads.ts";
import { linkedAuthors } from "../../data/user-emails.ts";
import { refsContaining } from "../../git/refs-containing.ts";
import { BLAME_MAX_LINES, mergePatchMetadata, parseBlamePorcelain, parseUnifiedDiff } from "../../git/diff.ts";
import { countAheadBehind } from "../../git/ahead-behind.ts";
import {
  classifyBlob,
  contentTypeForBlob,
  downloadFilename,
  languageForPath,
} from "../../lib/file-types.ts";
import {
  ARCHIVE_FORMATS,
  archiveFilename,
  archiveFormatInfo,
  archiveStream,
  parseArchiveFormat,
} from "../../git/archive.ts";
import { parseLfsPointer } from "../../lfs/pointer.ts";
import { repoCanAccessObject } from "../../lfs/access.ts";
import { objectFile, objectStat, readObjectBytes, readObjectHead } from "../../lfs/store.ts";
import { GIT_REF_PATTERN } from "../../lib/ids.ts";
import {
  branchJson,
  blameJson,
  commitJson,
  deliveryJson,
  diffJson,
  labelJson,
  lockJson,
  repoJson,
  tagJson,
  treeEntryJson,
  webhookJson,
} from "../serialize.ts";
import { instanceSettings } from "../../data/instance-settings.ts";
import {
  assertSafeRefName,
  assertSafeRevision,
  loadReadableRepo,
  loadWritableRepo,
  optionalQuery,
  param,
  requestedRef,
  revParam,
} from "../helpers.ts";
import type { RouteContext, Router } from "../router.ts";

const MAX_RAW_BYTES = 64 * 1024 * 1024;
const MAX_INLINE_BYTES = gitReads.MAX_CACHED_BLOB_BYTES;
const LFS_SNIFF_BYTES = 512;

const PATCH_LIMITS = {
  maxFiles: 300,
  maxLines: 20_000,
  contextLines: 3,
} as const;

const createRepoSchema = v.strictObject({
  name: v.string({ min: 1, max: 100 }),
  description: v.optional(v.string({ max: 2048 })),
  visibility: v.optional(v.enumOf(["public", "private"] as const)),
  default_branch: v.optional(v.string({ min: 1, max: 255 })),
  lfs_enabled: v.optional(v.boolean()),
  organization: v.optional(v.string({ min: 1, max: 39 })),
});

const updateRepoSchema = v.strictObject({
  description: v.optional(v.string({ max: 2048 })),
  visibility: v.optional(v.enumOf(["public", "private"] as const)),
  default_branch: v.optional(v.string({ min: 1, max: 255 })),
  lfs_enabled: v.optional(v.boolean()),
  actions_enabled: v.optional(v.boolean()),
  archived: v.optional(v.boolean()),
});

const topicsSchema = v.strictObject({
  names: v.optional(v.array(v.string({ max: 64 }), { max: 40 })),
  names_csv: v.optional(v.string({ max: 1200 })),
});

const labelSchema = v.strictObject({
  name: v.string({ min: 1, max: 50 }),
  color: v.optional(v.string({ max: 7 })),
});

const webhookSchema = v.strictObject({
  url: v.string({ min: 8, max: 2048, pattern: /^https?:\/\// }),
  secret: v.optional(v.string({ max: 256 })),
  events: v.optional(v.array(v.string({ max: 32 }), { max: 20 })),
});

const branchSchema = v.strictObject({
  name: v.string({ min: 1, max: 255, pattern: GIT_REF_PATTERN }),
  from: v.optional(v.string({ min: 1, max: 255 })),
});

const README_CANDIDATES = [
  "README.md",
  "README",
  "README.rst",
  "README.txt",
  "readme.md",
  "Readme.md",
  "docs/README.md",
] as const;


function permissionsFor(ctx: RouteContext, repo: RepoRecord): Record<string, boolean> {
  return { read: canRead(repo, ctx.auth), write: canWrite(repo, ctx.auth) };
}

function lfsPointerFor(repo: RepoRecord, bytes: Uint8Array) {
  const pointer = parseLfsPointer(bytes);
  return pointer && repoCanAccessObject(repo, pointer.oid) ? pointer : null;
}

export function registerRepoRoutes(router: Router): void {
  router.get("/api/repos", (ctx) => {
    const page = parsePage(ctx.url);
    const items = listVisibleRepos(ctx.auth, page.perPage, page.offset).map((repo) => ({
      ...repoJson(repo),
      ...statsFromCounts(repo),
    }));
    const total = countVisibleRepos(ctx.auth);
    return jsonFor(ctx.request, envelope(items, page, total), {
      etag: weakEtag(JSON.stringify(items)),
    });
  });

  router.post("/api/repos", async (ctx) => {
    const body = await readJson(ctx.request, createRepoSchema);
    if (ctx.auth.kind !== "user") throw unprocessable("Authentication required");
    const settings = instanceSettings();
    if (!settings.allowRepoCreation && !ctx.auth.isAdmin) {
      throw forbidden("Repository creation is restricted to administrators on this instance");
    }

    let orgId: number | null = null;
    if (body.organization !== undefined) {
      const org = findOrg(body.organization);
      if (!org) throw unprocessable(`Organisation ${body.organization} not found`);
      assertOrgRole(ctx.auth, org.id, "member");
      orgId = org.id;
    }

    const repo = await createRepository(ctx.auth, {
      name: body.name,
      ...(body.description !== undefined ? { description: body.description } : {}),
      visibility: (body.visibility ?? settings.defaultVisibility) as Visibility,
      ...(body.default_branch !== undefined ? { defaultBranch: body.default_branch } : {}),
      ...(body.lfs_enabled !== undefined ? { lfsEnabled: body.lfs_enabled } : {}),
      orgId,
    });
    const created = settings.actionsDefaultEnabled ? repo : updateRepository(repo, { actionsEnabled: false });
    increment("repos_created_total");
    return json({ ...repoJson(created), ...repoStats(created) }, { status: 201 });
  });

  router.get("/api/repos/:owner/:name", async (ctx) => {
    const repo = loadReadableRepo(ctx);
    const stats = await repoGitStats(repo);
    return json({ ...repoJson(repo), stats, permissions: permissionsFor(ctx, repo) });
  });

  router.patch("/api/repos/:owner/:name", async (ctx) => {
    const repo = loadReadableRepo(ctx);
    if (ctx.auth.kind !== "user") throw forbidden("Authentication required");
    if (!isOwner(repo, ctx.auth) && !ctx.auth.isAdmin) {
      throw forbidden("Only the repository owner can change its settings");
    }
    const body = await readJson(ctx.request, updateRepoSchema);
    const updated = updateRepository(repo, {
      ...(body.description !== undefined ? { description: body.description } : {}),
      ...(body.visibility !== undefined ? { visibility: body.visibility as Visibility } : {}),
      ...(body.default_branch !== undefined ? { defaultBranch: body.default_branch } : {}),
      ...(body.lfs_enabled !== undefined ? { lfsEnabled: body.lfs_enabled } : {}),
      ...(body.actions_enabled !== undefined ? { actionsEnabled: body.actions_enabled } : {}),
      ...(body.archived !== undefined ? { archived: body.archived } : {}),
    });
    return json(repoJson(updated));
  });

  router.delete("/api/repos/:owner/:name", async (ctx) => {
    const repo = loadReadableRepo(ctx);
    if (ctx.auth.kind !== "user") throw forbidden("Authentication required");
    if (!isOwner(repo, ctx.auth) && !ctx.auth.isAdmin) {
      throw forbidden("Only the repository owner can delete it");
    }
    await deleteRepository(repo);
    increment("repos_deleted_total");
    return json({ ok: true });
  });

  router.get("/api/repos/:owner/:name/branches", async (ctx) => {
    const repo = loadReadableRepo(ctx);
    const { branches, head } = await gitReads.branchesWithHead(repo);
    return json({
      items: branches.map(branchJson),
      default_branch: repo.default_branch,
      head,
    });
  });

  router.post("/api/repos/:owner/:name/branches", async (ctx) => {
    const repo = loadWritableRepo(ctx);
    const body = await readJson(ctx.request, branchSchema);
    const path = repoDiskPath(repo);
    const from = body.from ?? repo.default_branch;
    const sha = await gitRepo.resolveRef(path, `refs/heads/${from}`);
    if (!sha) throw unprocessable(`Source ref "${from}" does not exist`);
    assertDirectBranchWriteAllowed(repo.id, body.name);
    assertDirectBranchWriteAllowed(repo.id, body.name);
    await gitRepo.updateRef(path, `refs/heads/${body.name}`, sha);
    gitReads.invalidateRepo(repo.id);
    return json({ name: body.name, sha }, { status: 201 });
  });

  router.delete("/api/repos/:owner/:name/branches/:branch", async (ctx) => {
    const repo = loadWritableRepo(ctx);
    const branch = assertSafeRefName(param(ctx, "branch"), "branch");
    if (branch === repo.default_branch) throw badRequest("Cannot delete the default branch");
    assertDirectBranchWriteAllowed(repo.id, branch);
    const deleted = await gitRepo.deleteRef(repoDiskPath(repo), `refs/heads/${branch}`);
    if (!deleted) throw notFound(`Branch "${branch}" not found`);
    gitReads.invalidateRepo(repo.id);
    return json({ ok: true });
  });

  router.get("/api/repos/:owner/:name/tags", async (ctx) => {
    const repo = loadReadableRepo(ctx);
    return json({ items: (await gitReads.tags(repo)).map(tagJson) });
  });

  router.get("/api/repos/:owner/:name/commits", async (ctx) => {
    const repo = loadReadableRepo(ctx);
    const page = parsePage(ctx.url, 30);
    const ref = requestedRef(ctx, repo.default_branch);
    const filePath = optionalQuery(ctx, "path");
    const started = performance.now();
    const commits = await gitReads.commits(repo, ref, {
      limit: page.perPage + 1,
      skip: page.offset,
      ...(filePath ? { filePath } : {}),
    });
    observe("git_log_ms", performance.now() - started);
    const shown = commits.slice(0, page.perPage);
    const authors = linkedAuthors(shown.map((commit) => commit.authorEmail));
    return json({
      items: shown.map((commit) => commitJson(commit, authors)),
      page: page.page,
      per_page: page.perPage,
      has_more: commits.length > page.perPage,
      ref,
    });
  });

  router.get("/api/repos/:owner/:name/compare/:base.../:head", async (ctx) => {
    const repo = loadReadableRepo(ctx);
    const base = decodeURIComponent(param(ctx, "base"));
    const head = decodeURIComponent(param(ctx, "head"));
    if (base === head) throw badRequest("Base and head are the same ref");
    const ahead = await countAheadBehind(repoDiskPath(repo), `refs/heads/${base}`, `refs/heads/${head}`);
    if (!ahead) throw notFound("Unknown base or head branch");
    return json(ahead);
  });

  router.get("/api/repos/:owner/:name/commits/:sha", async (ctx) => {
    const repo = loadReadableRepo(ctx);
    const detail = await gitReads.commitDetail(repo, revParam(ctx, "sha"));
    if (!detail) throw notFound("Commit not found");
    const refs = await refsContaining(repoDiskPath(repo), detail.sha);
    return json({ ...commitJson(detail, linkedAuthors([detail.authorEmail])), refs });
  });

  router.get("/api/repos/:owner/:name/commits/:sha/diff", async (ctx) => {
    const repo = loadReadableRepo(ctx);
    const sha = revParam(ctx, "sha");
    const filePath = optionalQuery(ctx, "path");
    const started = performance.now();
    const patch = await gitRepo.commitPatch(repoDiskPath(repo), sha, {
      ...PATCH_LIMITS,
      ...(filePath ? { filePath } : {}),
    });
    observe("git_diff_ms", performance.now() - started);
    if (!patch) throw notFound("Commit not found, or it changed nothing");

    const result = mergePatchMetadata(patch.files, parseUnifiedDiff(patch.text), patch.truncated);
    return json({
      ...diffJson(result),
      base: `${sha}^`,
      head: sha,
      files_changed: patch.filesChanged,
    });
  });

  router.get("/api/repos/:owner/:name/blame", async (ctx) => {
    const repo = loadReadableRepo(ctx);
    const ref = requestedRef(ctx, repo.default_branch);
    const filePath = optionalQuery(ctx, "path");
    if (!filePath) throw badRequest('Query parameter "path" is required');

    const started = performance.now();
    const text = await gitRepo.blameText(repoDiskPath(repo), ref, filePath, BLAME_MAX_LINES);
    observe("git_blame_ms", performance.now() - started);
    if (text === null) throw notFound("Path not found at this ref");

    const parsed = parseBlamePorcelain(text);
    return json({
      ...blameJson(parsed),
      path: filePath,
      ref,
      language: languageForPath(filePath),
    });
  });

  router.get("/api/repos/:owner/:name/tree", async (ctx) => {
    const repo = loadReadableRepo(ctx);
    const ref = requestedRef(ctx, repo.default_branch);
    const dir = optionalQuery(ctx, "path") ?? "";
    const entries = await gitReads.tree(repo, ref, dir);
    const items = entries.map(treeEntryJson);
    return jsonFor(ctx.request, { ref, path: dir, items }, { etag: weakEtag(JSON.stringify(items)) });
  });

  router.get("/api/repos/:owner/:name/languages", async (ctx) => {
    const repo = loadReadableRepo(ctx);
    const ref = requestedRef(ctx, repo.default_branch);
    const sha = await gitReads.resolveRef(repo, ref);
    if (!sha) return json({ ref, items: [] });
    const items = await gitReads.languages(repo, sha);
    return jsonFor(ctx.request, { ref, sha, items }, { etag: weakEtag(`langs:${sha}`) });
  });

  router.get("/api/repos/:owner/:name/files", async (ctx) => {
    const repo = loadReadableRepo(ctx);
    const ref = requestedRef(ctx, repo.default_branch);
    const sha = await gitReads.resolveRef(repo, ref);
    if (!sha) return json({ sha: null, total: 0, truncated: false, paths: [] });
    const etag = weakEtag(`files:${sha}`);
    if (isNotModified(ctx.request, etag)) return binaryResponse(new Uint8Array(0), { etag }, 304);
    return jsonFor(ctx.request, new RawJson(await gitReads.fileListJson(repo, sha)), { etag });
  });

  router.get("/api/repos/:owner/:name/blob", async (ctx) => {
    const repo = loadReadableRepo(ctx);
    const ref = requestedRef(ctx, repo.default_branch);
    const filePath = optionalQuery(ctx, "path");
    if (!filePath) throw badRequest('Query parameter "path" is required');
    const blob = await gitReads.blob(repo, ref, filePath, MAX_INLINE_BYTES);
    if (!blob) throw notFound("Path not found at this ref");

    let bytes = blob.bytes;
    let size = blob.size;
    let truncated = blob.truncated;
    const pointer = lfsPointerFor(repo, blob.bytes);
    if (pointer) {
      const objectSize = objectStat(pointer.oid)?.size;
      const head = readObjectHead(pointer.oid, LFS_SNIFF_BYTES);
      if (head && objectSize !== undefined) {
        const headKind = classifyBlob(filePath, head, { binary: gitRepo.isBinary(head) });
        bytes = headKind.kind === "text" ? (readObjectBytes(pointer.oid, MAX_INLINE_BYTES) ?? head) : head;
        size = objectSize;
        truncated = headKind.kind === "text" && objectSize > MAX_INLINE_BYTES;
      }
    }

    const binary = gitRepo.isBinary(bytes);
    const classification = classifyBlob(filePath, bytes, { binary });
    const started = performance.now();

    let content: string | null = null;
    let lineCount = 0;
    if (classification.kind === "text") {
      content = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
      for (let i = 0; i < content.length; i++) {
        if (content.charCodeAt(i) === 10) lineCount += 1;
      }
      if (content.length > 0 && content.charCodeAt(content.length - 1) !== 10) lineCount += 1;
    }
    observe("blob_classify_ms", performance.now() - started);

    return json({
      path: filePath,
      ref,
      size,
      truncated,
      binary,
      kind: classification.kind,
      mime: classification.mime,
      language: classification.language ?? languageForPath(filePath),
      line_count: lineCount,
      encoding: classification.kind === "text" ? "utf-8" : "binary",
      content,
    });
  });

  router.get("/api/repos/:owner/:name/raw", async (ctx) => {
    const repo = loadReadableRepo(ctx);
    const ref = requestedRef(ctx, repo.default_branch);
    const filePath = optionalQuery(ctx, "path");
    if (!filePath) throw badRequest('Query parameter "path" is required');
    const blob = await gitReads.blob(repo, ref, filePath, MAX_RAW_BYTES);
    if (!blob) throw notFound("Path not found at this ref");

    const forceDownload = optionalQuery(ctx, "download") === "1";
    const inline = !forceDownload;
    const cacheControl = inline ? "private, max-age=60" : "private, no-store";
    const disposition = forceDownload
      ? `attachment; filename="${downloadFilename(filePath).replace(/"/g, "")}"`
      : "inline";

    const pointer = lfsPointerFor(repo, blob.bytes);
    const lfsFile = pointer ? objectFile(pointer.oid) : null;
    if (pointer && lfsFile) {
      const head = readObjectHead(pointer.oid, LFS_SNIFF_BYTES) ?? blob.bytes;
      return new Response(lfsFile, {
        headers: {
          "content-type": contentTypeForBlob(filePath, head, { binary: gitRepo.isBinary(head) }),
          "content-length": String(lfsFile.size),
          "cache-control": cacheControl,
          "x-content-type-options": "nosniff",
          "content-disposition": disposition,
        },
      });
    }

    const contentType = contentTypeForBlob(filePath, blob.bytes, {
      binary: gitRepo.isBinary(blob.bytes),
    });

    const headers: Record<string, string> = {
      "content-type": contentType,
      "content-length": String(blob.bytes.byteLength),
      "cache-control": cacheControl,
      "x-content-type-options": "nosniff",
      "content-disposition": disposition,
    };
    return binaryResponse(blob.bytes, headers);
  });

  router.get("/api/repos/:owner/:name/diff", async (ctx) => {
    const repo = loadReadableRepo(ctx);
    const base = optionalQuery(ctx, "base");
    if (base !== undefined) assertSafeRevision(base, "base");
    const head = assertSafeRevision(
      optionalQuery(ctx, "head") ?? repo.default_branch,
      "head",
    );
    const filePath = optionalQuery(ctx, "path");
    if (!base) throw badRequest('Query parameters "base" and "head" are required');

    const started = performance.now();
    const patch = await gitRepo.rangePatch(repoDiskPath(repo), base, head, {
      ...PATCH_LIMITS,
      ...(filePath ? { filePath } : {}),
    });
    observe("git_diff_ms", performance.now() - started);

    if (!patch) return json({ files: [], additions: 0, deletions: 0, truncated: false, base, head });
    const result = mergePatchMetadata(patch.files, parseUnifiedDiff(patch.text), patch.truncated);
    return json({
      ...diffJson(result),
      base,
      head,
      files_changed: patch.filesChanged,
    });
  });

  router.get("/api/repos/:owner/:name/readme", async (ctx) => {
    const repo = loadReadableRepo(ctx);
    const ref = requestedRef(ctx, repo.default_branch);
    const sizes = await gitReads.candidateBlobSizes(repo, ref, README_CANDIDATES);
    for (const candidate of README_CANDIDATES) {
      const size = sizes.get(candidate);
      if (size === undefined || size > MAX_INLINE_BYTES) continue;
      const blob = await gitReads.blob(repo, ref, candidate, MAX_INLINE_BYTES);
      if (blob && !gitRepo.isBinary(blob.bytes)) {
        return json({
          path: candidate,
          ref,
          format: candidate.endsWith(".md") ? "markdown" : "text",
          content: new TextDecoder("utf-8").decode(blob.bytes),
        });
      }
    }
    return json({ path: null, ref, format: null, content: null });
  });

  router.get("/api/repos/:owner/:name/topics", (ctx) => {
    const repo = loadReadableRepo(ctx);
    return json(topicsPayload(listTopicsForRepo(repo.id)));
  });

  router.put("/api/repos/:owner/:name/topics", async (ctx) => {
    const repo = loadWritableRepo(ctx);
    const body = await readJson(ctx.request, topicsSchema);
    const requested =
      body.names ??
      (body.names_csv !== undefined && body.names_csv !== ""
        ? body.names_csv.split(",")
        :
          body.names_csv !== undefined
          ? []
          : undefined);
    if (requested === undefined) throw badRequest("Provide names or names_csv");
    const saved = setTopicsForRepo(repo.id, requested);
    for (const name of requested) pruneTopic(name);
    return json(topicsPayload(saved));
  });

  router.get("/api/topics", (ctx) => {
    const limit = v.toInt(ctx.url.searchParams.get("limit"), 30, 1, 100);
    return json({ items: popularTopics(limit) });
  });

  router.get("/api/topics/:topic/repos", (ctx) => {
    const name = normalizeTopic(param(ctx, "topic"));
    const page = parsePage(ctx.url);
    const topicId = topicIdForName(name);
    if (topicId === null) {
      return json({ items: [], total: 0, page: page.page, per_page: page.perPage, topic: name });
    }
    const { items, total } = listVisibleReposWithTopic(ctx.auth, topicId, page.perPage, page.offset);
    return jsonFor(
      ctx.request,
      {
        ...envelope(items.map((repo) => ({ ...repoJson(repo), ...statsFromCounts(repo) })), page, total),
        topic: name,
      },
      { etag: weakEtag(JSON.stringify(items.map((repo) => repo.id))) },
    );
  });

  router.get("/api/repos/:owner/:name/labels", (ctx) => {
    const repo = loadReadableRepo(ctx);
    return json({ items: listLabels(repo.id).map(labelJson) });
  });

  router.post("/api/repos/:owner/:name/labels", async (ctx) => {
    const repo = loadWritableRepo(ctx);
    const body = await readJson(ctx.request, labelSchema);
    return json(labelJson(createLabel(repo.id, body.name, body.color ?? "888888")), { status: 201 });
  });

  router.delete("/api/repos/:owner/:name/labels/:label", (ctx) => {
    const repo = loadWritableRepo(ctx);
    if (!deleteLabel(repo.id, param(ctx, "label"))) throw notFound("Label not found");
    return json({ ok: true });
  });

  router.get("/api/repos/:owner/:name/webhooks", (ctx) => {
    const repo = loadWritableRepo(ctx);
    return json({
      items: listWebhooksWithStats(repo.id).map(webhookJson),
      available_events: [...WEBHOOK_EVENTS],
    });
  });

  router.post("/api/repos/:owner/:name/webhooks", async (ctx) => {
    const repo = loadWritableRepo(ctx);
    const body = await readJson(ctx.request, webhookSchema);
    const egress = await checkEgress(body.url, config.webhookAllowPrivate);
    if (!egress.ok) throw badRequest(`Webhook URL refused: ${egress.reason}`);
    const hook = createWebhook(repo.id, body.url, body.secret ?? "", body.events ?? ["push"]);
    return json(webhookJson(hook), { status: 201 });
  });

  router.delete("/api/repos/:owner/:name/webhooks/:id", (ctx) => {
    const repo = loadWritableRepo(ctx);
    const id = Number.parseInt(param(ctx, "id"), 10);
    if (!Number.isFinite(id)) throw badRequest("Invalid webhook id");
    if (!deleteWebhook(repo.id, id)) throw notFound("Webhook not found");
    return json({ ok: true });
  });

  router.get("/api/repos/:owner/:name/webhooks/:id/deliveries", (ctx) => {
    const repo = loadWritableRepo(ctx);
    const id = Number.parseInt(param(ctx, "id"), 10);
    if (!Number.isFinite(id)) throw badRequest("Invalid webhook id");
    if (!findWebhook(repo.id, id)) throw notFound("Webhook not found");
    const limit = Math.min(Number.parseInt(ctx.url.searchParams.get("limit") ?? "25", 10) || 25, 100);
    return json({ items: listDeliveries(id, limit).map(deliveryJson) });
  });

  router.get("/api/repos/:owner/:name/archive", async (ctx) => {
    const repo = loadReadableRepo(ctx);
    const ref = requestedRef(ctx, repo.default_branch);
    if (!GIT_REF_PATTERN.test(ref)) throw badRequest("Invalid ref name");

    const format = parseArchiveFormat(optionalQuery(ctx, "format"));
    if (format === null) {
      throw badRequest(`Unsupported archive format. Use one of: ${ARCHIVE_FORMATS.join(", ")}`);
    }

    const path = optionalQuery(ctx, "path");
    const repoDir = repoDiskPath(repo);

    const sha = await gitRepo.resolveRef(repoDir, ref);
    if (!sha) {
      const branches = await gitRepo.listBranches(repoDir);
      if (branches.length === 0) {
        throw notFound("This repository has no commits yet, so there is nothing to archive");
      }
      throw notFound(`Ref "${ref}" not found`);
    }

    const fileName = archiveFilename(repo.name, ref, format);
    const started = performance.now();
    const proc = await archiveStream({
      cwd: repoDir,
      ref: sha,
      format,
      prefix: ref,
      ...(path ? { path } : {}),
    });
    increment("archives_served_total");

    const finished = proc.exited.then(async (exitCode) => {
      observe("git_archive_ms", performance.now() - started);
      if (exitCode !== 0) {
        log.error("git archive failed", {
          repo: `${repo.owner_username}/${repo.name}`,
          ref,
          reason: (await proc.stderr()).slice(0, 200),
        });
      }
      return exitCode;
    });
    void finished;

    return new Response(proc.stdout, {
      status: 200,
      headers: {
        "content-type": archiveFormatInfo(format).mime,
        "content-disposition": `attachment; filename="${fileName}"`,
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      },
    });
  });

  router.get("/api/repos/:owner/:name/locks", (ctx) => {
    const repo = loadReadableRepo(ctx);
    return json({ items: listLocks(repo.id).map(lockJson) });
  });
}

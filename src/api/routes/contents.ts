import * as v from "../../lib/validate.ts";
import { badRequest, conflict, notFound } from "../../lib/errors.ts";
import { json, readJson } from "../../lib/http.ts";
import { GIT_REF_PATTERN } from "../../lib/ids.ts";
import { findUserById, requireWrite } from "../../auth/service.ts";
import { unauthorized } from "../../lib/errors.ts";
import { loadWritableRepo } from "../helpers.ts";
import { ContentsError, deleteFileFromBranch, isSafeRepoPath, writeFileToBranch } from "../../git/contents.ts";
import { assertDirectBranchWriteAllowed } from "../../data/branch-protection.ts";
import { repoDiskPath, touchRepository } from "../../data/repos.ts";
import { invalidateRepo } from "../../data/git-reads.ts";
import { dispatchWebhooks } from "../../data/webhooks.ts";
import { maybeTriggerCi } from "../../ci/trigger.ts";
import type { Router } from "../router.ts";

const MAX_TEXT_BYTES = 1 * 1024 * 1024;
const MAX_BINARY_BYTES = 5 * 1024 * 1024;

const contentsSchema = v.strictObject({
  path: v.string({ min: 1, max: 512 }),
  branch: v.string({ min: 1, max: 255, pattern: GIT_REF_PATTERN }),
  message: v.optional(v.string({ max: 2000 })),
  content: v.string({ min: 0, max: 7_400_000, trim: false }),
  encoding: v.enumOf(["utf8", "base64"] as const),
});

const deleteSchema = v.strictObject({
  path: v.string({ min: 1, max: 512 }),
  branch: v.string({ min: 1, max: 255, pattern: GIT_REF_PATTERN }),
  message: v.optional(v.string({ max: 2000 })),
});

function decodeContent(body: { content: string; encoding: "utf8" | "base64" }): Uint8Array {
  if (body.encoding === "base64") {
    const bytes = Buffer.from(body.content, "base64");
    if (bytes.length === 0 && body.content.length > 0) throw badRequest("That is not valid base64");
    if (bytes.length > MAX_BINARY_BYTES) {
      throw badRequest(`Binary files are limited to ${MAX_BINARY_BYTES / (1024 * 1024)} MiB; use git and LFS for larger files`);
    }
    return new Uint8Array(bytes);
  }
  const bytes = Buffer.from(body.content, "utf8");
  if (bytes.length > MAX_TEXT_BYTES) {
    throw badRequest(`Text files are limited to ${MAX_TEXT_BYTES / (1024 * 1024)} MiB in the web editor`);
  }
  return new Uint8Array(bytes);
}

function mapContentsError(cause: unknown): never {
  if (cause instanceof ContentsError) {
    if (cause.kind === "conflict") throw conflict(cause.message);
    throw notFound(cause.message);
  }
  throw cause instanceof Error ? cause : badRequest(String(cause));
}

export function registerContentsRoutes(router: Router): void {
  router.put("/api/repos/:owner/:name/contents", async (ctx) => {
    const repo = loadWritableRepo(ctx);
    const principal = requireWrite(ctx.auth);
    const author = findUserById(principal.userId);
    if (!author) throw unauthorized();

    const body = await readJson(ctx.request, contentsSchema);
    if (!isSafeRepoPath(body.path)) throw badRequest("Invalid file path");
    assertDirectBranchWriteAllowed(repo.id, body.branch);
    const bytes = decodeContent(body);
    const verb = bytes.length === 0 ? "Create" : "Update";

    let result;
    try {
      result = await writeFileToBranch({
        repoPath: repoDiskPath(repo),
        beforeUpdate: () => assertDirectBranchWriteAllowed(repo.id, body.branch),
        branch: body.branch,
        filePath: body.path,
        content: bytes,
        message: body.message?.trim() || `${verb} ${body.path}`,
        author: { name: author.display_name || author.username, email: author.email },
      });
    } catch (cause) {
      mapContentsError(cause);
    }

    touchRepository(repo.id);
    invalidateRepo(repo.id);
    const ref = `refs/heads/${body.branch}`;
    dispatchWebhooks(repo.id, {
      event: "push",
      payload: { ref, changes: [{ ref, after: result.sha }] },
    });
    void maybeTriggerCi(repo, [{ ref, after: result.sha }]);

    return json({ commit: result.sha, branch: result.branch, path: result.filePath }, { status: 201 });
  });

  router.delete("/api/repos/:owner/:name/contents", async (ctx) => {
    const repo = loadWritableRepo(ctx);
    const principal = requireWrite(ctx.auth);
    const author = findUserById(principal.userId);
    if (!author) throw unauthorized();

    const body = await readJson(ctx.request, deleteSchema);
    if (!isSafeRepoPath(body.path)) throw badRequest("Invalid file path");
    assertDirectBranchWriteAllowed(repo.id, body.branch);

    let result;
    try {
      result = await deleteFileFromBranch({
        repoPath: repoDiskPath(repo),
        beforeUpdate: () => assertDirectBranchWriteAllowed(repo.id, body.branch),
        branch: body.branch,
        filePath: body.path,
        message: body.message?.trim() || `Delete ${body.path}`,
        author: { name: author.display_name || author.username, email: author.email },
      });
    } catch (cause) {
      mapContentsError(cause);
    }

    touchRepository(repo.id);
    invalidateRepo(repo.id);
    const ref = `refs/heads/${body.branch}`;
    dispatchWebhooks(repo.id, {
      event: "push",
      payload: { ref, changes: [{ ref, after: result.sha }] },
    });
    void maybeTriggerCi(repo, [{ ref, after: result.sha }]);

    return json({ commit: result.sha, branch: result.branch, path: result.filePath });
  });
}

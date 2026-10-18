import { json, readJson } from "../../lib/http.ts";
import { badRequest, notFound } from "../../lib/errors.ts";
import * as v from "../../lib/validate.ts";
import { requireWrite } from "../../auth/service.ts";
import { assertPolicyAdmin, canManageMergePolicy } from "../../data/pull-reviews.ts";
import { listBranchProtection, putBranchProtection, removeBranchProtection } from "../../data/branch-protection.ts";
import { assertSafeRefName, loadReadableRepo, param } from "../helpers.ts";
import type { RouteContext, Router } from "../router.ts";

const strictBoolean: v.Validator<boolean> = {
  out: false,
  parse(value, path) {
    if (typeof value !== "boolean") {
      throw badRequest(`Invalid input at ${path || "<root>"}: expected a boolean`, { path });
    }
    return value;
  },
};

const putSchema = v.strictObject({
  branch: v.string({ min: 1, max: 255 }),
  require_pull_request: strictBoolean,
});

function canManage(ctx: RouteContext, repo: ReturnType<typeof loadReadableRepo>): boolean {
  return canManageMergePolicy(repo, ctx.auth);
}


export function registerBranchProtectionRoutes(router: Router): void {
  router.get("/api/repos/:owner/:name/branch-protection", (ctx) => {
    const repo = loadReadableRepo(ctx);
    return json({
      items: listBranchProtection(repo.id),
      can_manage: canManage(ctx, repo),
    });
  });

  router.delete("/api/repos/:owner/:name/branch-protection/:branch", (ctx) => {
    const repo = loadReadableRepo(ctx);
    const principal = requireWrite(ctx.auth);
    assertPolicyAdmin(repo, principal);
    const branch = param(ctx, "branch");
    assertSafeRefName(branch, "branch");
    if (!removeBranchProtection(repo.id, branch)) throw notFound("That branch is not protected");
    return json({ items: listBranchProtection(repo.id), can_manage: true });
  });

  router.put("/api/repos/:owner/:name/branch-protection", async (ctx) => {
    const repo = loadReadableRepo(ctx);
    const principal = requireWrite(ctx.auth);
    assertPolicyAdmin(repo, principal);
    const body = await readJson(ctx.request, putSchema);
    assertSafeRefName(body.branch, "branch");
    const saved = putBranchProtection(repo.id, body.branch, body.require_pull_request);
    return json({
      items: listBranchProtection(repo.id),
      can_manage: true,
      branch: saved.branch,
      require_pull_request: saved.require_pull_request,
    });
  });
}

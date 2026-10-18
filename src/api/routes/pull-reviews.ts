import { json, readJson } from "../../lib/http.ts";
import { badRequest, conflict, forbidden, notFound } from "../../lib/errors.ts";
import * as v from "../../lib/validate.ts";
import { SHA_PATTERN } from "../../lib/ids.ts";
import { requireWrite, type Auth } from "../../auth/service.ts";
import { requirePull } from "../../data/pulls.ts";
import { canWrite, repoDiskPath, type RepoRecord } from "../../data/repos.ts";
import * as gitRepo from "../../git/repo.ts";
import {
  addReview,
  assertPolicyAdmin,
  canManageMergePolicy,
  deleteMergePolicy,
  listMergePolicies,
  canSubmitDecisiveReview,
  eligibleReviewerIds,
  getMergePolicy,
  listReviews,
  putMergePolicy,
  summarizeReviews,
  type PullReviewRow,
} from "../../data/pull-reviews.ts";
import { assertSafeRefName, loadReadableRepo, positiveIntParam } from "../helpers.ts";
import type { RouteContext, Router } from "../router.ts";

const reviewSchema = v.strictObject({
  event: v.enumOf(["APPROVE", "REQUEST_CHANGES", "COMMENT"] as const),
  body: v.optional(v.string({ max: 65536, trim: false })),
  commit_id: v.string({ min: 7, max: 64, pattern: SHA_PATTERN }),
});

const strictBoolean: v.Validator<boolean> = {
  out: false,
  parse(value, path) {
    if (typeof value !== "boolean") {
      throw badRequest(`Invalid input at ${path || "<root>"}: expected a boolean`, { path });
    }
    return value;
  },
};

const policySchema = v.strictObject({
  branch: v.string({ min: 1, max: 255 }),
  required_approvals: v.number({ int: true, min: 0, max: 6 }),
  require_checks: strictBoolean,
});

function pullNumber(ctx: RouteContext): number {
  return positiveIntParam(ctx, "number", "pull request number");
}

function reviewJson(row: PullReviewRow): {
  id: number;
  user: { id: number; username: string };
  event: PullReviewRow["event"];
  body: string;
  commit_id: string;
  created_at: number;
} {
  return {
    id: row.id,
    user: { id: row.user_id, username: row.username },
    event: row.event,
    body: row.body,
    commit_id: row.commit_id,
    created_at: row.created_at,
  };
}

async function resolvedHead(repo: RepoRecord, headRef: string): Promise<string | null> {
  return gitRepo.resolveRef(repoDiskPath(repo), `refs/heads/${headRef}`);
}

function assertMayReview(
  repo: RepoRecord,
  auth: Auth,
  event: "APPROVE" | "REQUEST_CHANGES" | "COMMENT",
  authorId: number,
): void {
  requireWrite(auth);
  if (event === "COMMENT") return;
  if (auth.kind === "user" && auth.userId === authorId) {
    throw forbidden("You cannot approve or request changes on your own pull request");
  }
  if (!canSubmitDecisiveReview(repo, auth, authorId)) {
    throw forbidden("Approving or requesting changes requires write access to this repository");
  }
}

export function registerPullReviewRoutes(router: Router): void {
  router.get("/api/repos/:owner/:name/pulls/:number/reviews", async (ctx) => {
    const repo = loadReadableRepo(ctx);
    const pull = requirePull(repo.id, pullNumber(ctx));
    const saved = pull.state === "merged" && pull.merge_comparison ? JSON.parse(pull.merge_comparison) as { head: string } : null;
    const headSha = saved?.head ?? (await resolvedHead(repo, pull.head_ref)) ?? "";
    const policy = getMergePolicy(repo.id, pull.base_ref);
    const eligible = eligibleReviewerIds(repo, pull.author_id);
    const summary = summarizeReviews(pull.id, headSha, pull.author_id, eligible);
    const principalCanReview =
      ctx.auth.kind === "user" &&
      canWrite(repo, ctx.auth) &&
      ctx.auth.userId !== pull.author_id;
    let canManagePolicy = false;
    if (ctx.auth.kind === "user") { try { assertPolicyAdmin(repo, ctx.auth); canManagePolicy = true; } catch {} }
    return json({
      can_manage_policy: canManagePolicy,
      items: listReviews(pull.id, 100).map(reviewJson),
      head_sha: headSha,
      approvals: summary.approvals,
      changes_requested: summary.changes_requested,
      required_approvals: policy.required_approvals,
      require_checks: policy.require_checks,
      can_review: principalCanReview,
    });
  });

  router.post("/api/repos/:owner/:name/pulls/:number/reviews", async (ctx) => {
    const repo = loadReadableRepo(ctx);
    const principal = requireWrite(ctx.auth);
    const pull = requirePull(repo.id, pullNumber(ctx));
    const body = await readJson(ctx.request, reviewSchema);
    if (pull.state !== "open") throw conflict("Only open pull requests can be reviewed");
    if (repo.archived === 1) throw forbidden("Archived repositories cannot accept reviews");
    if (body.event !== "APPROVE" && !(body.body ?? "").trim()) throw badRequest("Review feedback is required");
    assertMayReview(repo, principal, body.event, pull.author_id);

    const headSha = await resolvedHead(repo, pull.head_ref);
    if (!headSha) throw badRequest("The pull request head branch no longer exists");


    const review = addReview({
      repoId: repo.id,
      pullId: pull.id,
      userId: principal.userId,
      event: body.event,
      body: body.body ?? "",
      headSha,
      expectedCommitId: body.commit_id,
    });
    return json(reviewJson(review), { status: 201 });
  });

  router.get("/api/repos/:owner/:name/pull-merge-policies", (ctx) => {
    const repo = loadReadableRepo(ctx);
    return json({
      items: listMergePolicies(repo.id),
      can_manage: canManageMergePolicy(repo, ctx.auth),
    });
  });

  router.get("/api/repos/:owner/:name/pull-merge-policy", (ctx) => {
    const repo = loadReadableRepo(ctx);
    const branch = ctx.url.searchParams.get("branch");
    if (!branch) throw badRequest("branch query parameter is required");
    assertSafeRefName(branch, "branch");
    const policy = getMergePolicy(repo.id, branch);
    return json({
      branch: policy.branch,
      required_approvals: policy.required_approvals,
      require_checks: policy.require_checks,

      applies_to: "pull_request_merge",
    });
  });

  router.delete("/api/repos/:owner/:name/pull-merge-policy", (ctx) => {
    const repo = loadReadableRepo(ctx);
    const principal = requireWrite(ctx.auth);
    assertPolicyAdmin(repo, principal);
    const branch = ctx.url.searchParams.get("branch");
    if (!branch) throw badRequest("branch query parameter is required");
    assertSafeRefName(branch, "branch");
    if (!deleteMergePolicy(repo.id, branch)) throw notFound("No merge policy is configured for that branch");
    return json({ items: listMergePolicies(repo.id), can_manage: true });
  });

  router.put("/api/repos/:owner/:name/pull-merge-policy", async (ctx) => {
    const repo = loadReadableRepo(ctx);
    const principal = requireWrite(ctx.auth);
    assertPolicyAdmin(repo, principal);
    const body = await readJson(ctx.request, policySchema);
    const queryBranch = ctx.url.searchParams.get("branch");
    if (queryBranch !== null && queryBranch !== body.branch) {
      throw badRequest("branch query does not match the request body");
    }

    assertSafeRefName(body.branch, "branch");
    const saved = putMergePolicy(
      repo.id,
      body.branch,
      body.required_approvals,
      body.require_checks,
    );
    return json({
      branch: saved.branch,
      required_approvals: saved.required_approvals,
      require_checks: saved.require_checks,
      applies_to: "pull_request_merge",
      items: listMergePolicies(repo.id),
      can_manage: true,
    });
  });
}

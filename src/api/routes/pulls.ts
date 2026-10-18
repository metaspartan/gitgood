import { json, jsonFor, readJson, weakEtag } from "../../lib/http.ts";
import { conflict } from "../../lib/errors.ts";
import { envelope, parsePage } from "../../lib/pagination.ts";
import * as v from "../../lib/validate.ts";
import { increment, observe } from "../../lib/metrics.ts";
import { findUserById, findUserByUsername, requireWrite } from "../../auth/service.ts";
import { addAssignees, assigneesForItems, isAssignable } from "../../data/assignees.ts";
import { readAssigneeFilter } from "./issues.ts";
import { countPulls, createPull, listPulls, mergePull, requirePull, updatePull, type PullState } from "../../data/pulls.ts";
import { addComment, listComments } from "../../data/comments.ts";
import { countEvents, listEvents, record } from "../../data/thread-events.ts";
import {
  notifiableOwnerIds,
  notifyComment,
  notifyPullOpened,
  notifyStateChange,
} from "../../data/notify-events.ts";
import { dispatchWebhooks } from "../../data/webhooks.ts";
import { touchRepository, repoDiskPath } from "../../data/repos.ts";
import * as gitRepo from "../../git/repo.ts";
import { invalidateRepo } from "../../data/git-reads.ts";
import { pullChecksStatus, headChecksVerdict } from "../../ci/store.ts";
import {
  eligibleReviewerIds,
  getMergePolicy,
  summarizeReviews,
} from "../../data/pull-reviews.ts";
import { commentJson, commitJson, fileChangeJson, pullJson, pullSummaryJson } from "../serialize.ts";
import { loadReadableRepo, loadWritableRepo, positiveIntParam } from "../helpers.ts";
import type { RouteContext, Router } from "../router.ts";

const createPullSchema = v.strictObject({
  title: v.string({ min: 1, max: 256 }),
  body: v.optional(v.string({ max: 65536 })),
  head: v.string({ min: 1, max: 255 }),
  base: v.string({ min: 1, max: 255 }),
  assignees: v.optional(v.array(v.string({ min: 1, max: 39, trim: true }), { max: 10 })),
});

const updatePullSchema = v.strictObject({
  title: v.optional(v.string({ min: 1, max: 256 })),
  body: v.optional(v.string({ max: 65536 })),
  state: v.optional(v.enumOf(["open", "closed"] as const)),
});

const commentSchema = v.strictObject({
  body: v.string({ min: 1, max: 65536, trim: false }),
});

function pullNumber(ctx: RouteContext): number {
  return positiveIntParam(ctx, "number", "pull request number");
}

export function registerPullRoutes(router: Router): void {
  router.get("/api/repos/:owner/:name/pulls", (ctx) => {
    const repo = loadReadableRepo(ctx);
    const page = parsePage(ctx.url, 30);
    const stateParam = ctx.url.searchParams.get("state") ?? "open";
    const state: PullState | "all" =
      stateParam === "all" || stateParam === "closed" || stateParam === "merged" || stateParam === "open"
        ? stateParam
        : "open";
    const assignee = readAssigneeFilter(ctx);
    const items = listPulls(repo.id, { state, limit: page.perPage, offset: page.offset, ...assignee });
    const assignees = assigneesForItems("pull", items.map((pull) => pull.id));
    const rows = items.map((pull) => ({
      ...pullSummaryJson(pull),
      assignees: assignees.get(pull.id) ?? [],
    }));
    return jsonFor(ctx.request, envelope(rows, page, countPulls(repo.id, state, assignee.assigneeId)), {
      etag: weakEtag(JSON.stringify(rows)),
    });
  });

  router.post("/api/repos/:owner/:name/pulls", async (ctx) => {
    const repo = loadWritableRepo(ctx);
    const principal = requireWrite(ctx.auth);
    const body = await readJson(ctx.request, createPullSchema);
    const pull = await createPull(repo, principal.userId, {
      title: body.title,
      head: body.head,
      base: body.base,
      ...(body.body !== undefined ? { body: body.body } : {}),
    });
    touchRepository(repo.id);
    increment("pulls_created_total");
    notifyPullOpened({
      repo,
      actor: principal,
      ownerUserIds: notifiableOwnerIds(repo),
      subjectId: pull.id,
      subjectNumber: pull.number,
      subjectTitle: pull.title,
      authorId: principal.userId,
    });
    dispatchWebhooks(repo.id, {
      event: "pull_request",
      payload: {
        action: "opened",
        pull_request: pullJson(pull),
        repository: { full_name: `${repo.owner_username}/${repo.name}` },
      },
    });
    if (body.assignees && body.assignees.length > 0) {
      const ids = body.assignees
        .map((username) => findUserByUsername(username))
        .filter((user): user is NonNullable<typeof user> => user !== null && isAssignable(repo, ctx.auth, user.id))
        .map((user) => user.id);
      addAssignees("pull", pull.id, ids, principal.userId);
    }
    return json(
      { ...pullJson(pull), assignees: assigneesForItems("pull", [pull.id]).get(pull.id) ?? [] },
      { status: 201 },
    );
  });

  router.get("/api/repos/:owner/:name/pulls/:number", (ctx) => {
    const repo = loadReadableRepo(ctx);
    const pull = requirePull(repo.id, pullNumber(ctx));
    return json({ ...pullJson(pull), assignees: assigneesForItems("pull", [pull.id]).get(pull.id) ?? [] });
  });

  router.patch("/api/repos/:owner/:name/pulls/:number", async (ctx) => {
    const repo = loadWritableRepo(ctx);
    const pull = requirePull(repo.id, pullNumber(ctx));
    const body = await readJson(ctx.request, updatePullSchema);
    const actor = requireWrite(ctx.auth);
    const updated = updatePull(pull, {
      ...(body.title !== undefined ? { title: body.title } : {}),
      ...(body.body !== undefined ? { body: body.body } : {}),
      ...(body.state !== undefined ? { state: body.state } : {}),
    });
    if (body.state === "closed" && pull.state !== "closed") {
      notifyStateChange(
        { repo, actor, ownerUserIds: notifiableOwnerIds(repo) },
        "pull",
        "closed",
        {
          repo,
          actor,
          ownerUserIds: notifiableOwnerIds(repo),
          subjectId: updated.id,
          subjectNumber: updated.number,
          subjectTitle: updated.title,
          authorId: updated.author_id,
        },
      );
    }
    return json({ ...pullJson(updated), assignees: assigneesForItems("pull", [updated.id]).get(updated.id) ?? [] });
  });

  router.post("/api/repos/:owner/:name/pulls/:number/merge", async (ctx) => {
    const repo = loadWritableRepo(ctx);
    const principal = requireWrite(ctx.auth);
    const user = findUserById(principal.userId);
    const pull = requirePull(repo.id, pullNumber(ctx));

    const pinnedHead = await gitRepo.resolveRef(repoDiskPath(repo), `refs/heads/${pull.head_ref}`);
    if (!pinnedHead) {
      throw conflict(`Source branch "${pull.head_ref}" no longer exists`);
    }

    const policy = getMergePolicy(repo.id, pull.base_ref);
    const eligible = eligibleReviewerIds(repo, pull.author_id);
    const summary = summarizeReviews(pull.id, pinnedHead, pull.author_id, eligible);
    if (summary.changes_requested > 0) {
      throw conflict("Changes have been requested on this pull request");
    }
    if (summary.approvals < policy.required_approvals) {
      throw conflict(
        `This pull request needs ${policy.required_approvals} approval(s) on ${pinnedHead.slice(0, 7)}; it has ${summary.approvals}`,
      );
    }

    if (policy.require_checks) {
      const verdict = headChecksVerdict(repo.id, pinnedHead);
      if (!verdict.ok) {
        throw conflict(
          verdict.reason === "no_checks"
            ? "Required checks have not run for the current head"
            : verdict.reason === "pending"
              ? "Required checks are still running for the current head"
              : "Required checks failed for the current head",
        );
      }
    } else {
      const checks = pullChecksStatus(repo.id, pull.id, pinnedHead, pull.state);
      if (checks.status === "failure") {
        return json(
          {
            error: {
              code: "check_failed",
              message: "The CI checks for this pull request failed. Fix the failure before merging.",
              details: { check_status: checks.status, run_id: checks.runId },
            },
          },
          { status: 409 },
        );
      }
    }

    const started = performance.now();
    const result = await mergePull(
      repo,
      pull,
      {
        name: user?.display_name ?? principal.username,
        email: user?.email ?? `${principal.username}@gitgood.local`,
      },
      pinnedHead,
    );
    observe("pull_merge_ms", performance.now() - started);
    record({
      repoId: repo.id,
      targetType: "pull",
      targetId: result.pull.id,
      kind: "merged",
      actor: { id: principal.userId, username: principal.username },
      detail: { commit: result.sha, into: pull.base_ref },
    });
    increment("pulls_merged_total");
    touchRepository(repo.id);
    invalidateRepo(repo.id);
    notifyStateChange(
      { repo, actor: principal, ownerUserIds: notifiableOwnerIds(repo) },
      "pull",
      "merged",
      {
        repo,
        actor: principal,
        ownerUserIds: notifiableOwnerIds(repo),
        subjectId: result.pull.id,
        subjectNumber: result.pull.number,
        subjectTitle: result.pull.title,
        authorId: result.pull.author_id,
      },
    );
    dispatchWebhooks(repo.id, {
      event: "pull_request",
      payload: {
        action: "closed",
        merged: true,
        pull_request: pullJson(result.pull),
        repository: { full_name: `${repo.owner_username}/${repo.name}` },
      },
    });
    return json({ merged: true, ...result });
  });

  router.get("/api/repos/:owner/:name/pulls/:number/commits", async (ctx) => {
    const repo = loadReadableRepo(ctx);
    const pull = requirePull(repo.id, pullNumber(ctx));
    const commits = await gitRepo.logRange(
      repoDiskPath(repo),
      pull.base_ref,
      pull.head_ref,
      250,
    );
    return json({ items: commits.map(commitJson) });
  });

  router.get("/api/repos/:owner/:name/pulls/:number/files", async (ctx) => {
    const repo = loadReadableRepo(ctx);
    const pull = requirePull(repo.id, pullNumber(ctx));
    if (pull.state === "merged" && !pull.merge_comparison) {
      return json({ items: [], stats: { additions: 0, deletions: 0, files_changed: 0 }, comparison_available: false, comparison_message: "This older merged pull request has no saved comparison. Its original changes cannot be reconstructed reliably." });
    }
    const saved = pull.state === "merged" && pull.merge_comparison
      ? JSON.parse(pull.merge_comparison) as { base: string; head: string; files: Awaited<ReturnType<typeof gitRepo.changesBetween>> }
      : null;
    const changes = saved?.files ?? await gitRepo.changesBetween(repoDiskPath(repo), `refs/heads/${pull.base_ref}`, `refs/heads/${pull.head_ref}`);
    return json({
      comparison_available: true,
      comparison_kind: saved ? "merge_snapshot" : "live",
      items: changes.map(fileChangeJson),
      stats: {
        additions: changes.reduce((sum, change) => sum + change.additions, 0),
        deletions: changes.reduce((sum, change) => sum + change.deletions, 0),
        files_changed: changes.length,
      },
    });
  });

  router.get("/api/repos/:owner/:name/pulls/:number/events", (ctx) => {
    const repo = loadReadableRepo(ctx);
    const pull = requirePull(repo.id, pullNumber(ctx));
    const page = parsePage(ctx.url, 100);
    return jsonFor(
      ctx.request,
      envelope(
        listEvents(repo.id, "pull", pull.id, { limit: page.perPage, offset: page.offset }),
        page,
        countEvents(repo.id, "pull", pull.id),
      ),
      { etag: weakEtag(`${repo.id}:pull:${pull.id}:${page.offset}`) },
    );
  });

  router.get("/api/repos/:owner/:name/pulls/:number/comments", (ctx) => {
    const repo = loadReadableRepo(ctx);
    const pull = requirePull(repo.id, pullNumber(ctx));
    return json({ items: listComments(repo.id, "pull", pull.id).map(commentJson) });
  });

  router.post("/api/repos/:owner/:name/pulls/:number/comments", async (ctx) => {
    const repo = loadReadableRepo(ctx);
    const principal = requireWrite(ctx.auth);
    const pull = requirePull(repo.id, pullNumber(ctx));
    const body = await readJson(ctx.request, commentSchema);
    const comment = addComment(repo.id, "pull", pull.id, principal.userId, body.body);
    record({
      repoId: repo.id,
      targetType: "pull",
      targetId: pull.id,
      kind: "commented",
      actor: { id: principal.userId, username: principal.username },
      detail: { comment_id: comment.id },
    });
    notifyComment(
      { repo, actor: principal, ownerUserIds: notifiableOwnerIds(repo) },
      "pull",
      {
        repo,
        actor: principal,
        ownerUserIds: notifiableOwnerIds(repo),
        subjectId: pull.id,
        subjectNumber: pull.number,
        subjectTitle: pull.title,
        authorId: pull.author_id,
      },
    );
    return json(commentJson(comment), { status: 201 });
  });
}

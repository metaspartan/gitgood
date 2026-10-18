import { json, jsonFor, readJson, weakEtag } from "../../lib/http.ts";
import { badRequest, notFound } from "../../lib/errors.ts";
import { envelope, parsePage } from "../../lib/pagination.ts";
import * as v from "../../lib/validate.ts";
import { increment } from "../../lib/metrics.ts";
import { findUserByUsername, requireWrite } from "../../auth/service.ts";
import {
  countIssues,
  createIssue,
  listIssues,
  requireIssue,
  updateIssue,
  type IssueState,
} from "../../data/issues.ts";
import { addComment, listComments } from "../../data/comments.ts";
import {
  notifiableOwnerIds,
  notifyComment,
  notifyIssueOpened,
  notifyStateChange,
} from "../../data/notify-events.ts";
import { labelNamesForIssue, labelNamesForIssues, setIssueLabels } from "../../data/labels.ts";
import { assigneesForItems, addAssignees, isAssignable } from "../../data/assignees.ts";
import {
  countEvents,
  listEvents,
  record,
  recordLabelChange,
} from "../../data/thread-events.ts";
import { dispatchWebhooks } from "../../data/webhooks.ts";
import { touchRepository } from "../../data/repos.ts";
import { commentJson, issueJson, issueSummaryJson } from "../serialize.ts";
import { loadReadableRepo, loadWritableRepo, positiveIntParam } from "../helpers.ts";
import type { RouteContext, Router } from "../router.ts";

const createIssueSchema = v.strictObject({
  title: v.string({ min: 1, max: 256 }),
  body: v.optional(v.string({ max: 65536 })),
  labels: v.optional(v.array(v.string({ max: 50 }), { max: 20 })),
  assignees: v.optional(v.array(v.string({ min: 1, max: 39, trim: true }), { max: 10 })),
});

const updateIssueSchema = v.strictObject({
  title: v.optional(v.string({ min: 1, max: 256 })),
  body: v.optional(v.string({ max: 65536 })),
  state: v.optional(v.enumOf(["open", "closed"] as const)),
  labels: v.optional(v.array(v.string({ max: 50 }), { max: 20 })),
});

const commentSchema = v.strictObject({
  body: v.string({ min: 1, max: 65536, trim: false }),
});

export function readAssigneeFilter(ctx: RouteContext): { assigneeId?: number | null } {
  const username = ctx.url.searchParams.get("assignee");
  const unassigned = ctx.url.searchParams.get("no_assignee") === "true";
  if (!username && !unassigned) return {};
  if (username && unassigned) {
    throw badRequest("Use either assignee or no_assignee, not both");
  }
  if (unassigned) return { assigneeId: null };
  const user = findUserByUsername(username!);
  if (!user) throw notFound(`No such user "${username}"`);
  return { assigneeId: user.id };
}

function issueNumber(ctx: RouteContext): number {
  return positiveIntParam(ctx, "number", "issue number");
}

export function registerIssueRoutes(router: Router): void {
  router.get("/api/repos/:owner/:name/issues", (ctx) => {
    const repo = loadReadableRepo(ctx);
    const page = parsePage(ctx.url, 30);
    const stateParam = ctx.url.searchParams.get("state") ?? "open";
    const state: IssueState | "all" =
      stateParam === "all" || stateParam === "closed" || stateParam === "open" ? stateParam : "open";
    const assignee = readAssigneeFilter(ctx);
    const items = listIssues(repo.id, { state, limit: page.perPage, offset: page.offset, ...assignee });
    const ids = items.map((issue) => issue.id);
    const labels = labelNamesForIssues(ids);
    const assignees = assigneesForItems("issue", ids);
    const rows = items.map((issue) => ({
      ...issueSummaryJson(issue),
      labels: labels.get(issue.id) ?? [],
      assignees: assignees.get(issue.id) ?? [],
    }));
    return jsonFor(ctx.request, envelope(rows, page, countIssues(repo.id, state, assignee.assigneeId)), {
      etag: weakEtag(JSON.stringify(rows)),
    });
  });

  router.post("/api/repos/:owner/:name/issues", async (ctx) => {
    const repo = loadWritableRepo(ctx);
    const principal = requireWrite(ctx.auth);
    const body = await readJson(ctx.request, createIssueSchema);
    const issue = createIssue(repo, principal.userId, {
      title: body.title,
      ...(body.body !== undefined ? { body: body.body } : {}),
    });
    if (body.labels && body.labels.length > 0) setIssueLabels(repo.id, issue.id, body.labels);
    if (body.assignees && body.assignees.length > 0) {
      const ids = body.assignees
        .map((username) => findUserByUsername(username))
        .filter((user): user is NonNullable<typeof user> => user !== null && isAssignable(repo, ctx.auth, user.id))
        .map((user) => user.id);
      addAssignees("issue", issue.id, ids, principal.userId);
    }
    touchRepository(repo.id);
    increment("issues_created_total");
    notifyIssueOpened({
      repo,
      actor: principal,
      ownerUserIds: notifiableOwnerIds(repo),
      subjectId: issue.id,
      subjectNumber: issue.number,
      subjectTitle: issue.title,
      authorId: principal.userId,
    });
    dispatchWebhooks(repo.id, {
      event: "issues",
      payload: { action: "opened", issue: issueJson(issue), repository: { full_name: `${repo.owner_username}/${repo.name}` } },
    });
    return json(
      {
        ...issueJson(issue),
        labels: labelNamesForIssue(issue.id),
        assignees: assigneesForItems("issue", [issue.id]).get(issue.id) ?? [],
      },
      { status: 201 },
    );
  });

  router.get("/api/repos/:owner/:name/issues/:number", (ctx) => {
    const repo = loadReadableRepo(ctx);
    const issue = requireIssue(repo.id, issueNumber(ctx));
    return json({
      ...issueJson(issue),
      labels: labelNamesForIssue(issue.id),
      assignees: assigneesForItems("issue", [issue.id]).get(issue.id) ?? [],
    });
  });

  router.patch("/api/repos/:owner/:name/issues/:number", async (ctx) => {
    const repo = loadWritableRepo(ctx);
    const issue = requireIssue(repo.id, issueNumber(ctx));
    const body = await readJson(ctx.request, updateIssueSchema);
    const actor = ctx.auth.kind === "user" ? { id: ctx.auth.userId, username: ctx.auth.username } : null;
    const updated = updateIssue(issue, {
      ...(body.title !== undefined ? { title: body.title } : {}),
      ...(body.body !== undefined ? { body: body.body } : {}),
      ...(body.state !== undefined ? { state: body.state } : {}),
    });
    const labelsBefore = body.labels !== undefined ? labelNamesForIssue(issue.id) : null;
    if (body.labels !== undefined) {
      setIssueLabels(repo.id, issue.id, body.labels);
      recordLabelChange(repo.id, "issue", issue.id, labelsBefore!, body.labels, actor);
    }
    if (body.state !== undefined && body.state !== issue.state) {
      record({
        repoId: repo.id,
        targetType: "issue",
        targetId: updated.id,
        kind: body.state === "closed" ? "closed" : "reopened",
        actor,
      });
      notifyStateChange(
        { repo, actor: requireWrite(ctx.auth), ownerUserIds: notifiableOwnerIds(repo) },
        "issue",
        "closed",
        {
          repo,
          actor: requireWrite(ctx.auth),
          ownerUserIds: notifiableOwnerIds(repo),
          subjectId: updated.id,
          subjectNumber: updated.number,
          subjectTitle: updated.title,
          authorId: updated.author_id,
        },
      );
    }
    return json({
      ...issueJson(updated),
      labels: labelNamesForIssue(issue.id),
      assignees: assigneesForItems("issue", [issue.id]).get(issue.id) ?? [],
    });
  });

  router.get("/api/repos/:owner/:name/issues/:number/events", (ctx) => {
    const repo = loadReadableRepo(ctx);
    const issue = requireIssue(repo.id, issueNumber(ctx));
    const page = parsePage(ctx.url, 100);
    return jsonFor(
      ctx.request,
      envelope(
        listEvents(repo.id, "issue", issue.id, { limit: page.perPage, offset: page.offset }),
        page,
        countEvents(repo.id, "issue", issue.id),
      ),
      { etag: weakEtag(`${repo.id}:issue:${issue.id}:${page.offset}`) },
    );
  });

  router.get("/api/repos/:owner/:name/issues/:number/comments", (ctx) => {
    const repo = loadReadableRepo(ctx);
    const issue = requireIssue(repo.id, issueNumber(ctx));
    return json({ items: listComments(repo.id, "issue", issue.id).map(commentJson) });
  });

  router.post("/api/repos/:owner/:name/issues/:number/comments", async (ctx) => {
    const repo = loadReadableRepo(ctx);
    const issue = requireIssue(repo.id, issueNumber(ctx));
    const principal = requireWrite(ctx.auth);
    const body = await readJson(ctx.request, commentSchema);
    const comment = addComment(repo.id, "issue", issue.id, principal.userId, body.body);
    record({
      repoId: repo.id,
      targetType: "issue",
      targetId: issue.id,
      kind: "commented",
      actor: { id: principal.userId, username: principal.username },
      detail: { comment_id: comment.id },
    });
    notifyComment(
      { repo, actor: principal, ownerUserIds: notifiableOwnerIds(repo) },
      "issue",
      {
        repo,
        actor: principal,
        ownerUserIds: notifiableOwnerIds(repo),
        subjectId: issue.id,
        subjectNumber: issue.number,
        subjectTitle: issue.title,
        authorId: issue.author_id,
      },
    );
    return json(commentJson(comment), { status: 201 });
  });
}

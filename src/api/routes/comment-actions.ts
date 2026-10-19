import { requireWrite, type Auth } from "../../auth/service.ts";
import { findComment, removeComment, updateComment, type CommentWithAuthor } from "../../data/comments.ts";
import { addReaction, reactionSummaries, removeReaction, REACTIONS, type ReactionContent } from "../../data/reactions.ts";
import { canWrite, type RepoRecord } from "../../data/repos.ts";
import { badRequest, forbidden, notFound } from "../../lib/errors.ts";
import { json, readJson } from "../../lib/http.ts";
import * as v from "../../lib/validate.ts";
import { commentJson } from "../serialize.ts";
import { loadReadableRepo, param, positiveIntParam } from "../helpers.ts";
import type { RouteContext, Router } from "../router.ts";

const editSchema = v.strictObject({ body: v.string({ min: 1, max: 65_536 }) });
const reactSchema = v.strictObject({ content: v.enumOf(REACTIONS) });

export function commentsWithReactions(comments: readonly CommentWithAuthor[], auth: Auth): Record<string, unknown>[] {
  const viewer = auth.kind === "user" ? auth.userId : null;
  const summaries = reactionSummaries(comments.map((comment) => comment.id), viewer);
  return comments.map((comment) => ({ ...commentJson(comment), reactions: summaries.get(comment.id) ?? [] }));
}

function loadComment(ctx: RouteContext): { repo: RepoRecord; comment: CommentWithAuthor } {
  const repo = loadReadableRepo(ctx);
  const comment = findComment(repo.id, positiveIntParam(ctx, "id", "comment id"));
  if (!comment) throw notFound("Comment not found");
  return { repo, comment };
}

function assertNotArchived(repo: RepoRecord): void {
  if (repo.archived === 1) throw forbidden("This repository is archived and read-only");
}

function reactionContent(ctx: RouteContext): ReactionContent {
  const raw = param(ctx, "content");
  if (!(REACTIONS as readonly string[]).includes(raw)) throw badRequest("Unknown reaction");
  return raw as ReactionContent;
}

export function registerCommentActionRoutes(router: Router): void {
  router.patch("/api/repos/:owner/:name/comments/:id", async (ctx) => {
    const { repo, comment } = loadComment(ctx);
    const principal = requireWrite(ctx.auth);
    assertNotArchived(repo);
    if (comment.author_id !== principal.userId && !principal.isAdmin) throw forbidden("Only the author can edit this comment");
    const body = await readJson(ctx.request, editSchema);
    updateComment(comment.id, body.body);
    const updated = findComment(repo.id, comment.id)!;
    return json(commentsWithReactions([updated], ctx.auth)[0]);
  });

  router.delete("/api/repos/:owner/:name/comments/:id", (ctx) => {
    const { repo, comment } = loadComment(ctx);
    const principal = requireWrite(ctx.auth);
    assertNotArchived(repo);
    if (comment.author_id !== principal.userId && !canWrite(repo, ctx.auth)) throw forbidden("You cannot delete this comment");
    removeComment(comment.id);
    return new Response(null, { status: 204 });
  });

  router.put("/api/repos/:owner/:name/comments/:id/reactions", async (ctx) => {
    const { repo, comment } = loadComment(ctx);
    const principal = requireWrite(ctx.auth);
    assertNotArchived(repo);
    const body = await readJson(ctx.request, reactSchema);
    addReaction(comment.id, principal.userId, body.content);
    return json({ reactions: reactionSummaries([comment.id], principal.userId).get(comment.id) ?? [] });
  });

  router.delete("/api/repos/:owner/:name/comments/:id/reactions/:content", (ctx) => {
    const { repo, comment } = loadComment(ctx);
    const principal = requireWrite(ctx.auth);
    assertNotArchived(repo);
    removeReaction(comment.id, principal.userId, reactionContent(ctx));
    return json({ reactions: reactionSummaries([comment.id], principal.userId).get(comment.id) ?? [] });
  });
}

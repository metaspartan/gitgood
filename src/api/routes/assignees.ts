import { json, readJson } from "../../lib/http.ts";
import { badRequest, notFound } from "../../lib/errors.ts";
import * as v from "../../lib/validate.ts";
import type { RouteContext, Router } from "../router.ts";
import { loadReadableRepo, loadWritableRepo, param, positiveIntParam } from "../helpers.ts";
import { requireIssue } from "../../data/issues.ts";
import { requirePull } from "../../data/pulls.ts";
import {
  addAssignees,
  assignableUserIds,
  assignableUsers,
  assigneesForItems,
  isAssignable,
  removeAssignee,
  removeAssignees,
} from "../../data/assignees.ts";
import { findUserByUsername, requireWrite } from "../../auth/service.ts";
import { recordAssigneeChange } from "../../data/thread-events.ts";
import { dispatchWebhooks } from "../../data/webhooks.ts";
import { notifyAssigned } from "../../data/notify-events.ts";
import { notifiableOwnerIds } from "../../data/notify-events.ts";
import type { RepoRecord } from "../../data/repos.ts";
import type { Auth } from "../../auth/service.ts";
import { issueJson, pullJson } from "../serialize.ts";

const MAX_ASSIGNees = 10;

const assignSchema = v.strictObject({
  add: v.optional(v.array(v.string({ min: 1, max: 39, trim: true }), { max: MAX_ASSIGNees })),
  remove: v.optional(v.array(v.string({ min: 1, max: 39, trim: true }), { max: MAX_ASSIGNees })),
});

function resolveAssignees(
  repo: RepoRecord,
  auth: Auth,
  usernames: readonly string[] | undefined,
): number[] {
  if (!usernames || usernames.length === 0) return [];
  const ids: number[] = [];
  for (const raw of new Set(usernames)) {
    const user = findUserByUsername(raw);
    if (!user || !isAssignable(repo, auth, user.id)) {
      throw notFound(`No assignable user named "${raw}"`);
    }
    ids.push(user.id);
  }
  return ids;
}

function issueNumber(ctx: RouteContext): number {
  return positiveIntParam(ctx, "number", "issue number");
}

export function registerAssigneeRoutes(router: Router): void {
  router.get("/api/repos/:owner/:name/assignees", (ctx) => {
    const repo = loadWritableRepo(ctx);
    return json({ items: assignableUsers(repo, ctx.auth) });
  });

  router.get("/api/repos/:owner/:name/issues/:number/assignees", (ctx) => {
    const repo = loadReadableRepo(ctx);
    const issue = requireIssue(repo.id, issueNumber(ctx));
    return json({
      items: assigneesForItems("issue", [issue.id]).get(issue.id) ?? [],
      assignable: assignableUserIds(repo, ctx.auth).length,
    });
  });

  router.post("/api/repos/:owner/:name/issues/:number/assignees", async (ctx) => {
    const repo = loadWritableRepo(ctx);
    if (ctx.auth.kind !== "user") throw badRequest("A signed-in user is required");
    const issue = requireIssue(repo.id, issueNumber(ctx));
    const body = await readJson(ctx.request, assignSchema);
    const toAdd = resolveAssignees(repo, ctx.auth, body.add);
    const toRemove = resolveAssignees(repo, ctx.auth, body.remove);

    const current = assigneesForItems("issue", [issue.id]).get(issue.id) ?? [];
    const already = new Set(current.map((a) => a.id));
    for (const id of toAdd) already.add(id);
    if (already.size > MAX_ASSIGNees) {
      throw badRequest(`An item can have at most ${MAX_ASSIGNees} assignees`);
    }

    const actor = { id: ctx.auth.userId, username: ctx.auth.username };
    const namesBefore = current.map((person) => person.username);
    const added = addAssignees("issue", issue.id, toAdd, ctx.auth.userId);
    removeAssignees("issue", issue.id, toRemove);
    const items = assigneesForItems("issue", [issue.id]).get(issue.id) ?? [];
    recordAssigneeChange(repo.id, "issue", issue.id, namesBefore, items.map((person) => person.username), actor);

    if (added > 0) {
      const fresh = toAdd.filter((id) => items.some((a) => a.id === id));
      notifyAssigned(
        { repo, actor: ctx.auth, ownerUserIds: notifiableOwnerIds(repo) },
        "issue",
        issue,
        fresh,
      );
      dispatchWebhooks(repo.id, {
        event: "issues",
        payload: {
          action: "assigned",
          issue: { ...issueJson(issue), assignees: items },
          assignees: items.filter((a) => fresh.includes(a.id)),
          repository: { full_name: `${repo.owner_username}/${repo.name}` },
        },
      });
    }
    return json({ items, added, removed: toRemove.length });
  });

  router.delete("/api/repos/:owner/:name/issues/:number/assignees/:username", (ctx) => {
    const repo = loadWritableRepo(ctx);
    const issue = requireIssue(repo.id, issueNumber(ctx));
    const principal = requireWrite(ctx.auth);
    const target = findUserByUsername(param(ctx, "username"));
    if (!target) throw notFound("No such user");
    if (!removeAssignee("issue", issue.id, target.id)) throw notFound("Not assigned to this issue");
    recordAssigneeChange(
      repo.id,
      "issue",
      issue.id,
      [target.username],
      [],
      { id: principal.userId, username: principal.username },
    );
    return json({ items: assigneesForItems("issue", [issue.id]).get(issue.id) ?? [] });
  });

  router.get("/api/repos/:owner/:name/pulls/:number/assignees", (ctx) => {
    const repo = loadReadableRepo(ctx);
    const pull = requirePull(repo.id, issueNumber(ctx));
    return json({
      items: assigneesForItems("pull", [pull.id]).get(pull.id) ?? [],
      assignable: assignableUserIds(repo, ctx.auth).length,
    });
  });

  router.post("/api/repos/:owner/:name/pulls/:number/assignees", async (ctx) => {
    const repo = loadWritableRepo(ctx);
    if (ctx.auth.kind !== "user") throw badRequest("A signed-in user is required");
    const pull = requirePull(repo.id, issueNumber(ctx));
    const body = await readJson(ctx.request, assignSchema);
    const toAdd = resolveAssignees(repo, ctx.auth, body.add);
    const toRemove = resolveAssignees(repo, ctx.auth, body.remove);

    const current = assigneesForItems("pull", [pull.id]).get(pull.id) ?? [];
    const already = new Set(current.map((a) => a.id));
    for (const id of toAdd) already.add(id);
    if (already.size > MAX_ASSIGNees) {
      throw badRequest(`An item can have at most ${MAX_ASSIGNees} assignees`);
    }

    const actor = { id: ctx.auth.userId, username: ctx.auth.username };
    const namesBefore = current.map((person) => person.username);
    const added = addAssignees("pull", pull.id, toAdd, ctx.auth.userId);
    removeAssignees("pull", pull.id, toRemove);
    const items = assigneesForItems("pull", [pull.id]).get(pull.id) ?? [];
    recordAssigneeChange(repo.id, "pull", pull.id, namesBefore, items.map((person) => person.username), actor);

    if (added > 0) {
      notifyAssigned(
        { repo, actor: ctx.auth, ownerUserIds: notifiableOwnerIds(repo) },
        "pull",
        pull,
        toAdd.filter((id) => items.some((a) => a.id === id)),
      );
      dispatchWebhooks(repo.id, {
        event: "pulls",
        payload: {
          action: "assigned",
          pull: { ...pullJson(pull), assignees: items },
          repository: { full_name: `${repo.owner_username}/${repo.name}` },
        },
      });
    }
    return json({ items, added, removed: toRemove.length });
  });

  router.delete("/api/repos/:owner/:name/pulls/:number/assignees/:username", (ctx) => {
    const repo = loadWritableRepo(ctx);
    const pull = requirePull(repo.id, issueNumber(ctx));
    const principal = requireWrite(ctx.auth);
    const target = findUserByUsername(param(ctx, "username"));
    if (!target) throw notFound("No such user");
    if (!removeAssignee("pull", pull.id, target.id)) throw notFound("Not assigned to this pull request");
    recordAssigneeChange(
      repo.id,
      "pull",
      pull.id,
      [target.username],
      [],
      { id: principal.userId, username: principal.username },
    );
    return json({ items: assigneesForItems("pull", [pull.id]).get(pull.id) ?? [] });
  });
}

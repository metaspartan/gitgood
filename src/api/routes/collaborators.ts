import { json, readJson } from "../../lib/http.ts";
import { badRequest, forbidden, notFound } from "../../lib/errors.ts";
import * as v from "../../lib/validate.ts";
import type { Router } from "../router.ts";
import type { RouteContext } from "../router.ts";
import { loadRepo, param } from "../helpers.ts";
import { one } from "../../db/index.ts";
import type { RepoRecord } from "../../data/repos.ts";
import { canRead } from "../../data/repos.ts";
import {
  addCollaborator,
  listCollaborators,
  removeCollaborator,
} from "../../data/collaborators.ts";
import type { Auth } from "../../auth/service.ts";

const collaboratorSchema = v.strictObject({
  username: v.string({ min: 1, max: 39, trim: true }),
  permission: v.enumOf(["read", "write"]),
});

function canManageAccess(repo: RepoRecord, auth: Auth): boolean {
  if (auth.kind !== "user") return false;
  if (auth.isAdmin) return true;
  if (repo.org_id !== null) return false;
  return auth.userId === repo.owner_id;
}

export function registerCollaboratorRoutes(router: Router): void {
  router.get("/api/repos/:owner/:name/collaborators", (ctx) => {
    const repo = loadRepo(ctx);
    if (!canRead(repo, ctx.auth)) throw notFound("Repository not found");
    return json({
      items: listCollaborators(repo.id),
      can_manage: canManageAccess(repo, ctx.auth),
    });
  });

  router.post("/api/repos/:owner/:name/collaborators", async (ctx: RouteContext) => {
    const repo = loadRepo(ctx);
    if (!canRead(repo, ctx.auth)) throw notFound("Repository not found");
    if (!canManageAccess(repo, ctx.auth)) {
      throw forbidden("Only the repository owner or an administrator can manage collaborators");
    }
    const body = await readJson(ctx.request, collaboratorSchema);
    const target = one<{ id: number; username: string }>(
      "SELECT id, username FROM users WHERE username = ?",
      body.username,
    );
    if (!target) throw notFound("No such user");
    if (target.id === repo.owner_id) throw badRequest("The owner already has full access");
    addCollaborator(repo.id, target.id, body.permission);
    return json({ username: target.username, permission: body.permission }, { status: 201 });
  });

  router.delete("/api/repos/:owner/:name/collaborators/:username", (ctx: RouteContext) => {
    const repo = loadRepo(ctx);
    if (!canRead(repo, ctx.auth)) throw notFound("Repository not found");
    if (!canManageAccess(repo, ctx.auth)) {
      throw forbidden("Only the repository owner or an administrator can manage collaborators");
    }
    const target = one<{ id: number }>("SELECT id FROM users WHERE username = ?", param(ctx, "username"));
    if (!target) throw notFound("No such user");
    if (!removeCollaborator(repo.id, target.id)) throw notFound("Not a collaborator");
    return json({ ok: true });
  });
}

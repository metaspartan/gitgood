import { json, jsonFor, readJson, weakEtag } from "../../lib/http.ts";
import { notFound } from "../../lib/errors.ts";
import * as v from "../../lib/validate.ts";
import { findUserByUsername, requireUser } from "../../auth/service.ts";
import {
  addMember,
  assertOrgRole,
  createOrg,
  deleteOrg,
  findOrgWithCounts,
  hasOrgRole,
  listMembers,
  listOrgs,
  listOrgsForUser,
  membershipFor,
  removeMember,
  requireOrg,
  setMemberRole,
  updateOrg,
} from "../../data/orgs.ts";
import { listReposByOrg, statsFromCounts } from "../../data/repos.ts";
import { orgJson, orgMemberJson, repoJson } from "../serialize.ts";
import { param } from "../helpers.ts";
import type { Router } from "../router.ts";

const roleSchema = v.enumOf(["owner", "admin", "member"] as const);

const createOrgSchema = v.strictObject({
  name: v.string({ min: 1, max: 39 }),
  display_name: v.optional(v.string({ max: 80 })),
  description: v.optional(v.string({ max: 500 })),
});

const updateOrgSchema = v.strictObject({
  display_name: v.optional(v.string({ max: 80 })),
  description: v.optional(v.string({ max: 500 })),
});

const addMemberSchema = v.strictObject({
  username: v.string({ min: 1, max: 39 }),
  role: v.optional(roleSchema),
});

const setRoleSchema = v.strictObject({ role: roleSchema });

function userIdFor(username: string): number {
  const user = findUserByUsername(username);
  if (!user) throw notFound(`No user named ${username}`);
  return user.id;
}

export function registerOrgRoutes(router: Router): void {
  router.get("/api/orgs/mine", (ctx) => {
    const principal = requireUser(ctx.auth);
    return json({ items: listOrgsForUser(principal.userId).map(orgJson) });
  });

  router.get("/api/orgs", (ctx) => {
    const items = listOrgs().map(orgJson);
    return jsonFor(ctx.request, { items }, { etag: weakEtag(JSON.stringify(items)) });
  });

  router.post("/api/orgs", async (ctx) => {
    const principal = requireUser(ctx.auth);
    const body = await readJson(ctx.request, createOrgSchema);
    const org = createOrg(principal, {
      name: body.name,
      ...(body.display_name === undefined ? {} : { displayName: body.display_name }),
      ...(body.description === undefined ? {} : { description: body.description }),
    });
    return json(orgJson(org), { status: 201 });
  });

  router.get("/api/orgs/:org", (ctx) => {
    const name = param(ctx, "org");
    const org = findOrgWithCounts(name);
    if (!org) throw notFound(`Organisation ${name} not found`);

    return json({
      ...orgJson(org),
      viewer_role: ctx.auth.kind === "user" ? membershipFor(org.id, ctx.auth.userId) : null,
      viewer_can_administer: ctx.auth.kind === "user" && hasOrgRole(ctx.auth, org.id, "admin"),
    });
  });

  router.patch("/api/orgs/:org", async (ctx) => {
    const org = requireOrg(param(ctx, "org"));
    assertOrgRole(ctx.auth, org.id, "admin");
    const body = await readJson(ctx.request, updateOrgSchema);
    const updated = updateOrg(org, {
      ...(body.display_name === undefined ? {} : { displayName: body.display_name }),
      ...(body.description === undefined ? {} : { description: body.description }),
    });
    return json(orgJson(updated));
  });

  router.delete("/api/orgs/:org", (ctx) => {
    const org = requireOrg(param(ctx, "org"));
    assertOrgRole(ctx.auth, org.id, "owner");
    deleteOrg(org);
    return json({ ok: true });
  });

  router.get("/api/orgs/:org/repos", (ctx) => {
    const org = requireOrg(param(ctx, "org"));
    const isMemberViewer =
      ctx.auth.kind === "user" && hasOrgRole(ctx.auth, org.id, "member");
    const items = listReposByOrg(org.id)
      .filter((repo) => repo.visibility === "public" || isMemberViewer)
      .map((repo) => ({ ...repoJson(repo), ...statsFromCounts(repo) }));
    return jsonFor(ctx.request, { items }, { etag: weakEtag(JSON.stringify(items)) });
  });

  router.get("/api/orgs/:org/members", (ctx) => {
    const org = requireOrg(param(ctx, "org"));
    return json({ items: listMembers(org.id).map(orgMemberJson) });
  });

  router.post("/api/orgs/:org/members", async (ctx) => {
    const org = requireOrg(param(ctx, "org"));
    assertOrgRole(ctx.auth, org.id, "admin");
    const body = await readJson(ctx.request, addMemberSchema);
    if (body.role === "owner") assertOrgRole(ctx.auth, org.id, "owner");
    const member = addMember(org, {
      username: body.username,
      ...(body.role === undefined ? {} : { role: body.role }),
    });
    return json(orgMemberJson(member), { status: 201 });
  });

  router.patch("/api/orgs/:org/members/:username", async (ctx) => {
    const org = requireOrg(param(ctx, "org"));
    assertOrgRole(ctx.auth, org.id, "admin");
    const body = await readJson(ctx.request, setRoleSchema);
    if (body.role === "owner") assertOrgRole(ctx.auth, org.id, "owner");
    setMemberRole(org, userIdFor(param(ctx, "username")), body.role);
    return json({ ok: true, role: body.role });
  });

  router.delete("/api/orgs/:org/members/:username", (ctx) => {
    const org = requireOrg(param(ctx, "org"));
    const target = userIdFor(param(ctx, "username"));
    const isSelf = ctx.auth.kind === "user" && ctx.auth.userId === target;
    if (!isSelf) {
      assertOrgRole(ctx.auth, org.id, "admin");
      if (membershipFor(org.id, target) === "owner") {
        assertOrgRole(ctx.auth, org.id, "owner");
      }
    }
    removeMember(org, target);
    return json({ ok: true });
  });
}

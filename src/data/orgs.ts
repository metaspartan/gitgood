import { all, changes, now, one, run, scalar } from "../db/index.ts";
import { conflict, forbidden, notFound, unprocessable } from "../lib/errors.ts";
import { hueFor, USERNAME_PATTERN } from "../lib/ids.ts";
import type { Auth, Principal } from "../auth/service.ts";

export type OrgRole = "owner" | "admin" | "member";

const ROLE_RANK: Record<OrgRole, number> = { member: 0, admin: 1, owner: 2 };

export interface OrgRow {
  id: number;
  name: string;
  display_name: string;
  description: string;
  avatar_hue: number;
  created_by: number;
  created_at: number;
  updated_at: number;
}

export interface OrgWithCounts extends OrgRow {
  repo_count: number;
  member_count: number;
  viewer_role?: OrgRole;
}

export interface OrgMembership {
  org_id: number;
  user_id: number;
  role: OrgRole;
  created_at: number;
}

export interface OrgMemberWithUser extends OrgMembership {
  username: string;
  display_name: string;
  avatar_hue: number;
}

const SELECT_ORG = `SELECT * FROM orgs`;

const ORG_COUNT_COLUMNS = `
    (SELECT COUNT(*) FROM repos r WHERE r.org_id = o.id) AS repo_count,
    (SELECT COUNT(*) FROM org_members mc WHERE mc.org_id = o.id) AS member_count`;

const SELECT_ORG_WITH_COUNTS = `
  SELECT o.*,${ORG_COUNT_COLUMNS}
  FROM orgs o`;

export function findOrg(name: string): OrgRow | null {
  return one<OrgRow>(`${SELECT_ORG} WHERE name = ?`, name);
}

export function findOrgById(id: number): OrgRow | null {
  return one<OrgRow>(`${SELECT_ORG} WHERE id = ?`, id);
}

export function requireOrg(name: string): OrgRow {
  const org = findOrg(name);
  if (!org) throw notFound(`Organisation ${name} not found`);
  return org;
}

export function findOrgWithCounts(name: string): OrgWithCounts | null {
  return one<OrgWithCounts>(`${SELECT_ORG_WITH_COUNTS} WHERE o.name = ?`, name);
}

export function listOrgsForUser(userId: number): OrgWithCounts[] {
  return all<OrgWithCounts>(
    `SELECT o.*,${ORG_COUNT_COLUMNS}, m.role AS viewer_role
       FROM orgs o
       JOIN org_members m ON m.org_id = o.id AND m.user_id = ?
      ORDER BY o.updated_at DESC`,
    userId,
  );
}

export function listOrgs(limit = 100): OrgWithCounts[] {
  return all<OrgWithCounts>(
    `${SELECT_ORG_WITH_COUNTS} ORDER BY o.updated_at DESC LIMIT ?`,
    limit,
  );
}

export function membershipFor(orgId: number, userId: number): OrgRole | null {
  const row = one<{ role: OrgRole }>(
    "SELECT role FROM org_members WHERE org_id = ? AND user_id = ?",
    orgId,
    userId,
  );
  return row?.role ?? null;
}

export function listMembers(orgId: number): OrgMemberWithUser[] {
  return all<OrgMemberWithUser>(
    `SELECT m.*, u.username, u.display_name, u.avatar_hue
       FROM org_members m JOIN users u ON u.id = m.user_id
      WHERE m.org_id = ?
      ORDER BY CASE m.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END, u.username`,
    orgId,
  );
}

export function hasOrgRole(auth: Auth, orgId: number, required: OrgRole): boolean {
  if (auth.kind !== "user") return false;
  if (auth.isAdmin) return true;
  const role = membershipFor(orgId, auth.userId);
  if (role === null) return false;
  if (auth.via === "token" && required !== "member") {
    if (!auth.scopes.includes("write") && !auth.scopes.includes("admin")) return false;
  }
  return ROLE_RANK[role] >= ROLE_RANK[required];
}

export function assertOrgRole(auth: Auth, orgId: number, required: OrgRole): Principal {
  if (auth.kind !== "user") throw forbidden("Authentication required");
  if (!hasOrgRole(auth, orgId, required)) {
    throw forbidden(`You need the ${required} role in this organisation`);
  }
  return auth;
}

export interface CreateOrgInput {
  name: string;
  displayName?: string;
  description?: string;
}

export function createOrg(creator: Principal, input: CreateOrgInput): OrgRow {
  const name = input.name.trim();
  if (!USERNAME_PATTERN.test(name)) {
    throw unprocessable(
      "Organisation names must start with a letter or digit and contain only letters, digits, dashes or underscores",
    );
  }
  if (name.length > 39) throw unprocessable("Organisation names are limited to 39 characters");

  return transactCreate(creator, name, input);
}

function transactCreate(creator: Principal, name: string, input: CreateOrgInput): OrgRow {
  return transaction(() => {
    const clash = scalar<number>(
      `SELECT (SELECT COUNT(*) FROM users WHERE username = ?)
            + (SELECT COUNT(*) FROM orgs WHERE name = ?)`,
      name,
      name,
    );
    if ((clash ?? 0) > 0) throw conflict(`${name} is already taken`);

    const timestamp = now();
    const id = run(
      `INSERT INTO orgs (name, display_name, description, avatar_hue, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      name,
      input.displayName?.trim() || name,
      input.description?.trim() ?? "",
      hueFor(name),
      creator.userId,
      timestamp,
      timestamp,
    );
    run(
      "INSERT INTO org_members (org_id, user_id, role, created_at) VALUES (?, ?, 'owner', ?)",
      id,
      creator.userId,
      timestamp,
    );
    const created = findOrgById(id);
    if (!created) throw notFound("Organisation disappeared during creation");
    return created;
  });
}

import { transaction } from "../db/index.ts";

export interface UpdateOrgInput {
  displayName?: string;
  description?: string;
}

export function updateOrg(org: OrgRow, input: UpdateOrgInput): OrgRow {
  const fields: string[] = [];
  const values: Array<string | number> = [];
  if (input.displayName !== undefined) {
    fields.push("display_name = ?");
    values.push(input.displayName.trim() || org.name);
  }
  if (input.description !== undefined) {
    fields.push("description = ?");
    values.push(input.description.trim());
  }
  if (fields.length === 0) return org;
  fields.push("updated_at = ?");
  values.push(now());
  values.push(org.id);
  changes(`UPDATE orgs SET ${fields.join(", ")} WHERE id = ?`, ...values);
  const updated = findOrgById(org.id);
  if (!updated) throw notFound("Organisation not found after update");
  return updated;
}

export function deleteOrg(org: OrgRow): void {
  const repos = scalar<number>("SELECT COUNT(*) FROM repos WHERE org_id = ?", org.id) ?? 0;
  if (repos > 0) {
    throw conflict(
      `This organisation still owns ${repos} ${repos === 1 ? "repository" : "repositories"}. ` +
        "Delete or transfer them first.",
    );
  }
  changes("DELETE FROM orgs WHERE id = ?", org.id);
}

export interface AddMemberInput {
  username: string;
  role?: OrgRole;
}

export function addMember(org: OrgRow, input: AddMemberInput): OrgMemberWithUser {
  const user = one<{ id: number; username: string }>(
    "SELECT id, username FROM users WHERE username = ?",
    input.username.trim(),
  );
  if (!user) throw notFound(`No user named ${input.username}`);

  const existing = membershipFor(org.id, user.id);
  if (existing) throw conflict(`${user.username} is already a member`);

  run(
    "INSERT INTO org_members (org_id, user_id, role, created_at) VALUES (?, ?, ?, ?)",
    org.id,
    user.id,
    input.role ?? "member",
    now(),
  );
  const row = one<OrgMemberWithUser>(
    `SELECT m.*, u.username, u.display_name, u.avatar_hue
       FROM org_members m JOIN users u ON u.id = m.user_id
      WHERE m.org_id = ? AND m.user_id = ?`,
    org.id,
    user.id,
  );
  if (!row) throw notFound("Membership disappeared during creation");
  return row;
}

export function setMemberRole(org: OrgRow, userId: number, role: OrgRole): void {
  if (role !== "owner") assertNotLastOwner(org.id, userId, "demote");
  const changed = changes(
    "UPDATE org_members SET role = ? WHERE org_id = ? AND user_id = ?",
    role,
    org.id,
    userId,
  );
  if (changed === 0) throw notFound("That user is not a member");
}

export function removeMember(org: OrgRow, userId: number): void {
  assertNotLastOwner(org.id, userId, "remove");
  const changed = changes(
    "DELETE FROM org_members WHERE org_id = ? AND user_id = ?",
    org.id,
    userId,
  );
  if (changed === 0) throw notFound("That user is not a member");
}

function assertNotLastOwner(orgId: number, userId: number, verb: string): void {
  const current = membershipFor(orgId, userId);
  if (current !== "owner") return;
  const owners = scalar<number>(
    "SELECT COUNT(*) FROM org_members WHERE org_id = ? AND role = 'owner'",
    orgId,
  );
  if ((owners ?? 0) <= 1) {
    throw conflict(`Cannot ${verb} the only owner; promote someone else first`);
  }
}

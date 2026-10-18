import { json, readJson } from "../../lib/http.ts";
import { recordMilestoneChange } from "../../data/thread-events.ts";
import { badRequest, notFound } from "../../lib/errors.ts";
import * as v from "../../lib/validate.ts";
import type { RouteContext, Router } from "../router.ts";
import { loadReadableRepo, loadWritableRepo, param } from "../helpers.ts";
import { all, changes } from "../../db/index.ts";
import { findIssueByNumber } from "../../data/issues.ts";
import { requirePull } from "../../data/pulls.ts";
import {
  createMilestone,
  deleteMilestone,
  listMilestones,
  milestoneBelongsTo,
  requireMilestoneByNumber,
  milestoneTitle,
  setIssueMilestone,
  setPullMilestone,
  updateMilestone,
  type MilestoneState,
  type MilestoneWithCounts,
} from "../../data/milestones.ts";

const dateSchema = v.string({ min: 10, max: 10 });
const dueOnSchema = v.nullable(dateSchema);
const milestoneIdSchema = v.nullable(v.number({ int: true, min: 1 }));

const createSchema = v.strictObject({
  title: v.string({ min: 1, max: 256, trim: true }),
  description: v.optional(v.string({ max: 65536 })),
  due_on: dueOnSchema,
});

const updateSchema = v.strictObject({
  title: v.optional(v.string({ min: 1, max: 256, trim: true })),
  description: v.optional(v.string({ max: 65536 })),
  state: v.optional(v.enumOf(["open", "closed"] as const)),
  due_on: dueOnSchema,
});

function parseNumberParam(ctx: RouteContext, key: string, label: string): number {
  const parsed = Number.parseInt(param(ctx, key), 10);
  if (!Number.isFinite(parsed) || parsed < 1) throw badRequest(`Invalid ${label}`);
  return parsed;
}

function parseDueOn(value: string | null | undefined): number | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value === "") return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) throw badRequest("due_on must be YYYY-MM-DD");
  const [, year, month, day] = match as unknown as [string, string, string, string];
  const millis = Date.UTC(Number(year), Number(month) - 1, Number(day));
  const round = new Date(millis);
  if (
    Number.isNaN(millis) ||
    round.getUTCFullYear() !== Number(year) ||
    round.getUTCMonth() !== Number(month) - 1 ||
    round.getUTCDate() !== Number(day)
  ) {
    throw badRequest("due_on is not a real date");
  }
  return millis;
}

export function milestoneJson(milestone: MilestoneWithCounts) {
  const open = milestone.open_issues + milestone.open_pulls;
  const closed = milestone.closed_issues + milestone.merged_pulls + milestone.closed_pulls;
  const total = open + closed;
  return {
    id: milestone.id,
    number: milestone.number,
    title: milestone.title,
    description: milestone.description,
    state: milestone.state,
    due_on: milestone.due_on,
    created_at: milestone.created_at,
    updated_at: milestone.updated_at,
    closed_at: milestone.closed_at,
    creator: { id: milestone.creator_id, username: milestone.creator_username },
    open_issues: milestone.open_issues,
    closed_issues: milestone.closed_issues,
    open_pulls: milestone.open_pulls,
    merged_pulls: milestone.merged_pulls,
    closed_pulls: milestone.closed_pulls,
    open_count: open,
    closed_count: closed,
    total_count: total,
    completion_percent: total === 0 ? 0 : Math.round((closed / total) * 100),
  };
}

export function registerMilestoneRoutes(router: Router): void {
  router.get("/api/repos/:owner/:name/milestones", (ctx) => {
    const repo = loadReadableRepo(ctx);
    const requested = ctx.url.searchParams.get("state") ?? "open";
    const state: MilestoneState | "all" =
      requested === "all" || requested === "closed" || requested === "open" ? requested : "open";
    return json({ items: listMilestones(repo.id, state).map(milestoneJson) });
  });

  router.post("/api/repos/:owner/:name/milestones", async (ctx) => {
    const repo = loadWritableRepo(ctx);
    if (ctx.auth.kind !== "user") throw badRequest("A signed-in user is required");
    const body = await readJson(ctx.request, createSchema);
    const dueOn = parseDueOn(body.due_on);
    return json(
      milestoneJson(
        createMilestone(repo, ctx.auth.userId, {
          title: body.title,
          ...(body.description !== undefined ? { description: body.description } : {}),
          ...(dueOn !== undefined ? { dueOn } : {}),
        }),
      ),
      { status: 201 },
    );
  });

  router.get("/api/repos/:owner/:name/milestones/:number", (ctx) => {
    const repo = loadReadableRepo(ctx);
    return json(milestoneJson(requireMilestoneByNumber(repo.id, parseNumberParam(ctx, "number", "milestone number"))));
  });

  router.patch("/api/repos/:owner/:name/milestones/:number", async (ctx) => {
    const repo = loadWritableRepo(ctx);
    const milestone = requireMilestoneByNumber(repo.id, parseNumberParam(ctx, "number", "milestone number"));
    const body = await readJson(ctx.request, updateSchema);
    const dueOn = parseDueOn(body.due_on);
    return json(
      milestoneJson(
        updateMilestone(milestone, {
          ...(body.title !== undefined ? { title: body.title } : {}),
          ...(body.description !== undefined ? { description: body.description } : {}),
          ...(body.state !== undefined ? { state: body.state } : {}),
          ...(dueOn !== undefined ? { dueOn } : {}),
        }),
      ),
    );
  });

  router.delete("/api/repos/:owner/:name/milestones/:number", (ctx) => {
    const repo = loadWritableRepo(ctx);
    if (!deleteMilestone(repo.id, parseNumberParam(ctx, "number", "milestone number"))) {
      throw notFound("Milestone not found");
    }
    return json({ ok: true });
  });

  router.get("/api/repos/:owner/:name/milestones/:number/items", (ctx) => {
    const repo = loadReadableRepo(ctx);
    const milestone = requireMilestoneByNumber(repo.id, parseNumberParam(ctx, "number", "milestone number"));
    const issues = all<{ id: number; number: number; title: string; state: string }>(
      "SELECT id, number, title, state FROM issues WHERE milestone_id = ? ORDER BY number",
      milestone.id,
    );
    const pulls = all<{ id: number; number: number; title: string; state: string }>(
      "SELECT id, number, title, state FROM pulls WHERE milestone_id = ? ORDER BY number",
      milestone.id,
    );
    return json({
      issues,
      pulls,
      total: issues.length + pulls.length,
    });
  });

  router.post("/api/repos/:owner/:name/milestones/:number/issues/:issue", (ctx) => {
    const repo = loadWritableRepo(ctx);
    const milestone = requireMilestoneByNumber(repo.id, parseNumberParam(ctx, "number", "milestone number"));
    const issue = findIssueByNumber(repo.id, parseNumberParam(ctx, "issue", "issue number"));
    if (!issue) throw notFound("Issue not found");
    setIssueMilestone(issue.id, milestone.id);
    return json(milestoneJson(requireMilestoneByNumber(repo.id, milestone.number)));
  });

  router.delete("/api/repos/:owner/:name/milestones/:number/issues/:issue", (ctx) => {
    const repo = loadWritableRepo(ctx);
    const milestone = requireMilestoneByNumber(repo.id, parseNumberParam(ctx, "number", "milestone number"));
    const number = parseNumberParam(ctx, "issue", "issue number");
    if (changes(
      "UPDATE issues SET milestone_id = NULL WHERE repo_id = ? AND number = ? AND milestone_id = ?",
      repo.id,
      number,
      milestone.id,
    ) === 0) {
      throw notFound("Issue is not in this milestone");
    }
    return json(milestoneJson(requireMilestoneByNumber(repo.id, milestone.number)));
  });

  router.post("/api/repos/:owner/:name/milestones/:number/pulls/:pull", (ctx) => {
    const repo = loadWritableRepo(ctx);
    const milestone = requireMilestoneByNumber(repo.id, parseNumberParam(ctx, "number", "milestone number"));
    const pull = requirePull(repo.id, parseNumberParam(ctx, "pull", "pull request number"));
    setPullMilestone(pull.id, milestone.id);
    return json(milestoneJson(requireMilestoneByNumber(repo.id, milestone.number)));
  });

  router.delete("/api/repos/:owner/:name/milestones/:number/pulls/:pull", (ctx) => {
    const repo = loadWritableRepo(ctx);
    const milestone = requireMilestoneByNumber(repo.id, parseNumberParam(ctx, "number", "milestone number"));
    const number = parseNumberParam(ctx, "pull", "pull request number");
    if (changes(
      "UPDATE pulls SET milestone_id = NULL WHERE repo_id = ? AND number = ? AND milestone_id = ?",
      repo.id,
      number,
      milestone.id,
    ) === 0) {
      throw notFound("Pull request is not in this milestone");
    }
    return json(milestoneJson(requireMilestoneByNumber(repo.id, milestone.number)));
  });

  router.post("/api/repos/:owner/:name/issues/:number/milestone", async (ctx) => {
    const repo = loadWritableRepo(ctx);
    const body = await readJson(ctx.request, v.strictObject({ milestone_id: milestoneIdSchema }));
    const issue = findIssueByNumber(repo.id, parseNumberParam(ctx, "number", "issue number"));
    if (!issue) throw notFound("Issue not found");
    if (body.milestone_id != null && !milestoneBelongsTo(body.milestone_id, repo.id)) {
      throw notFound("Milestone not found");
    }
    const before = milestoneTitle(repo.id, issue.milestone_id ?? null);
    setIssueMilestone(issue.id, body.milestone_id ?? null);
    const after = milestoneTitle(repo.id, body.milestone_id ?? null);
    recordMilestoneChange(
      repo.id,
      "issue",
      issue.id,
      before,
      after,
      ctx.auth.kind === "user" ? { id: ctx.auth.userId, username: ctx.auth.username } : null,
    );
    return json({ ok: true, milestone_id: body.milestone_id ?? null });
  });

  router.post("/api/repos/:owner/:name/pulls/:number/milestone", async (ctx) => {
    const repo = loadWritableRepo(ctx);
    const body = await readJson(ctx.request, v.strictObject({ milestone_id: milestoneIdSchema }));
    const pull = requirePull(repo.id, parseNumberParam(ctx, "number", "pull request number"));
    if (body.milestone_id != null && !milestoneBelongsTo(body.milestone_id, repo.id)) {
      throw notFound("Milestone not found");
    }
    const before = milestoneTitle(repo.id, pull.milestone_id ?? null);
    setPullMilestone(pull.id, body.milestone_id ?? null);
    const after = milestoneTitle(repo.id, body.milestone_id ?? null);
    recordMilestoneChange(
      repo.id,
      "pull",
      pull.id,
      before,
      after,
      ctx.auth.kind === "user" ? { id: ctx.auth.userId, username: ctx.auth.username } : null,
    );
    return json({ ok: true, milestone_id: body.milestone_id ?? null });
  });
}

import { json, jsonFor, weakEtag } from "../../lib/http.ts";
import { all, one } from "../../db/index.ts";
import { issueJson, pullJson, repoJson } from "../serialize.ts";
import { canRead, findRepo, type RepoRecord } from "../../data/repos.ts";
import { indexSummary, searchCode } from "../../data/code-index.ts";
import type { IssueWithAuthor } from "../../data/issues.ts";
import type { PullWithAuthor } from "../../data/pulls.ts";
import type { Router } from "../router.ts";

const RESULT_LIMIT = 25;
const CODE_RESULT_LIMIT = 60;

const VISIBLE_REPO_SQL = `(
  r.visibility = 'public'
  OR r.owner_id = ?
  OR (r.org_id IS NOT NULL AND EXISTS (
       SELECT 1 FROM org_members om WHERE om.org_id = r.org_id AND om.user_id = ?
     ))
  OR ?
)`;

export function visibleParams(auth: {
  kind: string;
  userId?: number;
  isAdmin?: boolean;
}): number[] {
  if (auth.kind !== "user") return [0, 0, 0];
  return [auth.userId ?? 0, auth.userId ?? 0, auth.isAdmin ? 1 : 0];
}

interface ScopedRepoRecord extends RepoRecord {
  open_issues: number;
  open_pulls: number;
}

export function toMatchQuery(input: string): string | null {
  const tokens = input.toLowerCase().match(/[\p{L}\p{N}_]+/gu);
  if (!tokens || tokens.length === 0) return null;
  return tokens
    .slice(0, 8)
    .map((token) => `"${token}"*`)
    .join(" ");
}

const SELECT_REPOS = `
  SELECT r.*,
    COALESCE(og.name, u.username) AS owner_username,
    COALESCE(og.display_name, u.display_name) AS owner_display,
    COALESCE(og.avatar_hue, u.avatar_hue) AS owner_hue,
    CASE WHEN r.org_id IS NULL THEN 'user' ELSE 'org' END AS owner_kind,
    COALESCE(ic.c, 0) AS open_issues,
    COALESCE(pc.c, 0) AS open_pulls
  FROM repos r
  JOIN users u ON u.id = r.owner_id
  LEFT JOIN orgs og ON og.id = r.org_id
  LEFT JOIN (SELECT repo_id, COUNT(*) AS c FROM issues WHERE state = 'open' GROUP BY repo_id) ic
    ON ic.repo_id = r.id
  LEFT JOIN (SELECT repo_id, COUNT(*) AS c FROM pulls WHERE state = 'open' GROUP BY repo_id) pc
    ON pc.repo_id = r.id
  WHERE ${VISIBLE_REPO_SQL}
    AND (r.name LIKE ? OR r.description LIKE ?)
  ORDER BY r.updated_at DESC
  LIMIT ${RESULT_LIMIT}`;

const SELECT_ISSUES = `
  SELECT i.*, u.username AS author_username, u.display_name AS author_display, u.avatar_hue AS author_hue,
    COALESCE(og.name, o.username) AS repo_owner, r.name AS repo_name,
    (SELECT COUNT(*) FROM comments c WHERE c.target_type = 'issue' AND c.target_id = i.id) AS comment_count
  FROM issues_fts f
  JOIN issues i ON i.id = f.rowid
  JOIN repos r ON r.id = i.repo_id
  JOIN users u ON u.id = i.author_id
  JOIN users o ON o.id = r.owner_id
  LEFT JOIN orgs og ON og.id = r.org_id
  WHERE issues_fts MATCH ?
    AND ${VISIBLE_REPO_SQL}
  ORDER BY rank, i.updated_at DESC
  LIMIT ${RESULT_LIMIT}`;

const SELECT_PULLS = `
  SELECT p.*, u.username AS author_username, u.display_name AS author_display, u.avatar_hue AS author_hue,
    COALESCE(og.name, o.username) AS repo_owner, r.name AS repo_name,
    (SELECT COUNT(*) FROM comments c WHERE c.target_type = 'pull' AND c.target_id = p.id) AS comment_count
  FROM pulls_fts f
  JOIN pulls p ON p.id = f.rowid
  JOIN repos r ON r.id = p.repo_id
  JOIN users u ON u.id = p.author_id
  JOIN users o ON o.id = r.owner_id
  LEFT JOIN orgs og ON og.id = r.org_id
  WHERE pulls_fts MATCH ?
    AND ${VISIBLE_REPO_SQL}
  ORDER BY rank, p.updated_at DESC
  LIMIT ${RESULT_LIMIT}`;

interface ScopedIssue extends IssueWithAuthor {
  repo_owner: string;
  repo_name: string;
}

interface ScopedPull extends PullWithAuthor {
  repo_owner: string;
  repo_name: string;
}

export function registerSearchRoutes(router: Router): void {
  router.get("/api/search", (ctx) => {
    const raw = ctx.url.searchParams.get("q") ?? "";
    const query = raw.trim();
    const type = ctx.url.searchParams.get("type") ?? "all";
    if (query.length === 0) {
      return json({ query, repos: [], issues: [], pulls: [], code: [] });
    }

    const viewer = visibleParams(ctx.auth);
    const pattern = `%${query}%`;
    const wantsRepos = type !== "issues" && type !== "pulls" && type !== "code";
    const wantsIssues = type !== "repos" && type !== "pulls" && type !== "code";
    const wantsPulls = type !== "repos" && type !== "issues" && type !== "code";
    const wantsCode = type === "all" || type === "code";
    const match = toMatchQuery(query);

    const repos = wantsRepos
      ? all<ScopedRepoRecord>(SELECT_REPOS, ...viewer, pattern, pattern).map((repo) => ({
          ...repoJson(repo),
          openIssues: repo.open_issues,
          openPulls: repo.open_pulls,
        }))
      : [];

    const issues =
      wantsIssues && match
        ? all<ScopedIssue>(SELECT_ISSUES, match, ...viewer).map((issue) => ({
            ...issueJson(issue),
            repository: `${issue.repo_owner}/${issue.repo_name}`,
          }))
        : [];

    const pulls =
      wantsPulls && match
        ? all<ScopedPull>(SELECT_PULLS, match, ...viewer).map((pull) => ({
            ...pullJson(pull),
            repository: `${pull.repo_owner}/${pull.repo_name}`,
          }))
        : [];

    const code =
      wantsCode && match
        ? searchCode(match, viewer, { limit: RESULT_LIMIT }).map((hit) => ({
            repository: `${hit.owner_username}/${hit.name}`,
            path: hit.path,
            language: hit.language,
            snippet: hit.snippet,
          }))
        : [];

    return json({ query, repos, issues, pulls, code });
  });

  router.get("/api/search/code", (ctx) => {
    const query = (ctx.url.searchParams.get("q") ?? "").trim();
    if (query.length === 0) return json({ query, items: [], truncated_index: false });

    const match = toMatchQuery(query);
    if (!match) return json({ query, items: [], truncated_index: false });

    const scope = ctx.url.searchParams.get("repo") ?? "";
    let repoId: number | null = null;
    if (scope.length > 0) {
      const slash = scope.indexOf("/");
      if (slash <= 0) {
        return json(
          { error: { code: "bad_request", message: "repo must be owner/name" } },
          { status: 400 },
        );
      }
      const scoped = findRepo(scope.slice(0, slash), scope.slice(slash + 1));
      if (!scoped || !canRead(scoped, ctx.auth)) {
        return json({ query, items: [], truncated_index: false });
      }
      repoId = scoped.id;
    }

    const hits = searchCode(match, visibleParams(ctx.auth), {
      limit: CODE_RESULT_LIMIT,
      repoId,
    });
    const truncatedIndex = repoId !== null ? (indexStateFor(repoId)?.truncated === 1) : false;
    return json({
      query,
      items: hits.map((hit) => ({
        repository: `${hit.owner_username}/${hit.name}`,
        path: hit.path,
        language: hit.language,
        snippet: hit.snippet,
      })),
      truncated_index: truncatedIndex,
      at_result_limit: hits.length >= CODE_RESULT_LIMIT,
    });
  });

  router.get("/api/search/code/status", (ctx) => {
    const summary = indexSummary();
    void ctx;
    return jsonFor(ctx.request, summary, { etag: weakEtag(JSON.stringify(summary)) });
  });
}

export function searchIndexCounts(): { issues: number; pulls: number } {
  const issues = one<{ c: number }>("SELECT COUNT(*) AS c FROM issues_fts");
  const pulls = one<{ c: number }>("SELECT COUNT(*) AS c FROM pulls_fts");
  return { issues: issues?.c ?? 0, pulls: pulls?.c ?? 0 };
}

import { indexState } from "../../data/code-index.ts";

function indexStateFor(repoId: number): { truncated: number } | null {
  const state = indexState(repoId);
  return state ? { truncated: state.truncated } : null;
}

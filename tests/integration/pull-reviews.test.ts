import { changes } from "../../src/db/index.ts";
import { deleteRef, updateRef } from "../../src/git/repo.ts";
import { repoDiskPath } from "../../src/data/repos.ts";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { createServer } from "../../src/server.ts";
import { findRepo } from "../../src/data/repos.ts";
import { createRun, finishRun } from "../../src/ci/store.ts";

const server = createServer(0);
const base = `http://127.0.0.1:${server.port}`;
const stamp = Date.now().toString(36);
const org = `reviews${stamp}`;
const prefix = `/api/repos/${org}/project`;
class Client {
  cookie = "";
  constructor(readonly username: string) {}
  async request(path: string, method = "GET", body?: unknown) {
    const response = await fetch(base + path, { method, headers: { ...(this.cookie ? { cookie: this.cookie } : {}), ...(body === undefined ? {} : { "content-type": "application/json" }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const cookie = response.headers.get("set-cookie"); if (cookie) this.cookie = cookie.split(";")[0]!;
    return { status: response.status, data: await response.json() };
  }
  async signup() { expect((await this.request("/api/auth/signup", "POST", { username: this.username, email: `${this.username}@example.test`, password: "test-review-password-123" })).status).toBe(201); }
}
const owner = new Client(`ro${stamp}`), reviewer = new Client(`rr${stamp}`), other = new Client(`rx${stamp}`), anonymous = new Client("");
let pull = 0;
let seq = 0;
const reviews = () => `${prefix}/pulls/${pull}/reviews`;
const merge = () => owner.request(`${prefix}/pulls/${pull}/merge`, "POST");
const summary = async () => (await owner.request(reviews())).data;
const review = async (event: string, who = reviewer, commit?: string) => who.request(reviews(), "POST", { event, commit_id: commit ?? (await summary()).head_sha, body: event === "APPROVE" ? "" : "Review feedback" });
const update = () => owner.request(`${prefix}/contents`, "PUT", { branch: "feature", path: "change.txt", content: `change ${++seq}\n`, encoding: "utf8" });

beforeAll(async () => {
  await owner.signup(); await reviewer.signup(); await other.signup();
  expect((await owner.request("/api/orgs", "POST", { name: org })).status).toBe(201);
  expect((await owner.request(`/api/orgs/${org}/members`, "POST", { username: reviewer.username, role: "admin" })).status).toBeLessThan(300);
  expect((await owner.request("/api/repos", "POST", { name: "project", organization: org, visibility: "private" })).status).toBe(201);
  expect((await owner.request(`${prefix}/contents`, "PUT", { branch: "main", path: "README.md", content: "base\n", encoding: "utf8" })).status).toBeLessThan(300);
  expect((await owner.request(`${prefix}/branches`, "POST", { name: "feature", from: "main" })).status).toBe(201);
  expect((await update()).status).toBeLessThan(300);
  const made = await owner.request(`${prefix}/pulls`, "POST", { title: "Reviewed change", head: "feature", base: "main" }); expect(made.status).toBe(201); pull = made.data.number;
});
afterAll(() => server.stop(true));

test("private review endpoints hide content and policies require ownership", async () => {
  expect((await anonymous.request(reviews())).status).toBe(404);
  expect((await other.request(reviews())).status).toBe(404);
  expect((await other.request(`${prefix}/pull-merge-policy`, "PUT", { branch: "main", required_approvals: 1, require_checks: false })).status).toBe(404);
  expect((await owner.request(`${prefix}/pull-merge-policy`, "PUT", { branch: "main", required_approvals: 1, require_checks: false })).status).toBe(200);
  expect((await owner.request(`${prefix}/pull-merge-policy?branch=main`)).data.required_approvals).toBe(1);
  expect((await review("APPROVE", owner)).status).toBe(403);
  expect((await merge()).status).toBe(409);
});

test("policy approval boundary and strict inputs", async () => {
  for (const required of [0, 6]) {
    expect((await owner.request(`${prefix}/pull-merge-policy`, "PUT", { branch: "main", required_approvals: required, require_checks: false })).status).toBe(200);
    expect((await summary()).required_approvals).toBe(required);
  }
  for (const required of [-1, 7]) expect((await owner.request(`${prefix}/pull-merge-policy`, "PUT", { branch: "main", required_approvals: required, require_checks: false })).status).toBe(400);
  expect((await owner.request(`${prefix}/pull-merge-policy`, "PUT", { branch: "main", required_approvals: 1, require_checks: "false" })).status).toBe(400);
  expect((await owner.request(`${prefix}/pull-merge-policy`, "PUT", { branch: "*", required_approvals: 1, require_checks: false })).status).toBe(400);
  expect((await owner.request(`${prefix}/pull-merge-policy`, "PUT", { branch: "main", required_approvals: 1, require_checks: false })).status).toBe(200);
});

test("review decisions are immutable, comments do not dismiss objections, current approval satisfies policy", async () => {
  expect((await review("REQUEST_CHANGES")).status).toBe(201);
  expect((await review("COMMENT")).status).toBe(201);
  expect((await summary()).changes_requested).toBe(1);
  expect((await merge()).status).toBe(409);
  expect((await review("APPROVE")).status).toBe(201);
  const state = await summary(); expect(state.approvals).toBe(1); expect(state.changes_requested).toBe(0); expect(state.items).toHaveLength(3);
});

test("new commits stale approvals and reject a review submitted for old bytes", async () => {
  const old = (await summary()).head_sha;
  expect((await update()).status).toBeLessThan(300);
  expect((await summary()).head_sha).not.toBe(old);
  expect((await summary()).approvals).toBe(0);
  expect((await merge()).status).toBe(409);
  expect((await review("APPROVE", reviewer, old)).status).toBe(409);
  expect((await review("REQUEST_CHANGES")).status).toBe(201);
  expect((await update()).status).toBeLessThan(300);
  expect((await summary()).changes_requested).toBe(1);
  expect((await review("APPROVE")).status).toBe(201);
});

test("revoked review authority no longer counts and read-only tokens cannot decide", async () => {
  expect((await owner.request(`/api/orgs/${org}/members/${reviewer.username}`, "PATCH", { role: "member" })).status).toBeLessThan(300);
  expect((await summary()).approvals).toBe(0);
  expect((await review("APPROVE")).status).toBe(403);
  expect((await merge()).status).toBe(409);
  expect((await owner.request(`/api/orgs/${org}/members/${reviewer.username}`, "PATCH", { role: "admin" })).status).toBeLessThan(300);
  const token = await reviewer.request("/api/tokens", "POST", { name: "read-only-review", scopes: ["read"] }); expect(token.status).toBe(201);
  const response = await fetch(base + reviews(), { method: "POST", headers: { authorization: `Bearer ${token.data.token}`, "content-type": "application/json" }, body: JSON.stringify({ event: "APPROVE", commit_id: (await summary()).head_sha }) });
  expect(response.status).toBe(403); await response.text();
  expect((await reviewer.request(`/api/tokens/${token.data.id}`, "DELETE")).status).toBeLessThan(300);
});

test("required checks fail closed for missing, pending, failed and stale SHA runs; all current jobs must succeed", async () => {
  expect((await owner.request(`${prefix}/pull-merge-policy`, "PUT", { branch: "main", required_approvals: 1, require_checks: true })).status).toBe(200);
  const state = await summary(); const repo = findRepo(org, "project")!; const detail = (await owner.request(`${prefix}/pulls/${pull}`)).data;
  expect((await merge()).status).toBe(409);
  const staleRun = createRun({ repo_id: repo.id, workflow_name: "checks", job_id: "stale", ref_name: "feature", sha: "0".repeat(40), pull_id: detail.id }); finishRun(staleRun, "success", 0);
  expect((await merge()).status).toBe(409);
  const run = (job: string) => createRun({ repo_id: repo.id, workflow_name: "checks", job_id: job, ref_name: "feature", sha: state.head_sha, pull_id: detail.id });
  const build = run("build"), security = run("security");
  expect((await merge()).status).toBe(409);
  finishRun(build, "success", 0); finishRun(security, "failure", 1);
  expect((await merge()).status).toBe(409);
  const retry = run("security"); expect((await merge()).status).toBe(409); finishRun(retry, "success", 0);
  const otherWorkflow = createRun({ repo_id: repo.id, workflow_name: "other-workflow", job_id: "build", ref_name: "feature", sha: state.head_sha, pull_id: detail.id });
  expect((await merge()).status).toBe(409); finishRun(otherWorkflow, "success", 0);
  const beforeFiles = (await owner.request(`${prefix}/pulls/${pull}/files`)).data;
  const merged = await merge(); expect(merged.status).toBe(200); expect(merged.data.pull.state).toBe("merged");
  expect((await review("APPROVE")).status).toBe(409);
  const afterFiles = (await owner.request(`${prefix}/pulls/${pull}/files`)).data;
  expect(afterFiles.items).toEqual(beforeFiles.items); expect(afterFiles.stats).toEqual(beforeFiles.stats);
  expect(afterFiles.comparison_kind).toBe("merge_snapshot"); expect(afterFiles.stats.files_changed).toBeGreaterThan(0);

});


test("merged PR history survives branch updates, deletion and attempted reopening", async () => {
  const before = (await owner.request(`${prefix}/pulls/${pull}/files`)).data;
  const sha = (await summary()).head_sha;
  expect((await update()).status).toBeLessThan(300);
  expect((await summary()).head_sha).toBe(sha);
  const repo = findRepo(org, "project")!;
  await deleteRef(repoDiskPath(repo), "refs/heads/feature");
  expect((await owner.request(`${prefix}/contents`, "PUT", { branch: "main", path: "later.txt", content: "later", encoding: "utf8" })).status).toBeLessThan(300);
  await deleteRef(repoDiskPath(repo), "refs/heads/main");
  expect((await owner.request(`${prefix}/pulls/${pull}/files`)).data).toEqual(before);
  expect((await summary()).head_sha).toBe(sha);
  expect((await summary()).approvals).toBe(1);
  for (const state of ["open", "closed"]) expect((await owner.request(`${prefix}/pulls/${pull}`, "PATCH", { state })).status).toBe(409);
  expect((await owner.request(`${prefix}/pulls/${pull}`, "PATCH", { title: "Historical reviewed change" })).status).toBe(200);
  expect((await anonymous.request(`${prefix}/pulls/${pull}/files`)).status).toBe(404);
  await updateRef(repoDiskPath(repo), "refs/heads/main", sha);
});

test("legacy merged PRs without a snapshot explicitly report unavailable history", async () => {
  const detail = (await owner.request(`${prefix}/pulls/${pull}`)).data;
  changes("UPDATE pulls SET merge_comparison = NULL WHERE id = ?", detail.id);
  const result = await owner.request(`${prefix}/pulls/${pull}/files`);
  expect(result.status).toBe(200); expect(result.data.comparison_available).toBe(false);
  expect(result.data.comparison_message).toContain("cannot be reconstructed reliably");
  expect(result.data.items).toEqual([]);
});

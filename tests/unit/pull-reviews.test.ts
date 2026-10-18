import { describe, expect, test } from "bun:test";
import { migrate, run } from "../../src/db/index.ts";
import { createUser } from "../../src/auth/service.ts";
import { createRepository } from "../../src/data/repos.ts";
import { createRun, finishRun, headChecksVerdict } from "../../src/ci/store.ts";
import {
  addReview,
  assertPolicyAdmin,
  eligibleReviewerIds,
  getMergePolicy,
  putMergePolicy,
  summarizeReviews,
} from "../../src/data/pull-reviews.ts";
import { AppError } from "../../src/lib/errors.ts";
import type { Principal } from "../../src/auth/service.ts";

migrate();

const HEAD_A = "a".repeat(40);
const HEAD_B = "b".repeat(40);

function principal(user: { id: number; username: string }, isAdmin = false): Principal {
  return {
    kind: "user",
    userId: user.id,
    username: user.username,
    isAdmin,
    scopes: ["read", "write", "admin"],
    via: "session",
  };
}

describe("pull review summaries", () => {
  test("stale approvals, persistent change requests, comments, and revocation", async () => {
    const owner = await createUser({
      username: `revowner${Date.now().toString(36)}`,
      email: `revowner${Date.now()}@example.com`,
      password: "password-password",
    });
    const author = await createUser({
      username: `revauthor${Date.now().toString(36)}`,
      email: `revauthor${Date.now()}@example.com`,
      password: "password-password",
    });
    const reviewer = await createUser({
      username: `revreview${Date.now().toString(36)}`,
      email: `revreview${Date.now()}@example.com`,
      password: "password-password",
    });
    const admin = await createUser({
      username: `revadmin${Date.now().toString(36)}`,
      email: `revadmin${Date.now()}@example.com`,
      password: "password-password",
    });
    run(`UPDATE users SET is_admin = 1 WHERE id = ?`, admin.id);

    const repo = await createRepository(principal(owner), { name: `reviews-${Date.now().toString(36)}` });
    const pullId = run(
      `INSERT INTO pulls (repo_id, number, title, body, state, author_id, head_ref, base_ref, created_at, updated_at)
       VALUES (?, 1, 't', '', 'open', ?, 'feature', 'main', 1, 1)`,
      repo.id,
      author.id,
    );

    addReview({
      repoId: repo.id,
      pullId,
      userId: reviewer.id,
      event: "APPROVE",
      body: "",
      headSha: HEAD_A,
      expectedCommitId: HEAD_A,
    });

    addReview({
      repoId: repo.id,
      pullId,
      userId: reviewer.id,
      event: "COMMENT",
      body: "nit",
      headSha: HEAD_A,
      expectedCommitId: HEAD_A,
    });


    addReview({
      repoId: repo.id,
      pullId,
      userId: author.id,
      event: "APPROVE",
      body: "",
      headSha: HEAD_A,
      expectedCommitId: HEAD_A,
    });

    const eligible = eligibleReviewerIds(repo, author.id);
    expect(eligible.has(owner.id)).toBe(true);
    expect(eligible.has(admin.id)).toBe(true);
    expect(eligible.has(author.id)).toBe(false);
    expect(eligible.has(reviewer.id)).toBe(false);

    expect(summarizeReviews(pullId, HEAD_A, author.id, eligible)).toEqual({
      approvals: 0,
      changes_requested: 0,
    });


    run(`UPDATE repos SET owner_id = ? WHERE id = ?`, reviewer.id, repo.id);
    const asReviewer = { ...repo, owner_id: reviewer.id };
    const nowEligible = eligibleReviewerIds(asReviewer, author.id);
    expect(nowEligible.has(reviewer.id)).toBe(true);
    expect(summarizeReviews(pullId, HEAD_A, author.id, nowEligible)).toEqual({
      approvals: 1,
      changes_requested: 0,
    });

    expect(summarizeReviews(pullId, HEAD_B, author.id, nowEligible)).toEqual({
      approvals: 0,
      changes_requested: 0,
    });

    addReview({
      repoId: repo.id,
      pullId,
      userId: reviewer.id,
      event: "REQUEST_CHANGES",
      body: "no",
      headSha: HEAD_B,
      expectedCommitId: HEAD_B,
    });
    expect(summarizeReviews(pullId, HEAD_B, author.id, nowEligible)).toEqual({
      approvals: 0,
      changes_requested: 1,
    });


    const headC = "c".repeat(40);
    expect(summarizeReviews(pullId, headC, author.id, nowEligible).changes_requested).toBe(1);
    addReview({
      repoId: repo.id,
      pullId,
      userId: reviewer.id,
      event: "APPROVE",
      body: "",
      headSha: headC,
      expectedCommitId: headC,
    });
    expect(summarizeReviews(pullId, headC, author.id, nowEligible)).toEqual({
      approvals: 1,
      changes_requested: 0,
    });

    expect(() =>
      addReview({
        repoId: repo.id,
        pullId,
        userId: reviewer.id,
        event: "APPROVE",
        body: "",
        headSha: headC,
        expectedCommitId: HEAD_A,
      }),
    ).toThrow(AppError);

    run(`UPDATE repos SET owner_id = ? WHERE id = ?`, owner.id, repo.id);
    const revoked = eligibleReviewerIds(repo, author.id);
    expect(summarizeReviews(pullId, headC, author.id, revoked)).toEqual({
      approvals: 0,
      changes_requested: 0,
    });
  });

  test("policy is an exact branch, defaults to off, and writers cannot set it", async () => {
    const owner = await createUser({
      username: `polowner${Date.now().toString(36)}`,
      email: `polowner${Date.now()}@example.com`,
      password: "password-password",
    });
    const stranger = await createUser({
      username: `polstranger${Date.now().toString(36)}`,
      email: `polstranger${Date.now()}@example.com`,
      password: "password-password",
    });
    const repo = await createRepository(principal(owner), { name: `policy-${Date.now().toString(36)}` });

    expect(getMergePolicy(repo.id, "main")).toEqual({
      branch: "main",
      required_approvals: 0,
      require_checks: false,
    });

    putMergePolicy(repo.id, "release/*", 2, true);
    expect(getMergePolicy(repo.id, "main").required_approvals).toBe(0);
    expect(getMergePolicy(repo.id, "release/*")).toEqual({
      branch: "release/*",
      required_approvals: 2,
      require_checks: true,
    });

    expect(() => assertPolicyAdmin(repo, principal(stranger))).toThrow(AppError);
    expect(() => assertPolicyAdmin(repo, principal(owner))).not.toThrow();
    const readToken = { ...principal(owner), via: "token" as const, scopes: ["read"] };
    expect(() => assertPolicyAdmin(repo, readToken)).toThrow(AppError);
  });

  test("required checks need every latest job on this sha to be success", () => {
    const repoId = run(
      `INSERT INTO repos (owner_id, name, description, visibility, default_branch, created_at, updated_at)
       VALUES (1, ?, '', 'public', 'main', 1, 1)`,
      `checks-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`,
    );
    const sha = "d".repeat(40);
    expect(headChecksVerdict(repoId, sha)).toEqual({ ok: false, reason: "no_checks", jobs: 0 });

    const build = createRun({
      repo_id: repoId,
      workflow_name: "ci",
      job_id: "build",
      ref_name: "feature",
      sha,
    });
    expect(headChecksVerdict(repoId, sha).reason).toBe("pending");
    finishRun(build, "success", 0);

    const lint = createRun({
      repo_id: repoId,
      workflow_name: "ci",
      job_id: "lint",
      ref_name: "feature",
      sha,
    });
    finishRun(lint, "failure", 1);
    expect(headChecksVerdict(repoId, sha).ok).toBe(false);

    const lintAgain = createRun({
      repo_id: repoId,
      workflow_name: "ci",
      job_id: "lint",
      ref_name: "feature",
      sha,
    });
    finishRun(lintAgain, "success", 0);
    expect(headChecksVerdict(repoId, sha)).toEqual({ ok: true, reason: null, jobs: 2 });

    expect(headChecksVerdict(repoId, "e".repeat(40)).reason).toBe("no_checks");
  });
});

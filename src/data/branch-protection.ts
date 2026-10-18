import { all, changes, now, one, transaction } from "../db/index.ts";
import { badRequest } from "../lib/errors.ts";
import { GIT_REF_PATTERN } from "../lib/ids.ts";

export const MAX_BRANCH_PROTECTION_RULES = 100;

export interface BranchProtectionRule {
  branch: string;
  require_pull_request: boolean;
}

interface BranchProtectionRow {
  branch: string;
  require_pull_request: number;
}

const ZERO_OID = /^0+$/;

export function removeBranchProtection(repoId: number, branch: string): boolean {
  return changes("DELETE FROM branch_protection WHERE repo_id = ? AND branch = ?", repoId, branch) > 0;
}

export function listBranchProtection(repoId: number): BranchProtectionRule[] {
  const rows = all<BranchProtectionRow>(
    `SELECT branch, require_pull_request FROM branch_protection
      WHERE repo_id = ? ORDER BY branch COLLATE NOCASE ASC`,
    repoId,
  );
  return rows.map((row) => ({
    branch: row.branch,
    require_pull_request: row.require_pull_request === 1,
  }));
}

export function protectedBranchNames(repoId: number): string[] {
  return all<{ branch: string }>(
    `SELECT branch FROM branch_protection
      WHERE repo_id = ? AND require_pull_request = 1
      ORDER BY branch COLLATE NOCASE ASC`,
    repoId,
  ).map((row) => row.branch);
}

export function isBranchProtected(repoId: number, branch: string): boolean {
  const row = one<{ require_pull_request: number }>(
    `SELECT require_pull_request FROM branch_protection WHERE repo_id = ? AND branch = ?`,
    repoId,
    branch,
  );
  return row?.require_pull_request === 1;
}

export function putBranchProtection(
  repoId: number,
  branch: string,
  requirePullRequest: boolean,
): BranchProtectionRule {
  if (!GIT_REF_PATTERN.test(branch) || branch.startsWith("/") || branch.endsWith("/") || branch.includes("//") || branch.endsWith(".") || branch.split("/").some(part => part.startsWith(".") || part.endsWith(".lock"))) {
    throw badRequest("Invalid branch name");
  }
  if (!requirePullRequest) {
    changes("DELETE FROM branch_protection WHERE repo_id = ? AND branch = ?", repoId, branch);
    return { branch, require_pull_request: false };
  }
  const existing = one<{ branch: string }>(
    `SELECT branch FROM branch_protection WHERE repo_id = ? AND branch = ?`,
    repoId,
    branch,
  );
  if (!existing) {
    const count = one<{ c: number }>(
      `SELECT COUNT(*) AS c FROM branch_protection WHERE repo_id = ?`,
      repoId,
    );
    if ((count?.c ?? 0) >= MAX_BRANCH_PROTECTION_RULES) {
      throw badRequest(`A repository can have at most ${MAX_BRANCH_PROTECTION_RULES} branch protection rules`);
    }
  }
  const timestamp = now();
  transaction(() => {
    changes(
      `INSERT INTO branch_protection (repo_id, branch, require_pull_request, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(repo_id, branch) DO UPDATE SET
         require_pull_request = excluded.require_pull_request,
         updated_at = excluded.updated_at`,
      repoId,
      branch,
      requirePullRequest ? 1 : 0,
      timestamp,
    );
  });
  return { branch, require_pull_request: requirePullRequest };
}

export function assertDirectBranchWriteAllowed(repoId: number, branch: string): void {
  if (!isBranchProtected(repoId, branch)) return;
  throw badRequest(
    `Branch "${branch}" requires a pull request. Direct pushes, edits, and deletions are rejected.`,
  );
}

export function branchFromRef(ref: string): string | null {
  if (!ref.startsWith("refs/heads/")) return null;
  const branch = ref.slice("refs/heads/".length);
  if (!branch || branch.startsWith("/") || branch.endsWith("/") || branch.includes("//") || branch.endsWith(".") || branch.split("/").some(part => part.startsWith(".") || part.endsWith(".lock"))) return null;
  if (!GIT_REF_PATTERN.test(branch)) return null;
  return branch;
}

export function rejectionForUpdate(
  protectedBranches: ReadonlySet<string>,
  oldOid: string,
  newOid: string,
  ref: string,
): string | null {
  const branch = branchFromRef(ref);
  if (!branch || !protectedBranches.has(branch)) return null;
  if (!/^[0-9a-fA-F]+$/.test(oldOid) || !/^[0-9a-fA-F]+$/.test(newOid)) {
    return `remote: refusing "${ref}": malformed update`;
  }
  if (oldOid === newOid) return null;
  const verb = ZERO_OID.test(oldOid) ? "create" : ZERO_OID.test(newOid) ? "delete" : "update";
  return `remote: refusing to ${verb} "${ref}": this branch requires a pull request`;
}

function shQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function protectionHookKey(repoId: number): string {
  if (!Number.isSafeInteger(repoId) || repoId < 1) {
    throw badRequest("Invalid repository id for branch protection");
  }
  return `repo-${repoId}`;
}

export function renderPreReceiveHook(branches: readonly string[]): string {
  const refs = branches.map((branch) => `refs/heads/${branch}`);
  const arms = refs.map((ref) => `    ${shQuote(ref)}) protected=1 ;;`).join("\n");
  const snapshot = refs.map(shQuote).join(" ");
  return `#!/bin/sh
set -eu
expected=$(printf '%s\\n' ${snapshot})
actual=$(printf '%s' "\${GITGOOD_PROTECTED_REFS-}")
if [ "\$actual" != "\$expected" ]; then
  echo "remote: branch protection hook was invoked without its trusted snapshot" >&2
  exit 1
fi
while read -r old new ref extra; do
  if [ -z "\${ref:-}" ]; then
    continue
  fi
  if [ -n "\${extra:-}" ]; then
    echo "remote: refusing malformed update" >&2
    exit 1
  fi
  protected=0
  case "\$ref" in
${arms}
  esac
  if [ "\$protected" -ne 1 ]; then
    continue
  fi
  if [ "\$old" = "\$new" ]; then
    continue
  fi
  verb=update
  case "\$old" in
    0000000000000000000000000000000000000000) verb=create ;;
  esac
  case "\$new" in
    0000000000000000000000000000000000000000) verb=delete ;;
  esac
  echo "remote: refusing to \$verb \$ref: this branch requires a pull request" >&2
  exit 1
done
exit 0
`;
}

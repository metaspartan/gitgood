import { git } from "./run.ts";

const SHA = /^[0-9a-f]{40,64}$/;
export const REFS_CONTAINING_LIMIT = 10;

export interface ContainingRefs {
  branches: string[];
  tags: string[];
  more: boolean;
}

export async function refsContaining(repoPath: string, sha: string): Promise<ContainingRefs> {
  if (!SHA.test(sha)) return { branches: [], tags: [], more: false };
  const result = await git(
    ["for-each-ref", `--contains=${sha}`, `--count=${REFS_CONTAINING_LIMIT * 2 + 1}`, "--sort=-creatordate", "--format=%(refname)", "refs/heads", "refs/tags"],
    { cwd: repoPath, timeoutMs: 10_000 },
  ).catch(() => null);
  if (!result || result.exitCode !== 0) return { branches: [], tags: [], more: false };
  const lines = result.stdout.split("\n").filter(Boolean);
  const branches = lines.filter((ref) => ref.startsWith("refs/heads/")).map((ref) => ref.slice(11));
  const tags = lines.filter((ref) => ref.startsWith("refs/tags/")).map((ref) => ref.slice(10));
  return {
    branches: branches.slice(0, REFS_CONTAINING_LIMIT),
    tags: tags.slice(0, REFS_CONTAINING_LIMIT),
    more: branches.length > REFS_CONTAINING_LIMIT || tags.length > REFS_CONTAINING_LIMIT || lines.length > REFS_CONTAINING_LIMIT * 2,
  };
}

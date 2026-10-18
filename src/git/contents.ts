import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { git } from "./run.ts";
import { resolveRef } from "./repo.ts";

function branchRef(branch: string): string {
  return `refs/heads/${branch}`;
}

export function isSafeRepoPath(path: string): boolean {
  if (path.length === 0 || path.length > 512) return false;
  if (path.startsWith("/") || path.endsWith("/")) return false;
  if (path.includes("\\") || path.includes("\0")) return false;
  for (const segment of path.split("/")) {
    if (segment.length === 0 || segment === "." || segment === "..") return false;
    if (segment.toLowerCase() === ".git" || segment.endsWith(".lock")) return false;
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u001f\u007f]/.test(segment)) return false;
  }
  return true;
}

export interface WriteFileInput {
  beforeUpdate?: () => void;
  repoPath: string;
  branch: string;
  filePath: string;
  content: Uint8Array;
  message: string;
  author: { name: string; email: string };
}

export interface CommitResult {
  sha: string;
  branch: string;
  filePath: string;
}

class ContentsError extends Error {
  constructor(
    message: string,
    readonly kind: "not-found" | "conflict",
  ) {
    super(message);
  }
}
export { ContentsError };

export async function writeFileToBranch(input: WriteFileInput): Promise<CommitResult> {
  if (!isSafeRepoPath(input.filePath)) {
    throw new ContentsError("Invalid file path", "not-found");
  }
  const base = await resolveRef(input.repoPath, input.branch);

  if (!base) {
    const anyBranch = await git(["show-ref", "--heads"], { cwd: input.repoPath, allowFailure: true });
    if (anyBranch.exitCode === 0 && anyBranch.stdout.trim().length > 0) {
      throw new ContentsError(`Branch not found: ${input.branch}`, "not-found");
    }
  }
  const baseTree = base
    ? (await git(["rev-parse", `${base}^{tree}`], { cwd: input.repoPath })).stdout.trim()
    : "";
  if (base && !/^[0-9a-f]{40,64}$/.test(baseTree)) {
    throw new ContentsError("Could not read the branch tree", "conflict");
  }

  const scratchId = randomBytes(8).toString("hex");
  const indexFile = join(tmpdir(), `gg-index-${scratchId}`);
  const workTree = join(tmpdir(), `gg-worktree-${scratchId}`);
  mkdirSync(workTree, { recursive: true });
  const indexOptions = {
    cwd: input.repoPath,
    env: { GIT_INDEX_FILE: indexFile, GIT_WORK_TREE: workTree },
  };
  try {
    await git(baseTree ? ["read-tree", baseTree] : ["read-tree", "--empty"], indexOptions);
    const blob = await git(["hash-object", "-w", "--stdin", "--no-filters"], {
      ...indexOptions,
      input: input.content,
    });
    const blobSha = blob.stdout.trim();
    if (!/^[0-9a-f]{40,64}$/.test(blobSha)) {
      throw new ContentsError("Could not store the file content", "conflict");
    }
    await git(["update-index", "--add", "--cacheinfo", `100644,${blobSha},${input.filePath}`], indexOptions);
    const tree = (await git(["write-tree"], indexOptions)).stdout.trim();
    if (!/^[0-9a-f]{40,64}$/.test(tree)) {
      throw new ContentsError("Could not build the new tree", "conflict");
    }

    const committed = await git(
      [
        "-c",
        `user.name=${input.author.name}`,
        "-c",
        `user.email=${input.author.email}`,
        "commit-tree",
        tree,
        ...(base ? ["-p", base] : []),
        "-m",
        input.message,
      ],
      { cwd: input.repoPath },
    );
    const sha = committed.stdout.trim();
    if (!/^[0-9a-f]{40,64}$/.test(sha)) {
      throw new ContentsError("Could not create the commit", "conflict");
    }

    input.beforeUpdate?.();
    const moved = await git(
      ["update-ref", branchRef(input.branch), sha, base ?? "0".repeat(40)],
      { cwd: input.repoPath, allowFailure: true },
    );
    if (moved.exitCode !== 0) {
      throw new ContentsError(
        "That branch moved while you were editing; reload and try again",
        "conflict",
      );
    }
    return { sha, branch: input.branch, filePath: input.filePath };
  } finally {
    rmSync(indexFile, { force: true });
    rmSync(workTree, { recursive: true, force: true });
  }
}

export async function deleteFileFromBranch(input: Omit<WriteFileInput, "content">): Promise<CommitResult> {
  if (!isSafeRepoPath(input.filePath)) {
    throw new ContentsError("Invalid file path", "not-found");
  }
  const base = await resolveRef(input.repoPath, input.branch);
  if (!base) throw new ContentsError(`Branch not found: ${input.branch}`, "not-found");

  const baseTree = (await git(["rev-parse", `${base}^{tree}`], { cwd: input.repoPath })).stdout.trim();
  const present = await git(["cat-file", "-e", `${baseTree}:${input.filePath}`], {
    cwd: input.repoPath,
    allowFailure: true,
  });
  if (present.exitCode !== 0) {
    throw new ContentsError(`No such file on ${input.branch}: ${input.filePath}`, "not-found");
  }

  const scratchId = randomBytes(8).toString("hex");
  const indexFile = join(tmpdir(), `gg-index-${scratchId}`);
  const workTree = join(tmpdir(), `gg-worktree-${scratchId}`);
  mkdirSync(workTree, { recursive: true });
  const indexOptions = {
    cwd: input.repoPath,
    env: { GIT_INDEX_FILE: indexFile, GIT_WORK_TREE: workTree },
  };
  try {
    await git(["read-tree", baseTree], indexOptions);
    await git(["update-index", "--force-remove", input.filePath], indexOptions);
    const tree = (await git(["write-tree"], indexOptions)).stdout.trim();
    if (!/^[0-9a-f]{40,64}$/.test(tree)) {
      throw new ContentsError("Could not build the new tree", "conflict");
    }
    const committed = await git(
      [
        "-c",
        `user.name=${input.author.name}`,
        "-c",
        `user.email=${input.author.email}`,
        "commit-tree",
        tree,
        "-p",
        base,
        "-m",
        input.message,
      ],
      { cwd: input.repoPath },
    );
    const sha = committed.stdout.trim();
    input.beforeUpdate?.();
    const moved = await git(["update-ref", branchRef(input.branch), sha, base], {
      cwd: input.repoPath,
      allowFailure: true,
    });
    if (moved.exitCode !== 0) {
      throw new ContentsError(
        "That branch moved while you were editing; reload and try again",
        "conflict",
      );
    }
    return { sha, branch: input.branch, filePath: input.filePath };
  } finally {
    rmSync(indexFile, { force: true });
    rmSync(workTree, { recursive: true, force: true });
  }
}

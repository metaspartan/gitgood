import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { config } from "../config.ts";
import { git, gitBytes, gitStdout } from "./run.ts";
import { applyRepositorySettings } from "./tuning.ts";
import type {
  GitBranch,
  GitCommit,
  GitCommitDetail,
  GitDiffStat,
  GitFileChange,
  GitRefSnapshot,
  GitTag,
  GitTreeEntry,
} from "./types.ts";

const FMT_NUL = "%x00";
const FMT_RECORD = "%x1e";
const FMT_REF_NUL = "%00";
const FMT_REF_RECORD = "%1e";
const NUL = "\u0000";
const RECORD = "\u001e";

export function repositoryPath(owner: string, name: string): string {
  const clean = name.endsWith(".git") ? name.slice(0, -4) : name;
  return join(config.repoRoot, owner.toLowerCase(), `${clean.toLowerCase()}.git`);
}

export function hashedRepositoryPath(owner: string, name: string): string {
  const clean = name.endsWith(".git") ? name.slice(0, -4) : name;
  const digest = new Bun.CryptoHasher("sha256")
    .update(`${owner.toLowerCase()}/${clean.toLowerCase()}`)
    .digest("hex");
  return join(config.repoRoot, digest.slice(0, 2), digest.slice(2, 4), `${digest}.git`);
}

export function normalizeRepoName(name: string): string {
  return (name.endsWith(".git") ? name.slice(0, -4) : name).trim();
}

export function repositoryExists(path: string): boolean {
  return existsSync(join(path, "HEAD"));
}

export async function initBareRepository(path: string, defaultBranch: string): Promise<void> {
  await git(["init", "--bare", "--quiet", `--initial-branch=${defaultBranch}`, path], {
    allowFailure: true,
  });

  await applyRepositorySettings(path);

  await git(["symbolic-ref", "HEAD", `refs/heads/${defaultBranch}`], {
    cwd: path,
    allowFailure: true,
  });
}

export function removeRepository(path: string): void {
  if (existsSync(path)) rmSync(path, { recursive: true, force: true });
}

export async function refsAt(path: string): Promise<{ branches: GitBranch[]; tags: GitTag[]; head: string }> {
  const out = await gitStdout(
    [
      "for-each-ref",
      `--format=%(HEAD)${FMT_REF_NUL}%(refname)${FMT_REF_NUL}%(objectname)${FMT_REF_NUL}%(*objectname)${FMT_REF_NUL}%(committerdate:unix)${FMT_REF_RECORD}`,
      "refs/heads",
      "refs/tags",
    ],
    { cwd: path },
  );

  const branches: GitBranch[] = [];
  const tags: GitTag[] = [];
  let head = "";
  for (const chunk of out.split(RECORD)) {
    const trimmed = chunk.trim();
    if (!trimmed) continue;
    const [marker = "", ref = "", sha = "", deref = "", updatedAt = "0"] = trimmed.split(NUL);
    if (ref.startsWith("refs/tags/")) {
      tags.push({ name: ref.slice("refs/tags/".length), sha: deref || sha });
      continue;
    }
    if (!ref.startsWith("refs/heads/")) continue;
    const name = ref.slice("refs/heads/".length);
    branches.push({ name, sha: deref || sha, updatedAt: Number(updatedAt) * 1000 });
    if (marker === "*") head = name;
  }
  branches.sort((a, b) => b.updatedAt - a.updatedAt);
  return { branches, tags, head: head || (await headBranch(path)) };
}

export async function listBranches(path: string): Promise<GitBranch[]> {
  return (await refsAt(path)).branches;
}

export async function listTags(path: string): Promise<GitTag[]> {
  return (await refsAt(path)).tags;
}

export async function resolveRef(path: string, ref: string): Promise<string | null> {
  const result = await git(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], {
    cwd: path,
    allowFailure: true,
  });
  const sha = result.stdout.trim();
  return result.exitCode === 0 && sha.length >= 40 ? sha : null;
}

export async function headBranch(path: string): Promise<string> {
  const out = await gitStdout(["symbolic-ref", "--short", "HEAD"], { cwd: path });
  return out.trim() || "main";
}


export async function refSnapshot(path: string): Promise<GitRefSnapshot> {
  const out = await gitStdout(
    ["for-each-ref", `--format=%(refname)${FMT_REF_NUL}%(objectname)${FMT_REF_RECORD}`],
    { cwd: path },
  );
  const refs = new Map<string, string>();
  for (const chunk of out.split(RECORD)) {
    const trimmed = chunk.trim();
    if (!trimmed) continue;
    const [name = "", sha = ""] = trimmed.split(NUL);
    if (name) refs.set(name, sha);
  }
  return { refs, head: await headBranch(path) };
}

export async function createTag(path: string, name: string, sha: string): Promise<void> {
  await git(["tag", name, sha], { cwd: path });
}

export async function updateRef(path: string, ref: string, sha: string): Promise<void> {
  await git(["update-ref", ref, sha], { cwd: path });
}

export async function compareAndSwapRef(
  path: string,
  ref: string,
  sha: string,
  expectedOld: string | null,
  verify?: { ref: string; sha: string },
): Promise<boolean> {
  const old = expectedOld ?? "0".repeat(sha.length);
  const result = verify && verify.ref !== ref
    ? await git(["update-ref", "--stdin", "-z"], {
        cwd: path, allowFailure: true,
        input: `start\0verify ${verify.ref}\0${verify.sha}\0update ${ref}\0${sha}\0${old}\0prepare\0commit\0`,
      })
    : await git(["update-ref", ref, sha, old], { cwd: path, allowFailure: true });
  return result.exitCode === 0;
}

export async function deleteRef(path: string, ref: string): Promise<boolean> {
  const exists = await git(["rev-parse", "--verify", "--quiet", ref], { cwd: path, allowFailure: true });
  if (exists.exitCode !== 0) return false;
  const result = await git(["update-ref", "-d", ref], { cwd: path, allowFailure: true });
  return result.exitCode === 0;
}

export async function isAncestor(path: string, ancestor: string, descendant: string): Promise<boolean> {
  const result = await git(["merge-base", "--is-ancestor", ancestor, descendant], {
    cwd: path,
    allowFailure: true,
  });
  return result.exitCode === 0;
}

export async function commitCount(path: string, ref: string): Promise<number> {
  const out = await gitStdout(["rev-list", "--count", ref], { cwd: path });
  return Number.parseInt(out.trim(), 10) || 0;
}

function parseCommitChunks(out: string): GitCommit[] {
  const commits: GitCommit[] = [];
  for (const chunk of out.split(RECORD)) {
    const trimmed = chunk.replace(/^\n+/, "");
    if (!trimmed) continue;
    const parts = trimmed.split(NUL);
    const [sha = "", shortSha = "", authorName = "", authorEmail = "", authoredAt = "0", parents = "", subject = "", rawBody = ""] = parts;
    const body = rawBody.trim();
    commits.push({
      sha,
      shortSha,
      authorName,
      authorEmail,
      authoredAt: Number(authoredAt) * 1000,
      parents: parents.split(" ").filter(Boolean),
      subject,
      ...(body ? { body: body.length > LIST_BODY_LIMIT ? `${body.slice(0, LIST_BODY_LIMIT)}\u2026` : body } : {}),
    });
  }
  return commits;
}

const LOG_FORMAT = `--pretty=format:%H${FMT_NUL}%h${FMT_NUL}%an${FMT_NUL}%ae${FMT_NUL}%at${FMT_NUL}%P${FMT_NUL}%s${FMT_NUL}%b${FMT_RECORD}`;
const LIST_BODY_LIMIT = 2000;

export async function log(
  path: string,
  ref: string,
  options: { limit?: number; skip?: number; filePath?: string } = {},
): Promise<GitCommit[]> {
  const limit = Math.min(options.limit ?? 30, 500);
  const args = ["log", LOG_FORMAT, `--max-count=${limit}`];
  if (options.skip) args.push(`--skip=${options.skip}`);
  args.push(ref);
  if (options.filePath) args.push("--", options.filePath);
  const out = await gitStdout(args, { cwd: path });
  return parseCommitChunks(out);
}

export async function logRange(path: string, base: string, head: string, limit = 100): Promise<GitCommit[]> {
  const out = await gitStdout(
    ["log", LOG_FORMAT, `--max-count=${limit}`, `${base}..${head}`],
    { cwd: path },
  );
  return parseCommitChunks(out);
}

export async function commitDetail(path: string, sha: string): Promise<GitCommitDetail | null> {
  const result = await git(
    ["show", "-s", `--format=%H${FMT_NUL}%h${FMT_NUL}%an${FMT_NUL}%ae${FMT_NUL}%at${FMT_NUL}%P${FMT_NUL}%s${FMT_NUL}%b`, sha],
    { cwd: path, allowFailure: true },
  );
  if (result.exitCode !== 0) return null;
  const [commit] = parseCommitChunks(result.stdout);
  if (!commit) return null;
  const parts = result.stdout.split(NUL);
  const body = parts[7]?.split(RECORD)[0]?.trim() ?? "";
  const files = await changesForCommit(path, sha);
  const stats: GitDiffStat = {
    additions: files.reduce((sum, f) => sum + f.additions, 0),
    deletions: files.reduce((sum, f) => sum + f.deletions, 0),
    filesChanged: files.length,
  };
  return { ...commit, body, files, stats };
}

export async function treeAt(path: string, ref: string, dir = ""): Promise<GitTreeEntry[]> {
  const target = dir ? `${ref}:${dir}` : ref;
  const out = await gitStdout(["ls-tree", "-z", "-l", target], { cwd: path });
  if (!out) return [];
  const entries: GitTreeEntry[] = [];
  for (const record of out.split(NUL)) {
    if (!record) continue;
    const tab = record.indexOf("\t");
    if (tab === -1) continue;
    const meta = record.slice(0, tab).split(/\s+/);
    const name = record.slice(tab + 1);
    const [mode = "", type = "blob", sha = "", size = "-"] = meta;
    entries.push({
      name,
      path: dir ? `${dir}/${name}` : name,
      type: type === "tree" ? "tree" : type === "commit" ? "commit" : "blob",
      mode,
      sha,
      size: Number.parseInt(size, 10) || 0,
    });
  }
  return entries.sort((a, b) => {
    if (a.type === "tree" && b.type !== "tree") return -1;
    if (b.type === "tree" && a.type !== "tree") return 1;
    return a.name.localeCompare(b.name);
  });
}

export interface BlobResult {
  bytes: Uint8Array;
  size: number;
  truncated: boolean;
}

export async function blobSizes(
  path: string,
  ref: string,
  candidates: readonly string[],
): Promise<Map<string, number>> {
  const sizes = new Map<string, number>();
  if (candidates.length === 0) return sizes;
  const result = await git(
    ["cat-file", "--batch-check"],
    {
      cwd: path,
      allowFailure: true,
      input: `${candidates.map((candidate) => `${ref}:${candidate}`).join("\n")}\n`,
    },
  );
  if (result.exitCode !== 0) return sizes;
  const lines = result.stdout.split("\n");
  for (let i = 0; i < candidates.length && i < lines.length; i += 1) {
    const line = lines[i];
    const candidate = candidates[i]!;
    if (!line) continue;
    const parts = line.trim().split(/\s+/);
    if (parts[1] !== "blob") continue;
    const size = Number.parseInt(parts[2] ?? "", 10);
    if (Number.isFinite(size)) sizes.set(candidate, size);
  }
  return sizes;
}

export async function blobAt(
  path: string,
  ref: string,
  filePath: string,
  maxBytes = 2 * 1024 * 1024,
): Promise<BlobResult | null> {
  const spec = `${ref}:${filePath}`;
  const sizeResult = await git(["cat-file", "-s", spec], { cwd: path, allowFailure: true });
  if (sizeResult.exitCode !== 0) return null;
  const size = Number.parseInt(sizeResult.stdout.trim(), 10) || 0;
  const bytes = await gitBytes(["cat-file", "blob", spec], {
    cwd: path,
    allowFailure: true,
    ...(size > maxBytes ? { maxBytes } : {}),
  });
  return {
    bytes: bytes.subarray(0, maxBytes),
    size,
    truncated: size > maxBytes,
  };
}

export function isBinary(bytes: Uint8Array): boolean {
  const probe = Math.min(bytes.length, 8000);
  for (let i = 0; i < probe; i++) if (bytes[i] === 0) return true;
  return false;
}

async function changesFor(path: string, baseArgs: readonly string[]): Promise<GitFileChange[]> {
  const combined = await gitStdout([...baseArgs, "--numstat", "--raw", "-z"], { cwd: path });
  return parseNumstatAndRaw(combined);
}

function parseNumstatAndRaw(out: string): GitFileChange[] {
  const tokens = out.split(NUL);
  const statuses = new Map<string, GitFileChange["status"]>();
  const counts = new Map<string, NumstatRecord>();

  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (!token) continue;

    if (token.startsWith(":")) {
      const letter = (token.split(" ")[4] ?? "").charAt(0);
      const next = tokens[i + 1];
      if (!next || !letter) continue;
      if (letter === "R" || letter === "C") {
        const after = tokens[i + 2];
        if (after) statuses.set(after, letter === "R" ? "renamed" : "added");
        i += 2;
      } else if (letter === "A") {
        statuses.set(next, "added");
        i += 1;
      } else if (letter === "D") {
        statuses.set(next, "deleted");
        i += 1;
      } else {
        statuses.set(next, "modified");
        i += 1;
      }
      continue;
    }

    const tab1 = token.indexOf("\t");
    if (tab1 === -1) continue;
    const tab2 = token.indexOf("\t", tab1 + 1);
    if (tab2 === -1) continue;

    const additionsRaw = token.slice(0, tab1);
    const deletionsRaw = token.slice(tab1 + 1, tab2);
    const binary = additionsRaw === "-" || deletionsRaw === "-";
    let filePath = token.slice(tab2 + 1);
    let oldPath: string | null = null;

    if (filePath === "") {
      const from = tokens[i + 1];
      const to = tokens[i + 2];
      if (from === undefined || to === undefined || to === "") continue;
      oldPath = from;
      filePath = to;
      i += 2;
    }

    counts.set(filePath, {
      path: filePath,
      oldPath,
      additions: binary ? 0 : Number.parseInt(additionsRaw, 10) || 0,
      deletions: binary ? 0 : Number.parseInt(deletionsRaw, 10) || 0,
      binary,
    });
  }

  return [...counts.values()].map((record) => ({
    path: record.path,
    additions: record.additions,
    deletions: record.deletions,
    binary: record.binary,
    status: statuses.get(record.path) ?? (record.oldPath ? "renamed" : "modified"),
  }));
}

export function changesForCommit(path: string, sha: string): Promise<GitFileChange[]> {
  return changesFor(path, ["diff-tree", "--no-commit-id", "--root", "-r", sha]);
}

export function changesBetween(
  path: string,
  base: string,
  head: string,
): Promise<GitFileChange[]> {
  return changesFor(path, ["diff", `${base}...${head}`]);
}

export interface MergeResult {
  sha: string;
  fastForward: boolean;
  comparison?: { base: string; head: string; files: GitFileChange[] };
}

export interface MergeRefsOptions {
  captureComparison?: boolean;
  pinnedHeadSha?: string;
}

export async function mergeRefs(
  path: string,
  baseRef: string,
  headRef: string,
  message: string,
  author: { name: string; email: string },
  options: MergeRefsOptions = {},
): Promise<MergeResult> {
  const baseSha = await resolveRef(path, baseRef);
  const currentHead = await resolveRef(path, headRef);
  if (!currentHead) throw new Error(`Unknown ref: ${headRef}`);
  const headSha = options.pinnedHeadSha ?? currentHead;
  if (options.pinnedHeadSha && options.pinnedHeadSha !== currentHead) {
    throw new Error("The pull request head moved during merge; review the new commit");
  }

  if (!baseSha && options.captureComparison) throw new Error("Unknown ref: target branch no longer exists");
  if (!baseSha) {
    const swapped = await compareAndSwapRef(path, baseRef, headSha, null, options.pinnedHeadSha ? { ref: headRef, sha: options.pinnedHeadSha } : undefined);
    if (!swapped) throw new Error("The base branch changed during merge; try again");
    return { sha: headSha, fastForward: true };
  }
  const comparison = options.captureComparison ? { base: baseSha, head: headSha, files: await changesBetween(path, baseSha, headSha) } : undefined;
  if (comparison && JSON.stringify(comparison).length > 4 * 1024 * 1024) throw new Error("Merge comparison exceeds the supported metadata size");
  if (baseSha === headSha) return { sha: baseSha, fastForward: true, ...(comparison ? { comparison } : {}) };

  let resultSha = headSha;
  let fastForward = true;
  if (!(await isAncestor(path, baseSha, headSha))) {
    const identity = ["-c", `user.name=${author.name}`, "-c", `user.email=${author.email}`];
    const merged = await git(["merge-tree", "--write-tree", baseSha, headSha], {
      cwd: path,
      allowFailure: true,
    });
    const tree = merged.stdout.trim().split("\n")[0]?.trim();
    if (merged.exitCode !== 0 || !tree || !/^[0-9a-f]{40,64}$/.test(tree)) {
      throw new Error("Merge conflict: resolve it locally and push the result");
    }
    const committed = await git(
      [
        ...identity,
        "commit-tree",
        tree,
        "-p",
        baseSha,
        "-p",
        headSha,
        "-m",
        message,
      ],
      { cwd: path },
    );
    resultSha = committed.stdout.trim();
    fastForward = false;
  }

  if (options.pinnedHeadSha) {
    const again = await resolveRef(path, headRef);
    if (again !== options.pinnedHeadSha) {
      throw new Error("The pull request head moved during merge; review the new commit");
    }
  }
  const swapped = await compareAndSwapRef(path, baseRef, resultSha, baseSha, options.pinnedHeadSha ? { ref: headRef, sha: options.pinnedHeadSha } : undefined);
  if (!swapped) throw new Error("The base branch changed during merge; try again");
  return { sha: resultSha, fastForward, ...(comparison ? { comparison } : {}) };
}

function directorySize(dir: string): number {
  let total = 0;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const full = join(dir, entry);
    try {
      const info = statSync(full);
      total += info.isDirectory() ? directorySize(full) : info.size;
    } catch {
    }
  }
  return total;
}

export interface RepoSize {
  bytes: number;
  looseObjects: number;
  packs: number;
}

export async function repoSize(path: string): Promise<RepoSize> {
  const out = await gitStdout(["count-objects", "-v"], { cwd: path });
  const values = new Map<string, number>();
  for (const line of out.split("\n")) {
    const [key, raw] = line.split(": ");
    if (!key || raw === undefined) continue;
    values.set(key.trim(), Number.parseInt(raw.trim(), 10) || 0);
  }
  let bytes = (values.get("size-pack") ?? 0) * 1024 + (values.get("size") ?? 0) * 1024;
  if (bytes === 0 && (values.get("count") ?? 0) < 5000) {
    bytes = directorySize(join(path, "objects"));
  }
  return {
    bytes,
    looseObjects: values.get("count") ?? 0,
    packs: values.get("packs") ?? 0,
  };
}

export async function runGc(path: string, aggressive = false): Promise<void> {
  const args = aggressive
    ? ["gc", "--aggressive", "--prune=now", "--quiet"]
    : ["gc", "--auto", "--quiet"];
  await git(args, { cwd: path, allowFailure: true, timeoutMs: aggressive ? 6 * 60 * 60 * 1000 : 30 * 60 * 1000 });
}

export async function listTreeWithSizes(
  path: string,
  ref: string,
): Promise<Array<{ path: string; size: number; sha: string }> | null> {
  const result = await git(["ls-tree", "-r", "-l", "-z", ref], {
    cwd: path,
    allowFailure: true,
    timeoutMs: 120_000,
  });
  if (result.exitCode !== 0) return null;

  const entries: Array<{ path: string; size: number; sha: string }> = [];
  for (const record of result.stdout.split("\u0000")) {
    if (record.length === 0) continue;
    const tab = record.indexOf("\t");
    if (tab < 0) continue;
    const meta = record.slice(0, tab).trim().split(/\s+/);
    const filePath = record.slice(tab + 1);
    const [mode, type, sha, size] = meta;
    if (type !== "blob" || mode === undefined || sha === undefined) continue;
    const parsed = size === undefined || size === "-" ? 0 : Number.parseInt(size, 10);
    entries.push({ path: filePath, size: Number.isFinite(parsed) ? parsed : 0, sha });
  }
  return entries;
}

export async function revParse(path: string, ref: string): Promise<string> {
  const result = await git(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], {
    cwd: path,
    allowFailure: true,
    timeoutMs: 30_000,
  });
  return result.exitCode === 0 ? result.stdout.trim() : "";
}

export async function showBlob(
  path: string,
  ref: string,
  filePath: string,
): Promise<string | null> {
  const result = await git(["show", `${ref}:${filePath}`], {
    cwd: path,
    allowFailure: true,
    timeoutMs: 60_000,
  });
  if (result.exitCode !== 0) return null;
  return result.stdout;
}

export async function fetchAllRefs(from: string, to: string, mirror = false): Promise<void> {
  void mirror;
  const result = await git(
    ["fetch", "--quiet", from, "+refs/heads/*:refs/heads/*", "+refs/tags/*:refs/tags/*"],
    { cwd: to, allowFailure: true, timeoutMs: 30 * 60 * 1000 },
  );
  if (result.exitCode !== 0) {
    throw new Error(`fetch from ${from} failed: ${result.stderr.trim().slice(0, 300)}`);
  }
}

export interface PushPolicy {
  denyNonFastForwards: boolean;
  denyDeletes: boolean;
  fsckObjects: boolean;
}

const PUSH_POLICY_KEYS = {
  denyNonFastForwards: "receive.denyNonFastForwards",
  denyDeletes: "receive.denyDeletes",
  fsckObjects: "receive.fsckObjects",
} as const satisfies Record<keyof PushPolicy, string>;

function parseGitBool(value: string): boolean {
  const v = value.trim().toLowerCase();
  return v === "true" || v === "yes" || v === "on" || v === "1";
}

export async function readPushPolicy(path: string, defaults: PushPolicy): Promise<PushPolicy> {
  const result = await git(
    ["config", "--local", "--get-regexp", "^receive\\.(denyNonFastForwards|denyDeletes|fsckObjects)$"],
    { cwd: path, allowFailure: true },
  );
  if (result.exitCode !== 0) return { ...defaults };

  const policy: PushPolicy = { ...defaults };
  for (const line of result.stdout.split("\n")) {
    const separator = line.indexOf(" ");
    if (separator < 0) continue;
    const key = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1);
    for (const [field, configKey] of Object.entries(PUSH_POLICY_KEYS)) {
      if (key === configKey.toLowerCase()) {
        policy[field as keyof PushPolicy] = parseGitBool(value);
      }
    }
  }
  return policy;
}

export async function writePushPolicy(path: string, policy: PushPolicy): Promise<void> {
  for (const [field, key] of Object.entries(PUSH_POLICY_KEYS)) {
    const value = policy[field as keyof PushPolicy] ? "true" : "false";
    const result = await git(["config", "--local", key, value], { cwd: path, allowFailure: true });
    if (result.exitCode !== 0) {
      throw new Error(`could not set ${key}: ${result.stderr.trim().slice(0, 200)}`);
    }
  }
}

export async function verifyRepository(path: string, options: { full?: boolean } = {}): Promise<boolean> {
  const args = options.full
    ? ["fsck", "--no-progress"]
    : ["fsck", "--connectivity-only", "--no-progress"];
  const result = await git(args, {
    cwd: path,
    allowFailure: true,
    timeoutMs: options.full ? 60 * 60 * 1000 : 120_000,
  });
  return result.exitCode === 0;
}

export async function isEmptyRepository(path: string): Promise<boolean> {
  const branches = await listBranches(path);
  return branches.length === 0;
}

export async function defaultBranchOf(path: string): Promise<string> {
  return headBranch(path);
}

export interface PatchFileMeta {
  path: string;
  oldPath: string | null;
  status: GitFileChange["status"];
  binary: boolean;
  additions: number;
  deletions: number;
}

export interface PatchOptions {
  maxFiles?: number;
  maxLines?: number;
  contextLines?: number;
  filePath?: string;
}

export interface BoundedPatch {
  text: string;
  files: PatchFileMeta[];
  truncated: boolean;
  filesChanged: number;
}

export interface NumstatRecord {
  path: string;
  oldPath: string | null;
  additions: number;
  deletions: number;
  binary: boolean;
}

export function parseNameStatus(out: string): Map<string, { status: GitFileChange["status"]; oldPath: string | null }> {
  const statuses = new Map<string, { status: GitFileChange["status"]; oldPath: string | null }>();
  const tokens = out.split(NUL).filter(Boolean);

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (!token) continue;
    const letter = token[0];

    if (letter === "R" || letter === "C") {
      const from = tokens[i + 1];
      const to = tokens[i + 2];
      i += 2;
      if (to) statuses.set(to, { status: "renamed", oldPath: from ?? null });
      continue;
    }

    const filePath = tokens[i + 1];
    i += 1;
    if (!filePath) continue;
    statuses.set(filePath, {
      status: letter === "A" ? "added" : letter === "D" ? "deleted" : "modified",
      oldPath: null,
    });
  }
  return statuses;
}

async function nameStatusRows(
  path: string,
  baseArgs: readonly string[],
): Promise<Map<string, { status: GitFileChange["status"]; oldPath: string | null }>> {
  const out = await gitStdout([...baseArgs, "-M", "--name-status", "-z"], { cwd: path });
  return parseNameStatus(out);
}

function parseNumstat(out: string): NumstatRecord[] {
  const records: NumstatRecord[] = [];
  const tokens = out.split(NUL);

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (!token) continue;
    const tab1 = token.indexOf("\t");
    if (tab1 === -1) continue;
    const tab2 = token.indexOf("\t", tab1 + 1);
    if (tab2 === -1) continue;

    const additionsRaw = token.slice(0, tab1);
    const deletionsRaw = token.slice(tab1 + 1, tab2);
    const binary = additionsRaw === "-" || deletionsRaw === "-";
    let filePath = token.slice(tab2 + 1);
    let oldPath: string | null = null;

    if (filePath === "") {
      const from = tokens[i + 1];
      const to = tokens[i + 2];
      if (from === undefined || to === undefined || to === "") continue;
      oldPath = from;
      filePath = to;
      i += 2;
    }

    records.push({
      path: filePath,
      oldPath,
      additions: binary ? 0 : Number.parseInt(additionsRaw, 10) || 0,
      deletions: binary ? 0 : Number.parseInt(deletionsRaw, 10) || 0,
      binary,
    });
  }
  return records;
}

async function numstatRows(path: string, baseArgs: readonly string[]): Promise<NumstatRecord[]> {
  const out = await gitStdout([...baseArgs, "-M", "--numstat", "-z"], { cwd: path });
  return parseNumstat(out);
}

export async function boundedPatch(
  path: string,
  baseArgs: readonly string[],
  options: PatchOptions = {},
): Promise<BoundedPatch | null> {
  const maxFiles = options.maxFiles ?? 300;
  const maxLines = options.maxLines ?? 40_000;
  const contextLines = options.contextLines ?? 3;

  const rows = await numstatRows(path, baseArgs);
  const statuses = await nameStatusRows(path, baseArgs);
  const candidates = options.filePath ? rows.filter((row) => row.path === options.filePath) : rows;
  if (candidates.length === 0) return null;

  let linesUsed = 0;
  const selected: string[] = [];
  const selectedMeta: PatchFileMeta[] = [];
  let truncated = false;

  for (const row of candidates) {
    if (selected.length >= maxFiles) {
      truncated = true;
      break;
    }
    const cost = row.binary ? 1 : row.additions + row.deletions;
    if (linesUsed + cost > maxLines && selected.length > 0) {
      truncated = true;
      break;
    }
    linesUsed += cost;
    selected.push(row.path);
    const status = statuses.get(row.path);
    selectedMeta.push({
      path: row.path,
      oldPath: status?.oldPath ?? row.oldPath,
      status: status?.status ?? (row.oldPath ? "renamed" : "modified"),
      binary: row.binary,
      additions: row.additions,
      deletions: row.deletions,
    });
  }
  if (selected.length < candidates.length) truncated = true;
  if (selected.length === 0) return null;

  const diffArgs = [...baseArgs, "-M", "--no-color", "--no-ext-diff", `--unified=${contextLines}`, "--"];
  const text = await gitStdout([...diffArgs, ...selected], { cwd: path });

  return { text, files: selectedMeta, truncated, filesChanged: candidates.length };
}

export function commitPatch(path: string, sha: string, options?: PatchOptions): Promise<BoundedPatch | null> {
  return boundedPatch(path, ["show", "--format=", sha], options);
}

export function rangePatch(
  path: string,
  base: string,
  head: string,
  options?: PatchOptions,
): Promise<BoundedPatch | null> {
  return boundedPatch(path, ["diff", `${base}...${head}`], options);
}

const BLAME_HELP = "blame";

export async function blameText(
  path: string,
  ref: string,
  filePath: string,
  maxLines: number,
): Promise<string | null> {
  const result = await git(
    [BLAME_HELP, "--line-porcelain", `-L`, `1,${maxLines}`, ref, "--", filePath],
    { cwd: path, allowFailure: true },
  );
  if (result.exitCode !== 0) return null;
  return result.stdout;
}

export function fileHistory(
  path: string,
  ref: string,
  filePath: string,
  limit = 50,
): Promise<GitCommit[]> {
  return log(path, ref, { limit, filePath });
}

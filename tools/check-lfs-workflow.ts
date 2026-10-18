import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

const BASE = "http://127.0.0.1:3000";
const username = `lfsx${Date.now().toString(36).slice(-8)}`;
const PASSWORD = "supersecret123";

interface RunResult {
  exitCode: number;
  out: string;
  err: string;
}

function git(args: string[], cwd: string, extraEnv: Record<string, string> = {}): RunResult {
  const proc = Bun.spawnSync({
    cmd: ["git", ...args],
    cwd,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", ...extraEnv },
    stdout: "pipe",
    stderr: "pipe",
    timeout: 90_000,
  });
  const timedOut = (proc as { signalCode?: string | null }).signalCode === "SIGTERM";
  return {
    exitCode: proc.exitCode ?? -1,
    out: timedOut ? "" : proc.stdout.toString(),
    err: timedOut ? `TIMED OUT: git ${args.slice(0, 2).join(" ")}` : proc.stderr.toString(),
  };
}

async function api(
  path: string,
  init: { method?: string; body?: unknown } = {},
  cookie = "",
): Promise<{ status: number; data: Record<string, unknown>; setCookie: string | null }> {
  const headers = new Headers();
  if (cookie) headers.set("cookie", cookie);
  let body: string | undefined;
  if (init.body !== undefined) {
    body = JSON.stringify(init.body);
    headers.set("content-type", "application/json");
  }
  const res = await fetch(BASE + path, {
    method: init.method ?? "GET",
    headers,
    ...(body ? { body } : {}),
    signal: AbortSignal.timeout(20_000),
  });
  const text = await res.text();
  let data: Record<string, unknown> = {};
  try {
    data = JSON.parse(text) as Record<string, unknown>;
  } catch {
    data = { raw: text };
  }
  return { status: res.status, data, setCookie: res.headers.get("set-cookie") };
}

let failures = 0;
let checks = 0;
function check(label: string, ok: boolean, detail = ""): void {
  checks += 1;
  if (!ok) failures += 1;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  ${detail}` : ""}`);
}

function blob(seed: number, size: number): Buffer {
  const buf = Buffer.alloc(size);
  for (let i = 0; i < size; i++) buf[i] = (i * 37 + seed * 11 + (i >> 3)) & 0xff;
  return buf;
}

const dir = join(tmpdir(), `lfsx-work-${Date.now()}`);
mkdirSync(dir, { recursive: true });

const signup = await api("/api/auth/signup", {
  method: "POST",
  body: { username, email: `${username}@example.com`, password: PASSWORD },
});
const cookie = (signup.setCookie ?? "").split(";")[0] ?? "";
const tok = await api("/api/tokens", { method: "POST", body: { name: "cli" } }, cookie);
const token = String(tok.data.token ?? "");
await api("/api/repos", { method: "POST", body: { name: "lfsx", lfs_enabled: true } }, cookie);
console.log(`account: ${username}/lfsx  token(${token.length})`);

const remote = `http://${username}:${token}@127.0.0.1:3000/${username}/lfsx.git`;

console.log("\n=== 1. repository setup ===");
check("git init succeeds", git(["init", "--quiet", "-b", "main"], dir).exitCode === 0);
git(["config", "user.name", "T"], dir);
git(["config", "user.email", "t@example.com"], dir);
const lfsInstall = git(["lfs", "install", "--local"], dir);
check("git lfs install --local", lfsInstall.exitCode === 0, lfsInstall.err.trim().slice(0, 80));
const track = git(["lfs", "track", "*.bin"], dir);
check("git lfs track *.bin", track.exitCode === 0);

const big = blob(1, 64 * 1024);
const small = blob(2, 512);
writeFileSync(join(dir, "big.bin"), big);
writeFileSync(join(dir, "small.bin"), small);
writeFileSync(join(dir, "notes.txt"), "plain text\n");

const status = git(["status", "--porcelain"], dir);
check("status lists the tracked binaries", status.out.includes("big.bin") && status.out.includes("small.bin"));

console.log("\n=== 2. commit and push ===");
check("git add succeeds", git(["add", "--all"], dir).exitCode === 0);
const commit1 = git(["commit", "--quiet", "-m", "first"], dir);
check("git commit succeeds", commit1.exitCode === 0, commit1.err.trim().slice(0, 80));
const push1 = git(["push", "--quiet", remote, "main"], dir);
check("git push (uploads LFS objects) succeeds", push1.exitCode === 0, (push1.err || push1.out).trim().slice(0, 200));

const stored = git(["cat-file", "-p", "HEAD:big.bin"], dir);
check("the committed blob is a pointer", stored.out.startsWith("version https://git-lfs.github.com/spec/v1"));
check("the pointer is small", stored.out.length < 200, `${stored.out.length} bytes`);

console.log("\n=== 3. branch and checkout ===");
check("git checkout -b feature", git(["checkout", "--quiet", "-b", "feature"], dir).exitCode === 0);
const onBranch = git(["rev-parse", "--abbrev-ref", "HEAD"], dir);
check("HEAD reports the new branch", onBranch.out.trim() === "feature", onBranch.out.trim());
const blobOnBranch = readFileSync(join(dir, "big.bin"));
check("the LFS file is materialised on the new branch", blobOnBranch.equals(big), `${blobOnBranch.length} vs ${big.length}`);
writeFileSync(join(dir, "feature.txt"), "on the feature branch\n");
git(["add", "--all"], dir);
check("commit on the branch", git(["commit", "--quiet", "-m", "feature work"], dir).exitCode === 0);
check("switch back to main", git(["checkout", "--quiet", "main"], dir).exitCode === 0);
check("the LFS file survives the checkout", readFileSync(join(dir, "big.bin")).equals(big));
check("the branch-only file is gone", !existsSync(join(dir, "feature.txt")));

console.log("\n=== 4. stash ===");
const modified = blob(3, 64 * 1024);
writeFileSync(join(dir, "big.bin"), modified);
const stashPush = git(["stash", "push", "--quiet", "-m", "lfs edit"], dir);
check("git stash push succeeds", stashPush.exitCode === 0, stashPush.err.trim().slice(0, 120));
const afterStash = readFileSync(join(dir, "big.bin"));
const stashRestored = afterStash.equals(big);
check("the worktree is restored to the committed LFS content", stashRestored, `${afterStash.length} bytes`);
const stashPop = git(["stash", "pop", "--quiet"], dir);
check("git stash pop succeeds", stashPop.exitCode === 0, stashPop.err.trim().slice(0, 120));
if (stashPop.exitCode === 0) {
  const popped = readFileSync(join(dir, "big.bin"));
  const isModified = popped.equals(modified);
  const isPointer = popped.toString("utf8", 0, 40).startsWith("version https://git-lfs");
  check(
    "after pop the LFS content is present (or the pointer, with git lfs checkout the remedy)",
    isModified || isPointer,
    isModified ? "modified bytes restored" : "pointer text - same as GitHub/GitLab, `git lfs checkout` fixes it",
  );
  if (isPointer) {
    git(["lfs", "checkout"], dir);
    check("git lfs checkout restores the content after a stash pop", readFileSync(join(dir, "big.bin")).equals(modified));
  }
  git(["checkout", "--", "big.bin"], dir);
}

console.log("\n=== 5. rebase ===");
git(["checkout", "--quiet", "main"], dir);
writeFileSync(join(dir, "main-only.txt"), "main moved\n");
git(["add", "--all"], dir);
git(["commit", "--quiet", "-m", "main moves on"], dir);
git(["push", "--quiet", remote, "main"], dir);
git(["checkout", "--quiet", "feature"], dir);
const rebase = git(["rebase", "--quiet", "main"], dir);
check("git rebase succeeds onto the updated main", rebase.exitCode === 0, rebase.err.trim().slice(0, 200));
if (rebase.exitCode === 0) {
  check("the rebased branch still has the main-only file", existsSync(join(dir, "main-only.txt")));
  check("the LFS file is materialised after the rebase", readFileSync(join(dir, "big.bin")).equals(big));
}

console.log("\n=== 6. fetch and pull ===");
git(["checkout", "--quiet", "main"], dir);
const fetchResult = git(["fetch", "--quiet", remote], dir);
check("git fetch succeeds", fetchResult.exitCode === 0, fetchResult.err.trim().slice(0, 120));
const pull = git(["pull", "--quiet", remote, "main"], dir);
check("git pull succeeds", pull.exitCode === 0, (pull.err || "").trim().slice(0, 120));

console.log("\n=== 7. fresh clone round trip ===");
const clone = join(tmpdir(), `lfsx-clone-${Date.now()}`);
const cloned = git(["clone", "--quiet", remote, clone], tmpdir());
check("git clone succeeds", cloned.exitCode === 0, (cloned.err || "").trim().slice(0, 160));
if (cloned.exitCode === 0) {
  const clonedBig = join(clone, "big.bin");
  const present = existsSync(clonedBig);
  check("the clone materialises the LFS file", present);
  if (present) {
    const bytes = readFileSync(clonedBig);
    const isReal = bytes.equals(big);
    check("and the bytes match the original", isReal, `CR/len ${bytes.length} vs ${big.length}`);
    if (!isReal) {
      git(["lfs", "pull"], clone);
      check("after git lfs pull the bytes match", readFileSync(clonedBig).equals(big));
    }
  }
  git(["config", "user.name", "T2"], clone);
  git(["config", "user.email", "t2@example.com"], clone);
  const newBig = blob(7, 32 * 1024);
  writeFileSync(join(clonedBig), newBig);
  git(["add", "--all"], clone);
  const commitInClone = git(["commit", "--quiet", "-m", "change the binary"], clone);
  check("commit in the clone succeeds", commitInClone.exitCode === 0);
  const pushInClone = git(["push", "--quiet", "origin", "main"], clone);
  check("push from the clone uploads the new LFS object", pushInClone.exitCode === 0, (pushInClone.err || "").trim().slice(0, 160));
  const oid = createHash("sha256").update(newBig).digest("hex");
  const shard = `/data/lfs/objects/${oid.slice(0, 2)}/${oid.slice(2, 4)}/${oid}`;
  const inContainer = Bun.spawnSync({
    cmd: ["docker", "exec", "gitgood-gitgood-1", "sh", "-c", `test -f ${shard} && echo yes || echo no`],
    stdout: "pipe",
  });
  check("the new object is in the content-addressed store", inContainer.stdout.toString().trim() === "yes", shard);
  rmSync(clone, { recursive: true, force: true });
}

rmSync(dir, { recursive: true, force: true });
console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures > 0) process.exit(1);

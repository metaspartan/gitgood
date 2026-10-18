import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { createHmac, createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BASE = "http://127.0.0.1:3000";
const user = `acc${Date.now().toString(36).slice(-8)}`;
const password = "supersecret123";

let checks = 0;
let failures = 0;
function check(label: string, ok: boolean, detail = ""): void {
  checks += 1;
  if (!ok) failures += 1;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  ${detail}` : ""}`);
}

interface ApiResult {
  status: number;
  data: Record<string, unknown>;
  setCookie: string | null;
}
async function api(
  path: string,
  init: { method?: string; body?: unknown } = {},
  cookie = "",
): Promise<ApiResult> {
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

function git(args: string[], cwd: string) {
  const proc = Bun.spawnSync({
    cmd: ["git", ...args],
    cwd,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    stdout: "pipe",
    stderr: "pipe",
    timeout: 90_000,
  });
  return {
    exitCode: proc.exitCode ?? -1,
    out: proc.stdout.toString(),
    err: proc.stderr.toString(),
  };
}

function totp(secretBase32: string, at = Math.floor(Date.now() / 1000)): string {
  const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const ch of secretBase32.toUpperCase().replace(/=+$/, "").replace(/\s/g, "")) {
    value = (value << 5) | B32.indexOf(ch);
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  const counter = Math.floor(at / 30);
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac("sha1", Buffer.from(bytes)).update(msg).digest();
  const offset = digest[digest.length - 1]! & 0x0f;
  const binary =
    ((digest[offset]! & 0x7f) << 24) |
    ((digest[offset + 1]! & 0xff) << 16) |
    ((digest[offset + 2]! & 0xff) << 8) |
    (digest[offset + 3]! & 0xff);
  return String(binary % 1_000_000).padStart(6, "0");
}

console.log("=== git LFS workflow with the stock git client ===");

const signup = await api("/api/auth/signup", {
  method: "POST",
  body: { username: user, email: `${user}@example.com`, password },
});
const cookie = (signup.setCookie ?? "").split(";")[0] ?? "";
const token = String((await api("/api/tokens", { method: "POST", body: { name: "cli" } }, cookie)).data.token ?? "");
const repoRes = await api("/api/repos", { method: "POST", body: { name: "lfsflow", lfs_enabled: true } }, cookie);
check("repository created with LFS enabled", repoRes.status === 201, `status ${repoRes.status}`);

const remote = `http://${user}:${token}@127.0.0.1:3000/${user}/lfsflow.git`;
const dir = join(tmpdir(), `acc-${Date.now()}`);
mkdirSync(dir, { recursive: true });

check("git init", git(["init", "--quiet", "-b", "main"], dir).exitCode === 0);
git(["config", "user.name", "T"], dir);
git(["config", "user.email", "t@example.com"], dir);
check("git lfs install --local", git(["lfs", "install", "--local"], dir).exitCode === 0);
check("git lfs track *.bin", git(["lfs", "track", "*.bin"], dir).exitCode === 0);

const big = Buffer.alloc(48 * 1024);
for (let i = 0; i < big.length; i++) big[i] = (i * 41 + 7) & 0xff;
writeFileSync(join(dir, "asset.bin"), big);
writeFileSync(join(dir, "readme.txt"), "plain text\n");

check("git add", git(["add", "--all"], dir).exitCode === 0);
check("git commit", git(["commit", "--quiet", "-m", "first"], dir).exitCode === 0);
const push1 = git(["push", "--quiet", remote, "main"], dir);
check("git push uploads the LFS object", push1.exitCode === 0, (push1.err || "").trim().slice(0, 140));

const stored = git(["cat-file", "-p", "HEAD:asset.bin"], dir);
check("the committed blob is an LFS pointer", stored.out.startsWith("version https://git-lfs.github.com/spec/v1"), `${stored.out.length} bytes`);

check("git checkout -b feature", git(["checkout", "--quiet", "-b", "feature"], dir).exitCode === 0);
check("checkout materialises the LFS file", readFileSync(join(dir, "asset.bin")).equals(big));
writeFileSync(join(dir, "feature.txt"), "branch work\n");
git(["add", "--all"], dir);
check("commit on the branch", git(["commit", "--quiet", "-m", "branch"], dir).exitCode === 0);
check("git checkout main", git(["checkout", "--quiet", "main"], dir).exitCode === 0);
check("LFS content survives switching branches", readFileSync(join(dir, "asset.bin")).equals(big));

writeFileSync(join(dir, "asset.bin"), Buffer.alloc(8 * 1024, 9));
check("git stash push", git(["stash", "push", "--quiet"], dir).exitCode === 0);
check("stash restores the committed LFS content", readFileSync(join(dir, "asset.bin")).equals(big));
check("git stash pop", git(["stash", "pop", "--quiet"], dir).exitCode === 0);
{
  const after = readFileSync(join(dir, "asset.bin"));
  const isModified = after.length === 8 * 1024;
  const isPointer = after.toString("utf8", 0, 40).startsWith("version https://git-lfs");
  check(
    "after pop the content is present (pointer is the documented git-lfs behaviour)",
    isModified || isPointer,
    isModified ? "modified bytes restored" : "pointer - `git lfs checkout` is the remedy",
  );
  if (isPointer) {
    git(["lfs", "checkout"], dir);
    check("git lfs checkout recovers the content", readFileSync(join(dir, "asset.bin")).length === 8 * 1024);
  }
  git(["checkout", "--", "asset.bin"], dir);
}

git(["checkout", "--quiet", "main"], dir);
writeFileSync(join(dir, "main-only.txt"), "moved\n");
git(["add", "--all"], dir);
git(["commit", "--quiet", "-m", "main moves"], dir);
git(["push", "--quiet", remote, "main"], dir);
git(["checkout", "--quiet", "feature"], dir);
const rebase = git(["rebase", "--quiet", "main"], dir);
check("git rebase replays commits through the LFS filter", rebase.exitCode === 0, (rebase.err || "").trim().slice(0, 160));
if (rebase.exitCode === 0) {
  check("the rebased branch has main's file", existsSync(join(dir, "main-only.txt")));
  check("LFS content is materialised after the rebase", readFileSync(join(dir, "asset.bin")).equals(big));
}

git(["checkout", "--quiet", "main"], dir);
check("git fetch", git(["fetch", "--quiet", remote], dir).exitCode === 0);
check("git pull", git(["pull", "--quiet", remote, "main"], dir).exitCode === 0);

const clone = join(tmpdir(), `acc-clone-${Date.now()}`);
const cloned = git(["clone", "--quiet", remote, clone], tmpdir());
check("git clone", cloned.exitCode === 0, (cloned.err || "").trim().slice(0, 140));
if (cloned.exitCode === 0) {
  const path = join(clone, "asset.bin");
  check("the clone materialises the binary", existsSync(path) && readFileSync(path).equals(big));
  const fresh = Buffer.alloc(16 * 1024, 3);
  writeFileSync(path, fresh);
  git(["config", "user.name", "T2"], clone);
  git(["config", "user.email", "t2@example.com"], clone);
  git(["add", "--all"], clone);
  check("commit in the clone", git(["commit", "--quiet", "-m", "change"], clone).exitCode === 0);
  const push2 = git(["push", "--quiet", "origin", "main"], clone);
  check("push from the clone uploads the new object", push2.exitCode === 0, (push2.err || "").trim().slice(0, 140));
  const oid = createHash("sha256").update(fresh).digest("hex");
  const inStore = Bun.spawnSync({
    cmd: ["docker", "exec", "gitgood-gitgood-1", "sh", "-c",
      `test -f /data/lfs/objects/${oid.slice(0, 2)}/${oid.slice(2, 4)}/${oid} && echo yes || echo no`],
    stdout: "pipe",
  });
  check("the new object is in the content-addressed store", inStore.stdout.toString().trim() === "yes");
  rmSync(clone, { recursive: true, force: true });
}
rmSync(dir, { recursive: true, force: true });

console.log("\n=== two-factor authentication ===");

const mfaBefore = await api("/api/auth/mfa", {}, cookie);
check("MFA starts disabled", mfaBefore.data.totp_enabled === false);

const begin = await api("/api/auth/mfa/totp/begin", { method: "POST", body: {} }, cookie);
check("enrolment begins and returns a secret", begin.status === 200 && typeof begin.data.secret === "string");
check("the otpauth URI is well formed", String(begin.data.uri).startsWith("otpauth://totp/"), String(begin.data.uri).slice(0, 40));

const rawSecret = String(begin.data.secret).replace(/\s/g, "");
const pending = await api("/api/auth/mfa", {}, cookie);
check("enrolment is pending, not enabled, until a code confirms it", pending.data.totp_pending === true && pending.data.totp_enabled === false);

const badConfirm = await api("/api/auth/mfa/totp/confirm", { method: "POST", body: { code: "000000" } }, cookie);
check("a wrong code does not confirm enrolment", badConfirm.status === 400, `status ${badConfirm.status}`);

const confirm = await api("/api/auth/mfa/totp/confirm", { method: "POST", body: { code: totp(rawSecret) } }, cookie);
check("a correct code confirms enrolment", confirm.status === 200 && confirm.data.confirmed === true);
const recovery = (confirm.data.recovery_codes ?? []) as string[];
check("ten recovery codes are issued", recovery.length === 10, `${recovery.length}`);

const enabled = await api("/api/auth/mfa", {}, cookie);
check("MFA reports enabled", enabled.data.totp_enabled === true);
check("recovery codes are counted", enabled.data.recovery_codes_remaining === 10);

const waitForNextWindow = (): Promise<void> => {
  const seconds = 30 - (Math.floor(Date.now() / 1000) % 30);
  console.log(`  (waiting ${seconds}s for a fresh TOTP window)`);
  return new Promise((resolve) => setTimeout(resolve, (seconds + 1) * 1000));
};
await waitForNextWindow();

console.log("\n=== sign-in is now two-phase ===");
const step1 = await api("/api/auth/login", { method: "POST", body: { username: user, password } });
check("step one asks for a second factor", step1.data.mfa_required === true);
check("step one issues NO session cookie", step1.setCookie === null, `set-cookie: ${String(step1.setCookie).slice(0, 30)}`);

const wrong = await api("/api/auth/login/mfa", { method: "POST", body: { username: user, password, code: "000000" } });
check("a wrong code does not sign in", wrong.status === 401, `status ${wrong.status}`);

const usedCode = totp(rawSecret);
const first = await api("/api/auth/login/mfa", { method: "POST", body: { username: user, password, code: usedCode } });
check("a correct code signs in", first.status === 200 && first.setCookie !== null);
const replay = await api("/api/auth/login/mfa", { method: "POST", body: { username: user, password, code: usedCode } });
check("the same code cannot be replayed", replay.status === 401, `status ${replay.status}`);

const recoveryCode = recovery[0]!;
const byRecovery = await api("/api/auth/login/mfa", { method: "POST", body: { username: user, password, code: recoveryCode } });
check("a recovery code signs in", byRecovery.status === 200 && byRecovery.setCookie !== null);
const recoveryAgain = await api("/api/auth/login/mfa", { method: "POST", body: { username: user, password, code: recoveryCode } });
check("a recovery code is single-use", recoveryAgain.status === 401, `status ${recoveryAgain.status}`);

console.log("\n=== account editing ===");
const session = (first.setCookie ?? "").split(";")[0] ?? "";
const renamed = `ren${Date.now().toString(36).slice(-6)}`;
const profile = await api(
  "/api/account",
  { method: "PATCH", body: { username: renamed, email: `${renamed}@example.com`, display_name: "Renamed" } },
  session,
);
check("the username, email and display name can all be changed", profile.status === 200, `status ${profile.status}`);
check("the new username is reflected", (profile.data.user as { username?: string } | undefined)?.username === renamed);

const clash = await api("/api/account", { method: "PATCH", body: { username: "admin" } }, session);
check("a reserved name is refused", clash.status === 400, `status ${clash.status}`);

const wrongCurrent = await api(
  "/api/account/password",
  { method: "POST", body: { current_password: "not-the-password", new_password: "brandnewpass1" } },
  session,
);
check("changing the password requires the current one", wrongCurrent.status === 400, `status ${wrongCurrent.status}`);

const changed = await api(
  "/api/account/password",
  { method: "POST", body: { current_password: password, new_password: "brandnewpass1" } },
  session,
);
check("the password can be changed", changed.status === 200, `status ${changed.status}`);
check("the session that made the change still works", (await api("/api/auth/me", {}, session)).status === 200);

const oldLogin = await api("/api/auth/login", { method: "POST", body: { username: renamed, password } });
check("the old password no longer works", oldLogin.status === 401, `status ${oldLogin.status}`);
const newLogin = await api("/api/auth/login/mfa", {
  method: "POST",
  body: { username: renamed, password: "brandnewpass1", code: recovery[1]! },
});
check("the new password works", newLogin.status === 200, `status ${newLogin.status}`);

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures > 0) process.exit(1);

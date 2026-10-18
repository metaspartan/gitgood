import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BASE = process.env.GITGOOD_TEST_URL ?? "http://127.0.0.1:3000";
const username = `ci${Date.now().toString(36).slice(-8)}`;
const PASSWORD = "supersecret123";

interface CiRunLite {
  id: number;
  status: string;
  exit_code: number | null;
  workflow_name: string;
  job_id: string;
  sha: string;
  ref_name: string;
}

interface RunResult {
  exitCode: number;
  out: string;
  err: string;
}
function execGit(cmd: string[], cwd: string, env: Record<string, string> = {}): RunResult {
  const proc = Bun.spawnSync({ cmd, cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: "0", ...env }, stdout: "pipe", stderr: "pipe" });
  return { exitCode: proc.exitCode ?? -1, out: proc.stdout.toString(), err: proc.stderr.toString() };
}
const git = (args: string[], cwd: string): RunResult => execGit(["git", ...args], cwd);

function pickRun(items: Record<string, unknown>[] | undefined): CiRunLite | null {
  const first = items && items.length > 0 ? items[0] : undefined;
  if (!first) return null;
  return {
    id: Number(first.id),
    status: String(first.status),
    exit_code: first.exit_code == null ? null : Number(first.exit_code),
    workflow_name: String(first.workflow_name ?? ""),
    job_id: String(first.job_id ?? ""),
    sha: String(first.sha ?? ""),
    ref_name: String(first.ref_name ?? ""),
  };
}

interface ApiResult {
  status: number;
  data: Record<string, unknown> & {
    items?: Record<string, unknown>[];
    token?: string;
  };
  setCookie: string | null;
}
async function api(path: string, init: { method?: string; body?: unknown } = {}, cookie = ""): Promise<ApiResult> {
  const headers = new Headers();
  if (cookie) headers.set("cookie", cookie);
  let body: string | undefined;
  if (init.body !== undefined) { body = JSON.stringify(init.body); headers.set("content-type", "application/json"); }
  const res = await fetch(BASE + path, { method: init.method ?? "GET", headers, ...(body ? { body } : {}), signal: AbortSignal.timeout(15000) });
  const text = await res.text();
  let data: ApiResult["data"] = {};
  try { data = JSON.parse(text) as ApiResult["data"]; } catch { data = { raw: text } as unknown as ApiResult["data"]; }
  return { status: res.status, data, setCookie: res.headers.get("set-cookie") };
}

const signup = await api("/api/auth/signup", { method: "POST", body: { username, email: `${username}@example.com`, password: PASSWORD } });
const cookie = (signup.setCookie ?? "").split(";")[0] ?? "";
const tok = await api("/api/tokens", { method: "POST", body: { name: "ci" } }, cookie);
const token = String(tok.data.token ?? "");
const repoRes = await api("/api/repos", { method: "POST", body: { name: "actions", lfs_enabled: true } }, cookie);
console.log(`signup ${signup.status} token(${token.length}) repo ${repoRes.status}`);

const dir = join(tmpdir(), `gg-ci-work-${Date.now()}`);
mkdirSync(dir, { recursive: true });
git(["init", "--quiet", "-b", "main"], dir);
git(["config", "user.name", "T"], dir);
git(["config", "user.email", "t@example.com"], dir);
const workflow = `on: push\nname: Check\njobs:\n  build:\n    runs-on: ubuntu-latest\n    steps:\n      - name: Write a file\n        run: echo "hello from ci" > out.txt\n      - name: Verify it\n        run: test -f out.txt && echo "PASS" && exit 0\n`;
writeFileSync(join(dir, ".gitgood-ci.yml"), workflow);
writeFileSync(join(dir, "app.txt"), "hello\n");
git(["add", "--all"], dir);
git(["commit", "--quiet", "-m", "add ci workflow"], dir);
const remote = new URL(`${BASE}/${username}/actions.git`);
remote.username = username; remote.password = token;
const push = git(["push", "--no-thin", remote.href, "main"], dir);
console.log("push:", push.exitCode, push.err.trim().slice(0, 100));
if (push.exitCode !== 0) { rmSync(dir, { recursive: true, force: true }); process.exit(1); }

let run: CiRunLite | null = null;
for (let i = 0; i < 40; i++) {
  await new Promise((r) => setTimeout(r, 600));
  const r = await api(`/api/repos/${username}/actions/ci/runs`, {}, cookie);
  const first = pickRun(r.data.items);
  if (first) { run = first; if (first.status !== "queued" && first.status !== "running") break; }
}
if (!run) { console.log("NO RUN FOUND"); rmSync(dir, { recursive: true, force: true }); process.exit(1); }
console.log(`run #${run.id} ${run.workflow_name}/${run.job_id} ${run.status} exit=${run.exit_code}`);

const logRes = await api(`/api/repos/${username}/actions/ci/runs/${run.id}/log`, {}, cookie);
const lines = (logRes.data.items ?? []).map((l) => String(l.text));
console.log("log lines:", lines.length);
console.log(lines.slice(0, 10).join("\n") || "(empty)");

rmSync(dir, { recursive: true, force: true });
const ok = run.status === "success" && run.exit_code === 0;
console.log("\nVERDICT:", ok ? "SUCCESS RUN" : "RUN NOT SUCCESS");
if (!ok) process.exit(1);

import { spawnSync } from "node:child_process";

const CONTAINER = "gitgood-bootstrap-check";
const PORT = "3999";
let checks = 0;
let failures = 0;
function check(label: string, ok: boolean, detail = ""): void {
  checks += 1;
  if (!ok) failures += 1;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  ${detail}` : ""}`);
}

function sh(cmd: string[]): { code: number; out: string } {
  const r = spawnSync(cmd[0]!, cmd.slice(1), { encoding: "utf8" });
  return { code: r.status ?? -1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

sh(["docker", "rm", "-f", CONTAINER]);
sh(["docker", "volume", "rm", "-f", `${CONTAINER}-data`]);

console.log("=== a fresh instance with an empty volume ===");
const run = sh([
  "docker", "run", "-d",
  "--name", CONTAINER,
  "-p", `${PORT}:3000`,
  "-e", "GITGOOD_BASE_URL=http://127.0.0.1:" + PORT,
  "-e", "GITGOOD_ADMIN_USERNAME=bootstrapadmin",
  "-e", "GITGOOD_ADMIN_EMAIL=bootstrap@example.com",
  "-v", `${CONTAINER}-data:/data`,
  "gitgood:1.0.0",
]);
check("the container starts", run.code === 0, run.out.slice(0, 160));

let ready = false;
for (let i = 0; i < 40; i++) {
  await new Promise((r) => setTimeout(r, 500));
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/api/health`, { signal: AbortSignal.timeout(2000) });
    if (res.ok) {
      ready = true;
      break;
    }
  } catch {
  }
}
check("the instance answers on /api/health", ready);

const logs = sh(["docker", "logs", CONTAINER]).out;
check("it logged the administrator it created", logs.includes("created the initial administrator account"), logs.slice(0, 0));
check("the log names the bootstrap username", logs.includes("bootstrapadmin"));

const m = /"password":"([^"]+)"/.exec(logs);
const generated = m?.[1] ?? null;
check("a password was generated (none was supplied)", generated !== null && generated !== "(from GITGOOD_ADMIN_PASSWORD)", generated ? `${generated.length} chars` : "none");
check("the generated password is not a fixed default", generated !== "admin" && generated !== "password" && (generated?.length ?? 0) >= 12);

if (generated) {
  const login = await fetch(`http://127.0.0.1:${PORT}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "bootstrapadmin", password: generated }),
    signal: AbortSignal.timeout(5000),
  });
  check("the printed password signs in", login.status === 200, `status ${login.status}`);
  const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  const me = await fetch(`http://127.0.0.1:${PORT}/api/auth/me`, {
    headers: { cookie },
    signal: AbortSignal.timeout(5000),
  });
  const body = (await me.json()) as { user?: { username?: string; is_admin?: boolean } };
  check("the account is the administrator", body.user?.is_admin === true, body.user?.username);

  const account = await fetch(`http://127.0.0.1:${PORT}/api/account`, {
    headers: { cookie },
    signal: AbortSignal.timeout(5000),
  });
  const acc = (await account.json()) as { bootstrap_pending?: boolean };
  check("the instance reports the default credentials as still in use", acc.bootstrap_pending === true);
}

sh(["docker", "restart", CONTAINER]);
await new Promise((r) => setTimeout(r, 6000));
const logs2 = sh(["docker", "logs", CONTAINER]).out;
const creations = (logs2.match(/created the initial administrator account/g) ?? []).length;
check("a restart does not create another administrator", creations === 1, `${creations} creations`);

sh(["docker", "rm", "-f", CONTAINER]);
sh(["docker", "volume", "rm", "-f", `${CONTAINER}-data`]);
console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures > 0) process.exit(1);

import { migrate } from "../src/db/index.ts";
import { findKeyByFingerprint } from "../src/ssh/keys.ts";
import { canRead, canWrite, findRepo, repoDiskPath } from "../src/data/repos.ts";
import { findUserById, type Auth, type Principal } from "../src/auth/service.ts";
import { normalizeRepoName } from "../src/git/repo.ts";
import { REPO_NAME_PATTERN, USERNAME_PATTERN } from "../src/lib/ids.ts";
import { gitStream } from "../src/git/run.ts";
import { receivePackEnforcement } from "../src/git/branch-protection-hook.ts";
import { userHasInstanceAdmin } from "../src/ssh/identity.ts";

function refuse(message: string, code = 1): never {
  process.stderr.write(`gitgood: ${message}\n`);
  process.exit(code);
}

export function parseGitCommand(
  command: string,
): { service: "git-upload-pack" | "git-receive-pack"; owner: string; name: string } | null {
  const match = /^(?:git[ -])?(upload-pack|receive-pack)\s+(.+)$/.exec(command.trim());
  if (!match) return null;
  const [, rawService, rawPath] = match;
  if (!rawService || !rawPath) return null;
  const service = rawService === "receive-pack" ? "git-receive-pack" : "git-upload-pack";

  const cleaned = rawPath.trim().replace(/^['"]|['"]$/g, "").trim();
  if (cleaned.length === 0) return null;

  const withoutPrefix = cleaned.replace(/^~?\/?/, "");
  const parts = withoutPrefix.split("/").filter(Boolean);
  if (parts.length !== 2) return null;
  const [owner, repoPart] = parts;
  if (!owner || !repoPart) return null;

  if (!USERNAME_PATTERN.test(owner)) return null;
  const name = normalizeRepoName(repoPart);
  if (!REPO_NAME_PATTERN.test(name)) return null;

  return { service, owner, name };
}

export function principalForKey(fingerprint: string | undefined): Principal {
  const value = fingerprint?.trim();
  if (!value) {
    refuse(
      "This connection did not identify a key. Re-install authorized_keys with\n" +
        "`bun tools/ssh-authorized-keys.ts`, which adds the required environment line.",
    );
  }
  const key = findKeyByFingerprint(value);
  if (!key) {
    refuse(
      `Key ${value} is not registered for any account. If it was removed, add it again in Settings.`,
    );
  }
  const user = findUserById(key.user_id);
  if (!user) refuse("The account for this key no longer exists.");
  return {
    kind: "user",
    userId: user.id,
    username: user.username,
    isAdmin: user.is_admin === 1,
    scopes: ["read", "write", "admin"],
    via: "session",
  };
}

async function execGit(
  service: "git-upload-pack" | "git-receive-pack",
  repoPath: string,
  repoId: number,
): Promise<never> {
  const subcommand = service === "git-receive-pack" ? "receive-pack" : "upload-pack";
  const enforcement =
    service === "git-receive-pack" ? receivePackEnforcement(repoId) : { configArgs: [] as const, env: {}, cleanup: () => {} };
  const proc = await gitStream([...enforcement.configArgs, subcommand, repoPath], {
    stdin: Bun.stdin.stream(),
    gitProtocol: process.env["GIT_PROTOCOL"],
    env: enforcement.env,
  }).catch(error => { enforcement.cleanup(); throw error; });

  const writer = Bun.stdout.writer();
  const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      writer.write(value);
      writer.flush();
    }
  }
  writer.end();

  const stderr = await proc.stderr();
  if (stderr.length > 0) process.stderr.write(stderr);
  const code = await proc.exited.finally(enforcement.cleanup);
  process.exit(code === 0 ? 0 : 1);
}

async function main(): Promise<number> {
  migrate();

  const original = process.env["SSH_ORIGINAL_COMMAND"] ?? "";
  if (original.trim().length === 0) {
    refuse(
      "This account serves git only. Use `git clone git@host:owner/repo.git`.\n" +
        "There is no shell here.",
    );
  }

  const parsed = parseGitCommand(original);
  if (!parsed) {
    refuse(
      `Unsupported command: ${original.split(/\s+/).slice(0, 2).join(" ")}\n` +
        "Only git-upload-pack and git-receive-pack are available.",
    );
  }

  const principal = principalForKey(process.env["GITGOOD_SSH_FINGERPRINT"]);

  const repo = findRepo(parsed.owner, parsed.name);
  if (!repo) {
    refuse(`Repository ${parsed.owner}/${parsed.name} not found.`);
  }

  const auth: Auth = principal;
  if (parsed.service === "git-receive-pack") {
    if (!canWrite(repo, auth)) {
      refuse(`You do not have write access to ${parsed.owner}/${parsed.name}.`);
    }
  } else if (!canRead(repo, auth)) {
    refuse(`Repository ${parsed.owner}/${parsed.name} not found.`);
  }

  const repoPath = repoDiskPath(repo);
  await execGit(parsed.service, repoPath, repo.id);
  return 0;
}

if (import.meta.main) {
  process.exit(await main());
}

export { userHasInstanceAdmin };

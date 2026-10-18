import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { config } from "../config.ts";
import { protectedBranchNames, renderPreReceiveHook } from "../data/branch-protection.ts";

export interface ReceivePackEnforcement {
  configArgs: readonly string[];
  env: Record<string, string>;
  cleanup: () => void;
}

export function trustedHooksDirectory(): string {
  return resolve(config.dataDir, "receive-hooks");
}

export function receivePackEnforcement(repoId: number): ReceivePackEnforcement {
  const branches = protectedBranchNames(repoId);
  if (!branches.length) return { configArgs: [], env: {}, cleanup: () => {} };
  const root = trustedHooksDirectory();
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const dir = mkdtempSync(join(root, "push-"));
  const cleanup = () => rmSync(dir, { recursive: true, force: true });
  try {
    const path = join(dir, "pre-receive");
    writeFileSync(path, renderPreReceiveHook(branches), { encoding: "utf8", mode: 0o700 });
    if (process.platform !== "win32") chmodSync(path, 0o700);
    return {
      configArgs: ["-c", `core.hooksPath=${dir.replaceAll("\\", "/")}`],
      env: { GITGOOD_PROTECTED_REFS: branches.map(branch => `refs/heads/${branch}`).join("\n") },
      cleanup,
    };
  } catch (cause) { cleanup(); throw cause; }
}

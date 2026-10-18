import { config } from "../config.ts";

export type CiRunnerMode = "disabled" | "trusted-host" | "runner";

export interface CiRunnerStatus {
  mode: CiRunnerMode;
  enabled: boolean;
  isolation: "none" | "external";
  notice: string;
}

const ALLOWED_ENV = [
  "PATH",
  "PATHEXT",
  "SYSTEMROOT",
  "WINDIR",
  "COMSPEC",
  "TEMP",
  "TMP",
  "TMPDIR",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TZ",
  "TERM",
  "SHELL",
  "USER",
  "LOGNAME",
  "CI",
  "GITGOOD_CI",
] as const;

export function resolveCiMode(env: Record<string, string | undefined> = Bun.env, nodeEnv = config.env): CiRunnerMode {
  const raw = env.GITGOOD_CI_MODE?.trim().toLowerCase() ?? "";
  if (raw === "disabled" || raw === "trusted-host" || raw === "runner") return raw;
  if (raw !== "") return "disabled";
  return nodeEnv === "production" ? "runner" : "trusted-host";
}

export function ciRunnerStatus(
  env: Record<string, string | undefined> = Bun.env,
  nodeEnv = config.env,
): CiRunnerStatus {
  const mode = resolveCiMode(env, nodeEnv);
  if (mode === "runner") {
    return {
      mode,
      enabled: true,
      isolation: "external",
      notice:
        "Jobs are queued and executed by registered GitGood runners, never by this server. Register a runner under Admin \u2192 Runners; each job runs in a fresh container on the runner host.",
    };
  }
  if (mode === "disabled") {
    return {
      mode,
      enabled: false,
      isolation: "none",
      notice:
        "CI is disabled. Set GITGOOD_CI_MODE=trusted-host only on a host you trust to run repository shell commands. This is not a sandbox.",
    };
  }
  return {
    mode,
    enabled: true,
    isolation: "none",
    notice:
      "CI runs on this host with no sandbox isolation. Job steps are shell commands with the repository checkout and a scrubbed environment, not a contained runner.",
  };
}

export function ciEnabled(
  env: Record<string, string | undefined> = Bun.env,
  nodeEnv = config.env,
): boolean {
  return resolveCiMode(env, nodeEnv) !== "disabled";
}

export function ciUsesRunners(
  env: Record<string, string | undefined> = Bun.env,
  nodeEnv = config.env,
): boolean {
  return resolveCiMode(env, nodeEnv) === "runner";
}

export function ciExecutionAllowed(
  env: Record<string, string | undefined> = Bun.env,
  nodeEnv = config.env,
): boolean {
  return resolveCiMode(env, nodeEnv) === "trusted-host";
}

export function childJobEnv(workdir: string, source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {
    CI: "true",
    GITGOOD_CI: "1",
    HOME: workdir,
    USERPROFILE: workdir,
    PWD: workdir,
  };
  for (const key of ALLOWED_ENV) {
    const value = source[key];
    if (value !== undefined && value !== "") env[key] = value;
  }
  return env;
}

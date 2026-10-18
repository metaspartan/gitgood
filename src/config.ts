function env(key: string, fallback: string): string {
  const value = Bun.env[key];
  return value === undefined || value === "" ? fallback : value;
}

function envInt(key: string, fallback: number): number {
  const raw = Bun.env[key];
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function envBool(key: string, fallback: boolean): boolean {
  const raw = Bun.env[key];
  if (raw === undefined || raw === "") return fallback;
  return raw === "1" || raw.toLowerCase() === "true" || raw.toLowerCase() === "yes";
}

const dataDir = env("GITGOOD_DATA_DIR", "./data");

export const config = {
  env: env("NODE_ENV", "development"),
  host: env("GITGOOD_HOST", "0.0.0.0"),
  port: envInt("GITGOOD_PORT", 3000),

  dataDir,
  dbPath: env("GITGOOD_DB_PATH", `${dataDir}/gitgood.db`),
  repoRoot: env("GITGOOD_REPO_ROOT", `${dataDir}/repositories`),
  lfsRoot: env("GITGOOD_LFS_ROOT", `${dataDir}/lfs`),

  baseUrl: env("GITGOOD_BASE_URL", `http://localhost:${envInt("GITGOOD_PORT", 3000)}`),

  sessionTtlSeconds: envInt("GITGOOD_SESSION_TTL", 60 * 60 * 24 * 30),

  maxJsonBodyBytes: envInt("GITGOOD_MAX_JSON_BODY", 2 * 1024 * 1024),

  maxLfsObjectBytes: envInt("GITGOOD_MAX_LFS_BYTES", 5 * 1024 * 1024 * 1024),

  rateLimitWindowMs: envInt("GITGOOD_RATE_WINDOW_MS", 60_000),
  rateLimitMax: envInt("GITGOOD_RATE_MAX", 600),
  authRateLimitMax: envInt("GITGOOD_AUTH_RATE_MAX", 30),

  allowSignup: envBool("GITGOOD_ALLOW_SIGNUP", true),

  trustProxy: envBool("GITGOOD_TRUST_PROXY", false),

  gitConcurrency: envInt("GITGOOD_GIT_CONCURRENCY", 16),

  maxRepoBytes: envInt("GITGOOD_MAX_REPO_BYTES", 0),

  allowRepoCreation: envBool("GITGOOD_ALLOW_REPO_CREATION", true),

  codeIndexMaxFiles: envInt("GITGOOD_CODE_INDEX_MAX_FILES", 2000),
  codeIndexMaxFileBytes: envInt("GITGOOD_CODE_INDEX_MAX_FILE_BYTES", 256 * 1024),
  codeIndexMaxTotalBytes: envInt("GITGOOD_CODE_INDEX_MAX_TOTAL_BYTES", 32 * 1024 * 1024),

  sshCommand: env("GITGOOD_SSH_COMMAND", ""),
  get webhookAllowPrivate(): boolean {
    return envBool("GITGOOD_WEBHOOK_ALLOW_PRIVATE", false);
  },
  sshPort: envInt("GITGOOD_SSH_PORT", 22),

  denyNonFastForwards: envBool("GITGOOD_DENY_NON_FAST_FORWARDS", false),
  denyDeletes: envBool("GITGOOD_DENY_DELETES", false),
  fsckObjects: envBool("GITGOOD_FSCK_OBJECTS", true),

  dbMaintenanceIntervalMs: envInt("GITGOOD_DB_MAINTENANCE_MS", 60 * 60 * 1000),

  serveWeb: envBool("GITGOOD_SERVE_WEB", true),

  webDist: env("GITGOOD_WEB_DIST", "./dist/web"),

  logLevel: env("GITGOOD_LOG_LEVEL", "info"),
} as const;

export type Config = typeof config;

export const isProduction = config.env === "production";

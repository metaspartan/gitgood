import { failInterruptedRuns } from "./ci/store.ts";
import { backfillLfsUsage } from "./lfs/usage.ts";
import { shellThemeFor, themedShell } from "./web/theme-shell.ts";
import { config } from "./config.ts";
import { changes, migrate } from "./db/index.ts";
import { startDatabaseMaintenance, stopDatabaseMaintenance } from "./db/maintenance.ts";
import { buildRouter } from "./api/index.ts";
import { binaryResponse, clientIp, errorResponse, isCrossSiteWrite, isNotModified, json } from "./lib/http.ts";
import { increment, observe, setGauge } from "./lib/metrics.ts";
import { apiRateLimiter, authRateLimiter } from "./lib/rate-limit.ts";
import { formatBytes } from "./lib/format.ts";
import { log } from "./lib/logger.ts";
import { resolveAuth, type Auth } from "./auth/service.ts";
import {
  effectiveQuotaBytes,
  findRepo,
  repoDiskPath,
  touchRepository,
  type RepoRecord,
} from "./data/repos.ts";
import { notifiableOwnerIds, notifyOverQuota, notifyPush } from "./data/notify-events.ts";
import { reindexQuietly } from "./data/code-index.ts";
import { normalizeRepoName } from "./git/repo.ts";
import { advertiseRefs, serviceRpc, type GitService } from "./git/smart-http.ts";
import { handleLfsRequest } from "./lfs/routes.ts";
import { dispatchWebhooks } from "./data/webhooks.ts";
import * as gitRepo from "./git/repo.ts";
import { invalidateRepo } from "./data/git-reads.ts";
import { maybeTriggerCi } from "./ci/trigger.ts";
import { bootstrapAdmin } from "./auth/bootstrap.ts";
import { acceptsGzip, assetFor, preloadWebBundle, webBundle } from "./web/assets.ts";

migrate();

void bootstrapAdmin()
  .then((created) => {
    if (!created) return;
    log.warn("created the initial administrator account", {
      username: created.username,
      email: created.email,
      password: created.generatedPassword ?? "(from GITGOOD_ADMIN_PASSWORD)",
      next: "sign in, then change the username, email and password under Settings",
    });
  })
  .catch((error: unknown) => {
    log.error("administrator bootstrap failed", {
      reason: error instanceof Error ? error.message : String(error),
    });
  });

const router = buildRouter();

if (config.serveWeb) {
  void preloadWebBundle().catch((error: unknown) => {
    log.error("web bundle preload failed", {
      reason: error instanceof Error ? error.message : String(error),
    });
  });
}

type GitRoute =
  | { kind: "advertise"; service: GitService; owner: string; name: string }
  | { kind: "rpc"; service: GitService; owner: string; name: string }
  | { kind: "lfs"; owner: string; name: string; segments: string[] };

function matchGitRoute(pathname: string): GitRoute | null {
  if (pathname.length < 2 || pathname.startsWith("/api/")) return null;
  const parts = pathname.slice(1).split("/");
  if (parts.length < 3) return null;
  const owner = parts[0];
  const repoPart = parts[1];
  if (!owner || !repoPart) return null;
  const name = normalizeRepoName(repoPart);
  const rest = parts.slice(2).join("/");

  if (rest === "info/refs") {
    const service = "git-upload-pack";
    return { kind: "advertise", service, owner, name };
  }
  if (rest === "git-upload-pack") return { kind: "rpc", service: "git-upload-pack", owner, name };
  if (rest === "git-receive-pack") return { kind: "rpc", service: "git-receive-pack", owner, name };
  if (rest === "info/lfs" || rest.startsWith("info/lfs/")) {
    const segments = rest.split("/").slice(2);
    return { kind: "lfs", owner, name, segments };
  }
  return null;
}

function unauthorizedGitResponse(): Response {
  return new Response("Authentication required\n", {
    status: 401,
    headers: {
      "www-authenticate": 'Basic realm="GitGood"',
      "content-type": "text/plain; charset=utf-8",
    },
  });
}

function withAuthChallenge(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("www-authenticate", 'Basic realm="GitGood"');
  return new Response(response.body, { status: response.status, headers });
}

async function handleReceivePack(
  repo: RepoRecord,
  auth: Auth,
  request: Request,
): Promise<Response> {
  const path = repoDiskPath(repo);
  const limit = effectiveQuotaBytes(repo);

  if (Number.isFinite(limit)) {
    const declared = Number(request.headers.get("content-length") ?? "0");
    const size = await gitRepo.repoSize(path);
    if (size.bytes >= limit) {
      increment("git_pushes_rejected_total");
      return new Response(
        `Repository is over its storage limit (${formatBytes(size.bytes)} of ${formatBytes(limit)}).\n` +
          "Run `git gc` on the server or raise the limit, then push again.\n",
        { status: 413, headers: { "content-type": "text/plain; charset=utf-8" } },
      );
    }
    if (declared > 0 && size.bytes + declared > limit) {
      increment("git_pushes_rejected_total");
      return new Response(
        `This push would take the repository over its storage limit ` +
          `(${formatBytes(size.bytes)} + ${formatBytes(declared)} > ${formatBytes(limit)}).\n`,
        { status: 413, headers: { "content-type": "text/plain; charset=utf-8" } },
      );
    }
  }

  const before = await gitRepo.refSnapshot(path);

  const response = await serviceRpc(repo, auth, "git-receive-pack", request, async (exitCode) => {
    if (exitCode !== 0) return;
    const after = await gitRepo.refSnapshot(path);
    const changes: Array<{ ref: string; before: string | null; after: string | null }> = [];
    for (const [ref, sha] of after.refs) {
      const previous = before.refs.get(ref) ?? null;
      if (previous !== sha) changes.push({ ref, before: previous, after: sha });
    }
    for (const ref of before.refs.keys()) {
      if (!after.refs.has(ref)) changes.push({ ref, before: before.refs.get(ref) ?? null, after: null });
    }
    if (changes.length === 0) return;
    touchRepository(repo.id);
    invalidateRepo(repo.id);
    increment("git_pushes_total");
    dispatchWebhooks(repo.id, {
      event: "push",
      payload: {
        ref: changes[0]?.ref ?? null,
        changes,
        pusher: auth.kind === "user" ? { username: auth.username } : null,
        repository: { full_name: `${repo.owner_username}/${repo.name}` },
      },
    });

    const pusher = auth.kind === "user" ? auth : null;
    try {
      notifyPush(repo, pusher, changes.length);
    } catch (error) {
      log.warn("push notification failed", {
        repo: `${repo.owner_username}/${repo.name}`,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    const fresh = findRepo(repo.owner_username, repo.name) ?? repo;
    await enforceQuotaAfterPush(fresh);
    void reindexQuietly(fresh, "push");
    void maybeTriggerCi(fresh, changes);
  });
  return response;
}

async function enforceQuotaAfterPush(repo: RepoRecord): Promise<void> {
  const limit = effectiveQuotaBytes(repo);
  if (!Number.isFinite(limit)) return;
  try {
    const size = await gitRepo.repoSize(repoDiskPath(repo));
    const over = size.bytes > limit;
    if (over && repo.over_quota_at === null) {
      changes("UPDATE repos SET over_quota_at = ? WHERE id = ?", Date.now(), repo.id);
      increment("repos_over_quota_total");
      for (const ownerId of notifiableOwnerIds(repo)) {
        notifyOverQuota(repo, ownerId, size.bytes, limit);
      }
      log.warn("repository is over its storage limit", {
        repo: `${repo.owner_username}/${repo.name}`,
        used: size.bytes,
        limit,
      });
    } else if (!over && repo.over_quota_at !== null) {
      changes("UPDATE repos SET over_quota_at = NULL WHERE id = ?", repo.id);
    }
  } catch (error) {
    log.warn("quota check failed", {
      repo: `${repo.owner_username}/${repo.name}`,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

async function handleGit(route: GitRoute, request: Request, auth: Auth): Promise<Response> {
  const repo = findRepo(route.owner, route.name);
  if (!repo) return new Response("Repository not found\n", { status: 404 });

  if (route.kind === "advertise") {
    const serviceParam = new URL(request.url).searchParams.get("service");
    const service: GitService =
      serviceParam === "git-receive-pack" ? "git-receive-pack" : "git-upload-pack";
    return advertiseRefs(repo, auth, service, request);
  }
  if (route.kind === "rpc") {
    if (request.method !== "POST") return new Response("Method not allowed\n", { status: 405 });
    if (route.service === "git-receive-pack") return handleReceivePack(repo, auth, request);
    return serviceRpc(repo, auth, route.service, request);
  }
  return handleLfsRequest(request, repo, auth, route.segments, new URL(request.url));
}

async function handleApi(request: Request, auth: Auth, ip: string): Promise<Response> {
  const url = new URL(request.url);
  const matched = router.match(request.method, url.pathname);
  if (!matched) {
    if (router.hasPath(url.pathname)) {
      return json({ error: { code: "bad_request", message: "Method not allowed" } }, { status: 405 });
    }
    return json({ error: { code: "not_found", message: "No such endpoint" } }, { status: 404 });
  }
  return matched.handler({ request, url, params: matched.params, auth, ip });
}

async function handleRequest(request: Request, server: Bun.Server<unknown>): Promise<Response> {
  const started = performance.now();
  const ip = clientIp(request, server);
  let status = 500;

  try {
    const url = new URL(request.url);
    let pathname: string;
    try {
      pathname = decodeURIComponent(url.pathname);
    } catch {
      pathname = url.pathname;
    }

    const authPromise = resolveAuth(request);

    if (pathname.startsWith("/api/")) {
      const auth = await authPromise;
      const isAuthPath = pathname.startsWith("/api/auth/");
      const isMutation = request.method !== "GET" && request.method !== "HEAD";
      if (isCrossSiteWrite(request, url)) {
        status = 403;
        return json({ error: { code: "forbidden", message: "Cross-site request refused" } }, { status: 403 });
      }
      if (isAuthPath || isMutation) {
        const limiter = isAuthPath ? authRateLimiter : apiRateLimiter;
        const key = `${ip}:${request.method}`;
        if (!limiter.check(key)) {
          status = 429;
          increment("rate_limited_total");
          const waitSeconds = Math.max(1, Math.ceil(limiter.retryAfterMs(key) / 1000));
          return json(
            {
              error: {
                code: "rate_limited",
                message: "Too many requests",
                details: { retry_after_seconds: waitSeconds },
              },
            },
            { status: 429, headers: { "retry-after": String(waitSeconds) } },
          );
        }
      }
      const response = await handleApi(request, auth, ip);
      status = response.status;
      return response;
    }

    const gitRoute = matchGitRoute(pathname);
    if (gitRoute) {
      const auth = await authPromise;
      increment(gitRoute.kind === "rpc" ? "git_rpc_requests_total" : "git_requests_total");
      const response = await handleGit(gitRoute, request, auth);
      status = response.status;
      if (status === 401) {
        if (gitRoute.kind === "lfs") return withAuthChallenge(response);
        return unauthorizedGitResponse();
      }
      return response;
    }

    if (config.serveWeb && (request.method === "GET" || request.method === "HEAD")) {
      const bundle = await webBundle();

      const asset = assetFor(bundle, pathname);
      if (asset) {
        const gzip = acceptsGzip(request) ? asset.gzipped : null;
        const etag = gzip ? (asset.gzipEtag ?? asset.etag) : asset.etag;
        if (isNotModified(request, etag)) {
          status = 304;
          return binaryResponse(new Uint8Array(0), { etag, vary: "accept-encoding" }, 304);
        }
        status = 200;
        const body = gzip ?? asset.body;
        return binaryResponse(body, {
          "content-type": asset.contentType,
          "content-length": String(body.byteLength),
          ...(gzip ? { "content-encoding": "gzip" } : {}),
          etag,
          vary: "accept-encoding",
          "cache-control": "public, max-age=31536000, immutable",
          "x-content-type-options": "nosniff",
        });
      }

      const shell = themedShell(bundle.indexHtml, shellThemeFor(request));
      const indexGzip = acceptsGzip(request) ? shell.gzip : null;
      if (isNotModified(request, shell.etag)) {
        status = 304;
        return binaryResponse(new Uint8Array(0), { etag: shell.etag, vary: "accept-encoding, cookie" }, 304);
      }
      status = 200;
      const indexBody = indexGzip ?? shell.html;
      return binaryResponse(indexBody, {
        "content-type": "text/html; charset=utf-8",
        "content-length": String(indexBody.byteLength),
        ...(indexGzip ? { "content-encoding": "gzip" } : {}),
        etag: shell.etag,
        vary: "accept-encoding, cookie",
        "cache-control": "no-cache",
      });
    }

    status = 404;
    return json({ error: { code: "not_found", message: "Not found" } }, { status: 404 });
  } catch (error) {
    const response = errorResponse(error, request);
    status = response.status;
    if (status >= 500) {
      log.error("request failed", {
        method: request.method,
        path: new URL(request.url).pathname,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
    return response;
  } finally {
    const elapsed = performance.now() - started;
    observe("http_request_ms", elapsed);
    increment("http_requests_total");
    setGauge("http_last_ms", Math.round(elapsed * 1000) / 1000);
    if (status >= 400) increment(`http_status_${status}_total`);
  }
}

export function createServer(port: number = config.port): Bun.Server<unknown> {
  const instance = Bun.serve({
    hostname: config.host,
    port,
    development: config.env !== "production",
    maxRequestBodySize: Math.max(config.maxLfsObjectBytes, 64 * 1024 * 1024),
    fetch: handleRequest,
    error: (error: Error) => errorResponse(error),
  });
  startDatabaseMaintenance();
  log.info("gitgood listening", {
    url: `http://${config.host}:${instance.port}`,
    env: config.env,
    dataDir: config.dataDir,
    routes: router.size,
  });
  return instance;
}

if (import.meta.main) {
  failInterruptedRuns();
  const server = createServer();
  setTimeout(() => void backfillLfsUsage(), 15_000);
  const shutdown = async (signal: string): Promise<void> => {
    log.info("shutting down", { signal });
    stopDatabaseMaintenance();
    await server.stop(true);
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

export { handleRequest };

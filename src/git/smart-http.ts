import { gitStream } from "./run.ts";
import { forbidden, unauthorized } from "../lib/errors.ts";
import { binaryResponse } from "../lib/http.ts";
import { log } from "../lib/logger.ts";
import type { Auth } from "../auth/service.ts";
import { canRead, canWrite, repoDiskPath, type RepoRecord } from "../data/repos.ts";
import { receivePackEnforcement } from "./branch-protection-hook.ts";

export type GitService = "git-upload-pack" | "git-receive-pack";

function subcommand(service: GitService): string {
  return service === "git-receive-pack" ? "receive-pack" : "upload-pack";
}

const encoder = new TextEncoder();

export function pktLine(text: string): Uint8Array {
  const payload = encoder.encode(text);
  const length = (payload.length + 4).toString(16).padStart(4, "0");
  const framed = new Uint8Array(4 + payload.length);
  framed.set(encoder.encode(length), 0);
  framed.set(payload, 4);
  return framed;
}

function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

function decodeRequestBody(request: Request): ReadableStream<Uint8Array> | undefined {
  const body = request.body;
  if (!body) return undefined;
  const encoding = (request.headers.get("content-encoding") ?? "").toLowerCase();
  if (encoding === "gzip" || encoding === "x-gzip") {
    return body.pipeThrough(new DecompressionStream("gzip"));
  }
  if (encoding === "deflate") {
    return body.pipeThrough(new DecompressionStream("deflate"));
  }
  return body;
}

function noCacheHeaders(extra: Record<string, string>): Record<string, string> {
  return {
    "cache-control": "no-cache, max-age=0, must-revalidate",
    expires: "Fri, 01 Jan 1980 00:00:00 GMT",
    pragma: "no-cache",
    ...extra,
  };
}

function gitProtocolHeader(request: Request): string | undefined {
  return request.headers.get("git-protocol") ?? undefined;
}

function assertCanRead(repo: RepoRecord, auth: Auth): void {
  if (canRead(repo, auth)) return;
  if (auth.kind === "anonymous") {
    throw unauthorized("Authentication required for this repository");
  }
  throw forbidden();
}

function assertCanWrite(repo: RepoRecord, auth: Auth): void {
  if (auth.kind === "anonymous") {
    throw unauthorized("Authentication required to push");
  }
  if (!canWrite(repo, auth)) throw forbidden("You do not have push access to this repository");
  if (repo.archived === 1) throw forbidden("This repository is archived and read-only");
}

export interface InfoRefsResult {
  response: Response;
  finished: Promise<{ exitCode: number; stderr: string }>;
}

export async function advertiseRefs(
  repo: RepoRecord,
  auth: Auth,
  service: GitService,
  request: Request,
): Promise<Response> {
  if (service === "git-receive-pack") assertCanWrite(repo, auth);
  else assertCanRead(repo, auth);

  const path = repoDiskPath(repo);
  const proc = await gitStream(
    [subcommand(service), "--stateless-rpc", "--advertise-refs", path],
    { gitProtocol: gitProtocolHeader(request) },
  );
  const advertised = await new Response(proc.stdout).arrayBuffer();
  const exitCode = await proc.exited;

  if (exitCode !== 0) {
    const stderr = await proc.stderr();
    return new Response(`git ${service} failed: ${stderr}`, { status: 500 });
  }

  const header = concatBytes(
    pktLine(`# service=${service}\n`),
    encoder.encode("0000"),
  );
  const body = concatBytes(header, new Uint8Array(advertised));

  return binaryResponse(
    body,
    noCacheHeaders({
      "content-type": `application/x-${service}-advertisement`,
      "content-length": String(body.byteLength),
    }),
  );
}

export interface RpcResult {
  response: Response;
  finished: Promise<{ exitCode: number; stderr: string }>;
}

export type CompletionCallback = (exitCode: number, stderr: string) => void | Promise<void>;

export async function serviceRpc(
  repo: RepoRecord,
  auth: Auth,
  service: GitService,
  request: Request,
  onComplete?: CompletionCallback,
): Promise<Response> {
  if (service === "git-receive-pack") assertCanWrite(repo, auth);
  else assertCanRead(repo, auth);

  const path = repoDiskPath(repo);
  const stdin = decodeRequestBody(request);
  const enforcement =
    service === "git-receive-pack" ? receivePackEnforcement(repo.id) : { configArgs: [] as const, env: {}, cleanup: () => {} };

  const proc = await gitStream(
    [...enforcement.configArgs, subcommand(service), "--stateless-rpc", path],
    {
      stdin: stdin ?? "ignore",
      gitProtocol: gitProtocolHeader(request),
      env: enforcement.env,
    },
  );

  const response = new Response(proc.stdout, {
    status: 200,
    headers: noCacheHeaders({
      "content-type": `application/x-${service}-result`,
    }),
  });

  const finished = proc.exited.then(async (exitCode) => {
            const stderr = await proc.stderr();
    if (onComplete) await onComplete(exitCode, stderr);
    return { exitCode, stderr };
  });
  finished.catch((error: unknown) => {
    log.error("git rpc post-processing failed", {
      service,
      repo: repo.name,
      reason: error instanceof Error ? error.message : String(error),
    });
  });

  return response;
}

export { assertCanRead, assertCanWrite };

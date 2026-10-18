#!/usr/bin/env bun
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const RUNNER_VERSION = "1.0.0";

export interface RunnerOptions {
  url: string;
  token: string;
  executor: "docker" | "shell";
  image: string;
  allowedImages: string[];
  pollMs: number;
  once: boolean;
  memory: string;
  cpus: string;
  network: string;
}

export interface ClaimedJob {
  run_id: number;
  repository: string;
  ref: string;
  sha: string;
  workflow: string;
  job: { id: string; name: string; runs_on: string; steps: { name: string; run: string }[] };
  step_timeout_ms: number;
}

const IMAGE_ALIASES: Record<string, string> = {
  "ubuntu-latest": "ubuntu:24.04",
  "ubuntu-24.04": "ubuntu:24.04",
  "ubuntu-22.04": "ubuntu:22.04",
  "debian-latest": "debian:stable-slim",
  bun: "oven/bun:1",
  node: "node:22",
  alpine: "alpine:3",
};

export function imageFor(runsOn: string, fallback: string): string {
  const value = runsOn.trim();
  if (IMAGE_ALIASES[value]) return IMAGE_ALIASES[value];
  if (/^[a-z0-9][a-z0-9._/-]*(:[A-Za-z0-9._-]+)?(@sha256:[a-f0-9]{64})?$/.test(value) && (value.includes(":") || value.includes("/"))) return value;
  return fallback;
}

export function imageAllowed(image: string, allowed: readonly string[]): boolean {
  if (allowed.length === 0) return true;
  return allowed.some((pattern) => (pattern.endsWith("*") ? image.startsWith(pattern.slice(0, -1)) : image === pattern));
}

export function parseArgs(argv: readonly string[], env: Record<string, string | undefined>): RunnerOptions {
  const flags = new Map<string, string>();
  const bools = new Set<string>();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (!arg.startsWith("--")) continue;
    const [key, inline] = arg.slice(2).split("=", 2) as [string, string | undefined];
    if (inline !== undefined) flags.set(key, inline);
    else if (argv[i + 1] && !argv[i + 1]!.startsWith("--")) flags.set(key, argv[++i]!);
    else bools.add(key);
  }
  const url = (flags.get("url") ?? env.GITGOOD_RUNNER_URL ?? "").replace(/\/+$/, "");
  const token = flags.get("token") ?? env.GITGOOD_RUNNER_TOKEN ?? "";
  if (!/^https?:\/\//.test(url)) throw new Error("--url (or GITGOOD_RUNNER_URL) must be the GitGood base URL, e.g. https://git.example.com");
  if (!token.startsWith("ggr_")) throw new Error("--token (or GITGOOD_RUNNER_TOKEN) must be a runner token from Admin → Runners");
  const executor = (flags.get("executor") ?? env.GITGOOD_RUNNER_EXECUTOR ?? "docker") as RunnerOptions["executor"];
  if (executor !== "docker" && executor !== "shell") throw new Error("--executor must be docker or shell");
  return {
    url,
    token,
    executor,
    image: flags.get("image") ?? env.GITGOOD_RUNNER_IMAGE ?? "ubuntu:24.04",
    allowedImages: (flags.get("allowed-images") ?? env.GITGOOD_RUNNER_ALLOWED_IMAGES ?? "").split(",").map((s) => s.trim()).filter(Boolean),
    pollMs: Math.max(500, Number(flags.get("poll-ms") ?? 3000) || 3000),
    once: bools.has("once"),
    memory: flags.get("memory") ?? env.GITGOOD_RUNNER_MEMORY ?? "4g",
    cpus: flags.get("cpus") ?? env.GITGOOD_RUNNER_CPUS ?? "2",
    network: flags.get("network") ?? env.GITGOOD_RUNNER_NETWORK ?? "bridge",
  };
}

export class Api {
  constructor(private readonly options: RunnerOptions) {}

  async call(path: string, init: RequestInit = {}): Promise<Response> {
    const response = await fetch(`${this.options.url}${path}`, {
      ...init,
      headers: { authorization: `Bearer ${this.options.token}`, "content-type": "application/json", ...init.headers },
    });
    if (response.status === 401) throw new Error("The server rejected this runner token. It may have been removed.");
    return response;
  }

  async claim(): Promise<ClaimedJob | null> {
    const response = await this.call("/api/runner/claim", { method: "POST", body: JSON.stringify({ version: RUNNER_VERSION }) });
    if (response.status === 204) return null;
    if (!response.ok) throw new Error(`claim failed: HTTP ${response.status}`);
    return (await response.json()) as ClaimedJob;
  }
}

export class LogStream {
  private buffer: string[] = [];
  private partial = "";
  private timer: ReturnType<typeof setInterval> | null = null;
  private chain: Promise<void> = Promise.resolve();

  constructor(private readonly send: (lines: string[]) => Promise<void>, private readonly flushMs = 1000, private readonly maxBatch = 200) {}

  start(): void {
    this.timer = setInterval(() => void this.flush(), this.flushMs);
  }

  write(chunk: string): void {
    const text = this.partial + chunk.replace(/\r\n?/g, "\n");
    const parts = text.split("\n");
    this.partial = parts.pop() ?? "";
    this.buffer.push(...parts);
    if (this.buffer.length >= this.maxBatch) void this.flush();
  }

  line(text: string): void {
    this.write(`${text}\n`);
  }

  flush(): Promise<void> {
    if (this.buffer.length === 0) return this.chain;
    const lines = this.buffer.splice(0, this.buffer.length);
    this.chain = this.chain.then(() => this.send(lines)).catch(() => {});
    return this.chain;
  }

  async close(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    if (this.partial) {
      this.buffer.push(this.partial);
      this.partial = "";
    }
    await this.flush();
  }
}

async function pipe(stream: ReadableStream<Uint8Array> | null | undefined, log: LogStream): Promise<void> {
  if (!stream) return;
  const decoder = new TextDecoder();
  for await (const chunk of stream) log.write(decoder.decode(chunk, { stream: true }));
}

async function runProcess(cmd: string[], cwd: string, log: LogStream, timeoutMs: number, onTimeout?: () => Promise<void>): Promise<number> {
  const proc = Bun.spawn(cmd, { cwd, stdout: "pipe", stderr: "pipe", env: { PATH: process.env.PATH ?? "", HOME: cwd, CI: "true", GITGOOD_CI: "1" } });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    void (onTimeout ? onTimeout() : Promise.resolve()).finally(() => proc.kill("SIGKILL"));
  }, timeoutMs);
  await Promise.all([pipe(proc.stdout, log), pipe(proc.stderr, log)]);
  const code = await proc.exited;
  clearTimeout(timer);
  if (timedOut) {
    log.line(`\u2717 step exceeded ${Math.round(timeoutMs / 60_000)} minute timeout`);
    return 124;
  }
  return code;
}

async function quiet(cmd: string[]): Promise<number> {
  const proc = Bun.spawn(cmd, { stdout: "ignore", stderr: "ignore" });
  return proc.exited;
}

export async function executeJob(options: RunnerOptions, api: Api, job: ClaimedJob): Promise<"success" | "failure"> {
  const log = new LogStream(async (lines) => {
    await api.call(`/api/runner/jobs/${job.run_id}/log`, { method: "POST", body: JSON.stringify({ lines }) });
  });
  log.start();
  const root = await mkdtemp(join(tmpdir(), "gitgood-job-"));
  const workdir = join(root, "source");
  const container = `gitgood-job-${job.run_id}-${Math.random().toString(36).slice(2, 8)}`;
  let status: "success" | "failure" = "failure";
  let exitCode: number | null = 1;
  try {
    const source = await api.call(`/api/runner/jobs/${job.run_id}/source`);
    if (!source.ok || !source.body) throw new Error(`could not download the source archive (HTTP ${source.status})`);
    const archive = join(root, "source.tar.gz");
    await Bun.write(archive, source);
    if ((await quiet(["tar", "-xzf", archive, "-C", root])) !== 0) throw new Error("could not extract the source archive");

    if (options.executor === "docker") {
      const image = imageFor(job.job.runs_on, options.image);
      if (!imageAllowed(image, options.allowedImages)) throw new Error(`image ${image} is not in this runner's allowed list`);
      log.line(`\u25B6 Starting container ${image}`);
      const started = await runProcess(
        [
          "docker", "run", "-d", "--rm", "--name", container,
          "--network", options.network, "--memory", options.memory, "--cpus", options.cpus,
          "--pids-limit", "2048", "--security-opt", "no-new-privileges",
          "-v", `${workdir}:/workspace`, "-w", "/workspace",
          "-e", "CI=true", "-e", "GITGOOD_CI=1",
          "-e", `GITGOOD_SHA=${job.sha}`, "-e", `GITGOOD_REF=${job.ref}`, "-e", `GITGOOD_REPOSITORY=${job.repository}`,
          "--entrypoint", "sh", image, "-c", "trap : TERM INT; sleep 2147483647 & wait",
        ],
        root, log, 15 * 60_000,
      );
      if (started !== 0) throw new Error(`could not start container (exit ${started})`);
    }

    exitCode = 0;
    for (const step of job.job.steps) {
      log.line(`\u25B6 ${step.name}`);
      const cmd = options.executor === "docker" ? ["docker", "exec", container, "sh", "-ec", step.run] : ["sh", "-ec", step.run];
      const code = await runProcess(cmd, workdir, log, job.step_timeout_ms, options.executor === "docker" ? async () => { await quiet(["docker", "kill", container]); } : undefined);
      if (code !== 0) {
        log.line(`\u2717 ${step.name} failed with exit code ${code}`);
        exitCode = code;
        break;
      }
      log.line(`\u2713 ${step.name}`);
    }
    status = exitCode === 0 ? "success" : "failure";
  } catch (cause) {
    log.line(`\u2717 ${cause instanceof Error ? cause.message : String(cause)}`);
    status = "failure";
    exitCode = exitCode === 0 ? 1 : exitCode;
  } finally {
    if (options.executor === "docker") await quiet(["docker", "rm", "-f", container]);
    await log.close();
    await rm(root, { recursive: true, force: true }).catch(() => {});
    await api.call(`/api/runner/jobs/${job.run_id}/finish`, {
      method: "POST",
      body: JSON.stringify({ status, exit_code: exitCode === null ? null : Math.max(-1, Math.min(255, exitCode)) }),
    }).catch(() => {});
  }
  return status;
}

export async function runLoop(options: RunnerOptions, signal?: AbortSignal): Promise<number> {
  const api = new Api(options);
  let completed = 0;
  console.log(`gitgood-runner ${RUNNER_VERSION} \u2192 ${options.url} (executor: ${options.executor})`);
  while (!signal?.aborted) {
    let job: ClaimedJob | null = null;
    try {
      job = await api.claim();
    } catch (cause) {
      console.error(cause instanceof Error ? cause.message : cause);
      if (cause instanceof Error && cause.message.includes("rejected this runner token")) return completed;
    }
    if (job) {
      console.log(`\u25B6 ${job.repository} ${job.workflow} / ${job.job.name} (${job.sha.slice(0, 8)})`);
      const status = await executeJob(options, api, job);
      console.log(`${status === "success" ? "\u2713" : "\u2717"} run ${job.run_id} ${status}`);
      completed += 1;
      if (options.once) return completed;
      continue;
    }
    if (options.once) return completed;
    await Bun.sleep(options.pollMs);
  }
  return completed;
}

if (import.meta.main) {
  try {
    const options = parseArgs(Bun.argv.slice(2), Bun.env);
    const controller = new AbortController();
    process.on("SIGINT", () => controller.abort());
    process.on("SIGTERM", () => controller.abort());
    await runLoop(options, controller.signal);
  } catch (cause) {
    console.error(cause instanceof Error ? cause.message : cause);
    process.exit(1);
  }
}

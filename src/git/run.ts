import { existsSync } from "node:fs";
import { config } from "../config.ts";
import { gaugeValue, increment, setGauge } from "../lib/metrics.ts";
import { log } from "../lib/logger.ts";

const BASE_ARGS: readonly string[] = [
  "-c",
  "safe.directory=*",
  "-c",
  "core.autocrlf=false",
  "-c",
  "core.quotepath=false",
  "-c",
  "i18n.logOutputEncoding=UTF-8",
  "-c",
  "core.fsmonitor=false",
  "-c",
  "advice.detachedHead=false",
  "-c",
  "protocol.version=2",
];

const GIT_ENV: Record<string, string> = {
  GIT_TERMINAL_PROMPT: "0",
  GIT_OPTIONAL_LOCKS: "0",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_PAGER: "cat",
  LC_ALL: "C.UTF-8",
  LANG: "C.UTF-8",
};

class Semaphore {
  private available: number;
  private readonly queue: Array<() => void> = [];

  constructor(size: number) {
    this.available = Math.max(1, size);
  }

  async acquire(): Promise<() => void> {
    if (this.available > 0) {
      this.available -= 1;
    } else {
      await new Promise<void>((resolve) => this.queue.push(resolve));
      increment("git_queue_waits_total");
    }
    setGauge("git_slots_available", this.available);
    setGauge("git_queue_depth", this.queue.length);

    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.queue.shift();
      if (next) next();
      else this.available += 1;
      setGauge("git_slots_available", this.available);
      setGauge("git_queue_depth", this.queue.length);
    };
  }
}

const semaphore = new Semaphore(config.gitConcurrency);

export interface GitResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export class GitError extends Error {
  readonly exitCode: number;
  readonly stderr: string;
  readonly args: readonly string[];

  constructor(args: readonly string[], exitCode: number, stderr: string) {
    super(`git ${args.join(" ")} failed (${exitCode}): ${stderr.trim().split("\n")[0] ?? ""}`);
    this.name = "GitError";
    this.exitCode = exitCode;
    this.stderr = stderr;
    this.args = args;
  }
}

export class RepositoryUnavailableError extends Error {
  readonly cwd: string;

  constructor(cwd: string) {
    super("Repository data is not present on this server");
    this.name = "RepositoryUnavailableError";
    this.cwd = cwd;
  }
}

export interface GitRunOptions {
  cwd?: string;
  input?: Uint8Array | string;
  env?: Record<string, string>;
  allowFailure?: boolean;
  unthrottled?: boolean;
  timeoutMs?: number;
  maxBytes?: number;
}

export async function git(args: readonly string[], options: GitRunOptions = {}): Promise<GitResult> {
  const release = options.unthrottled ? () => {} : await semaphore.acquire();
  try {
    if (options.cwd !== undefined && !existsSync(options.cwd)) {
      log.error("repository data missing from disk", { cwd: options.cwd });
      throw new RepositoryUnavailableError(options.cwd);
    }
    const proc = Bun.spawn(["git", ...BASE_ARGS, ...args], {
      cwd: options.cwd,
      env: options.env ? { ...GIT_ENV, ...options.env } : { ...GIT_ENV },
      stdin: options.input === undefined ? "ignore" : Buffer.from(options.input),
      stdout: "pipe",
      stderr: "pipe",
    });

    let timer: ReturnType<typeof setTimeout> | undefined;
    if (options.timeoutMs) {
      timer = setTimeout(() => {
        proc.kill();
        setTimeout(() => proc.kill(9), 5_000);
      }, options.timeoutMs);
      timer.unref?.();
    }

    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (timer) clearTimeout(timer);

    if (exitCode !== 0 && !options.allowFailure) {
      throw new GitError(args, exitCode, stderr);
    }
    return { stdout, stderr, exitCode };
  } finally {
    release();
  }
}

export async function gitStdout(args: readonly string[], options: GitRunOptions = {}): Promise<string> {
  const result = await git(args, { ...options, allowFailure: true });
  return result.exitCode === 0 ? result.stdout : "";
}

export interface SpawnedGit {
  stdout: ReadableStream<Uint8Array>;
  exited: Promise<number>;
  stderr: () => Promise<string>;
}

export const STREAM_TIMEOUT_MS = 2 * 60 * 60 * 1000;

export interface GitStreamOptions {
  cwd?: string;
  stdin?: ReadableStream<Uint8Array> | "ignore";
  gitProtocol?: string;
  timeoutMs?: number;
  unthrottled?: boolean;
  env?: Record<string, string>;
}

export async function gitStream(args: readonly string[], options: GitStreamOptions): Promise<SpawnedGit> {
  const release = options.unthrottled ? () => {} : await semaphore.acquire();

  const proc = Bun.spawn(["git", ...BASE_ARGS, ...args], {
    cwd: options.cwd,
    env: {
      ...GIT_ENV,
      ...(options.gitProtocol ? { GIT_PROTOCOL: options.gitProtocol } : {}),
      ...(options.env ?? {}),
    },
    stdin: options.stdin && options.stdin !== "ignore" ? options.stdin : "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });

  const budget = options.timeoutMs ?? STREAM_TIMEOUT_MS;
  increment("git_streams_started_total");
  setGauge("git_streams_in_flight", gaugeValue("git_streams_in_flight") + 1);

  const stderrText = new Response(proc.stderr as ReadableStream<Uint8Array>).text().catch(() => "");

  const timer = setTimeout(() => {
    proc.kill();
    setTimeout(() => proc.kill(9), 5_000);
    increment("git_streams_timed_out_total");
    log.warn("git stream exceeded its time budget and was terminated", {
      args: args.slice(0, 2).join(" "),
      timeoutMs: budget,
    });
  }, budget);
  timer.unref?.();

  const exited = proc.exited.then((code) => {
    clearTimeout(timer);
    setGauge("git_streams_in_flight", Math.max(0, gaugeValue("git_streams_in_flight") - 1));
    release();
    return code;
  });

  return {
    stdout: proc.stdout as ReadableStream<Uint8Array>,
    exited,
    stderr: () => stderrText,
  };
}

export async function isGitAvailable(): Promise<boolean> {
  try {
    const result = await git(["--version"], { unthrottled: true });
    return result.exitCode === 0;
  } catch {
    return false;
  }
}

export async function gitVersion(): Promise<string> {
  const result = await git(["--version"], { unthrottled: true });
  return result.stdout.trim();
}
async function readAtMost(stream: ReadableStream<Uint8Array>, limit: number): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (total < limit) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.byteLength === 0) continue;
      const remaining = limit - total;
      if (value.byteLength >= remaining) {
        chunks.push(value.subarray(0, remaining));
        total = limit;
        break;
      }
      chunks.push(value);
      total += value.byteLength;
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

export async function gitBytes(args: readonly string[], options: GitRunOptions = {}): Promise<Uint8Array> {
  const release = options.unthrottled ? () => {} : await semaphore.acquire();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const proc = Bun.spawn(["git", ...BASE_ARGS, ...args], {
      cwd: options.cwd,
      env: { ...GIT_ENV },
      stdin: options.input === undefined ? "ignore" : Buffer.from(options.input),
      stdout: "pipe",
      stderr: "pipe",
    });

    if (options.timeoutMs) {
      timer = setTimeout(() => {
        proc.kill();
        setTimeout(() => proc.kill(9), 5_000);
      }, options.timeoutMs);
      timer.unref?.();
    }

    const stdoutPromise =
      options.maxBytes === undefined
        ? new Response(proc.stdout).arrayBuffer().then((b) => new Uint8Array(b))
        : readAtMost(proc.stdout as ReadableStream<Uint8Array>, options.maxBytes);

    const [stdout, stderr, exitCode] = await Promise.all([
      stdoutPromise,
      new Response(proc.stderr).text(),
      proc.exited,
    ]);

    if (exitCode !== 0 && !options.allowFailure && options.maxBytes === undefined) {
      throw new GitError(args, exitCode, stderr);
    }
    return stdout;
  } finally {
    if (timer) clearTimeout(timer);
    release();
  }
}

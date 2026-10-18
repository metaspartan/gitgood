import { withProcessDeadline } from "./process-deadline.ts";
import { rm } from "node:fs/promises";
import { appendLog, createRun, finishRun, markRunRunning } from "./store.ts";
import { childJobEnv, ciExecutionAllowed, ciRunnerStatus } from "./policy.ts";
import type { CiStep, CiWorkflow } from "./workflow.ts";

const MAX_LOG_LINES = 4000;
const STEP_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_STEP_BUFFER = 256 * 1024;

export interface CiJobLike {
  id: string;
  name: string;
  runsOn: string;
  steps: CiStep[];
}

export interface RunStepResult {
  name: string;
  exitCode: number;
  ok: boolean;
}

export interface RunSummary {
  runId: number;
  status: "success" | "failure";
  steps: RunStepResult[];
  durationMs: number;
}

function prepareLine(text: string): string {
  return text.replace(/\r/g, "\n").slice(0, 4000);
}

export async function runJob(
  repoId: number,
  workflow: CiWorkflow,
  job: CiJobLike,
  sha: string,
  refName: string,
  repoRoot: string,
  pullId: number | null = null,
  precreatedRunId?: number,
): Promise<RunSummary> {
  const runId = precreatedRunId ?? createRun({
    repo_id: repoId,
    workflow_name: workflow.name,
    job_id: job.id,
    ref_name: refName,
    sha,
    ...(pullId !== null ? { pull_id: pullId } : {}),
  });

  const log: string[] = [];
  let logLines = 0;
  let truncated = false;
  const pushLog = (text: string): void => {
    for (const raw of text.split("\n")) {
      if (raw === "") continue;
      if (logLines >= MAX_LOG_LINES) {
        if (!truncated) {
          truncated = true;
          log.push(prepareLine("… log truncated"));
          logLines += 1;
        }
        continue;
      }
      log.push(prepareLine(raw));
      logLines += 1;
    }
  };

  const started = Date.now();
  markRunRunning(runId);
  const steps: RunStepResult[] = [];
  const workdir = `${repoRoot}.ci-${sha.slice(0, 8)}-${runId}`;
  let worktreeCreated = false;

  const fail = (message: string): RunSummary => {
    pushLog(message);
    persistLog(runId, log);
    finishRun(runId, "failure", 1);
    return { runId, status: "failure", steps, durationMs: Date.now() - started };
  };

  pushLog(`\u23F3 ${workflow.name} / ${job.name} — ${sha.slice(0, 8)} on ${refName}`);

  if (workflow.warnings.length > 0 || workflow.parseError) {
    const reasons = workflow.parseError ? [workflow.parseError, ...workflow.warnings] : workflow.warnings;
    return fail(`\u2717 workflow not executed: ${reasons.join("; ")}`);
  }

  if (!ciExecutionAllowed()) {
    const status = ciRunnerStatus();
    return fail(`\u2717 This server does not execute jobs (${status.mode}). ${status.notice}`);
  }

  if (!workflow.triggers.has("push") && !workflow.triggers.has("workflow_dispatch")) {
    return fail("\u2717 workflow not executed: no implemented trigger");
  }

  pushLog(`\uD83D\uDD04 Cloning ${repoRoot} into a fresh worktree...`);
  pushLog("Runner mode trusted-host: no sandbox isolation. Steps run as shell commands on this host.");

  let summary: RunSummary = { runId, status: "failure", steps, durationMs: 0 };
  try {
    const clone = await execQuiet(["git", "clone", "--quiet", "--no-checkout", repoRoot, workdir]);
    if (clone.exitCode !== 0) {
      summary = fail(`\u2717 clone failed: ${boundedTail(clone.stderr || clone.stdout)}`);
    } else {
      worktreeCreated = true;
      const co = await execQuiet(["git", "-C", workdir, "checkout", "--quiet", sha]);
      if (co.exitCode !== 0) {
        summary = fail(`\u2717 checkout ${sha.slice(0, 8)} failed: ${boundedTail(co.stderr || co.stdout)}`);
      } else {
        for (const step of job.steps) {
          pushLog(`\u25B6 ${step.name}`);
          pushLog(`$ ${step.run.replace(/\n/g, "\n  ")}`);
          const result = await runStep(step.run, workdir, pushLog);
          steps.push({ name: step.name, exitCode: result.exitCode, ok: result.exitCode === 0 });
          if (result.exitCode !== 0) {
            pushLog(`\u2717 ${step.name} exited ${result.exitCode}`);
            break;
          }
          pushLog(`\u2713 ${step.name}`);
        }

        const failed = steps.some((s) => !s.ok) || steps.length !== job.steps.length;
        const status = failed ? "failure" : "success";
        const durationMs = Date.now() - started;
        pushLog(`\n${failed ? "\u2717" : "\u2713"} ${status.toUpperCase()} — ${durationMs}ms, ${steps.length} step(s)`);
        persistLog(runId, log);
        finishRun(runId, status, failed ? 1 : 0);
        summary = { runId, status, steps, durationMs };
      }
    }
  } catch (cause) {
    const msg = cause instanceof Error ? cause.message : String(cause);
    summary = fail(`\u2717 runner error: ${msg}`);
  } finally {
    if (worktreeCreated) {
      await rm(workdir, { recursive: true, force: true }).catch(() => undefined);
    }
  }
  return summary;
}

function persistLog(runId: number, log: string[]): void {
  for (let i = 0; i < log.length; i++) {
    const line = log[i];
    if (line === undefined) continue;
    appendLog(runId, i + 1, line);
  }
}

function boundedTail(text: string): string {
  const trimmed = text.trim();
  return trimmed.length > 500 ? trimmed.slice(-500) : trimmed;
}

interface QuietResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

async function runStep(command: string, workdir: string, pushLog: (s: string) => void): Promise<QuietResult> {
  const proc = Bun.spawn(["sh", "-c", command], {
    cwd: workdir,
    stdout: "pipe",
    stderr: "pipe",
    env: childJobEnv(workdir),
  });

  return collectProcess(proc, pushLog);
}

async function collectProcess(proc: ReturnType<typeof Bun.spawn>, pushLog: (text: string) => void = () => {}): Promise<QuietResult> {
  const stdout = createBoundedBuffer();
  const stderr = createBoundedBuffer();
  const readers: ReadableStreamDefaultReader<Uint8Array>[] = [];
  const collect = async (stream: ReadableStream<Uint8Array>, sink: BoundedBuffer) => {
    const reader = stream.getReader(); readers.push(reader);
    const decoder = new TextDecoder();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        const text = decoder.decode(value, { stream: true }); sink.append(text); pushLog(text);
      }
      const tail = decoder.decode(); if (tail) { sink.append(tail); pushLog(tail); }
    } finally { reader.releaseLock(); }
  };
  const abort = () => { for (const reader of readers) void reader.cancel().catch(() => {}); };
  try {
    const result = await withProcessDeadline(proc, () => Promise.all([
      collect(proc.stdout as ReadableStream<Uint8Array>, stdout),
      collect(proc.stderr as ReadableStream<Uint8Array>, stderr),
    ]), STEP_TIMEOUT_MS, abort);
    if (result.timedOut) { const message = "Process exceeded its deadline; direct process killed. Trusted-host mode does not guarantee descendant isolation."; stderr.append(message); pushLog(message); }
    return { exitCode: result.exitCode, stdout: stdout.text(), stderr: stderr.text() };
  } catch (cause) { try { proc.kill("SIGKILL"); } catch {} abort(); throw cause; }
}

interface BoundedBuffer {
  append: (chunk: string) => void;
  text: () => string;
}

export function createBoundedBuffer(limit = MAX_STEP_BUFFER): BoundedBuffer {
  let stored = "";
  let dropped = 0;
  return {
    append(chunk: string): void {
      if (chunk.length === 0) return;
      if (stored.length >= limit) {
        dropped += chunk.length;
        return;
      }
      const room = limit - stored.length;
      if (chunk.length <= room) {
        stored += chunk;
        return;
      }
      stored += chunk.slice(0, room);
      dropped += chunk.length - room;
    },
    text(): string {
      return dropped > 0 ? `${stored}\n… output truncated (${dropped} bytes dropped)` : stored;
    },
  };
}

async function execQuiet(args: string[]): Promise<QuietResult> {
  const proc = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });
  return collectProcess(proc);
}

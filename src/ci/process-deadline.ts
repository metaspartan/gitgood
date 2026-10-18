export interface DeadlineProcess {
  exited: Promise<number>;
  kill: (signal: "SIGKILL") => void;
}

export async function withProcessDeadline<T>(proc: DeadlineProcess, collect: () => Promise<T>, timeoutMs: number, abortStreams: () => void): Promise<{ exitCode: number; output: T | null; timedOut: boolean }> {
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1) throw new Error("Invalid process deadline");
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<{ exitCode: number; output: null; timedOut: true }>(resolve => {
    timer = setTimeout(() => {
      try { proc.kill("SIGKILL"); } catch {}
      try { abortStreams(); } catch {}
      resolve({ exitCode: 124, output: null, timedOut: true });
    }, timeoutMs);
  });
  try {
    return await Promise.race([
      Promise.all([proc.exited, collect()]).then(([exitCode, output]) => ({ exitCode, output, timedOut: false })),
      timeout,
    ]);
  } finally { clearTimeout(timer); }
}

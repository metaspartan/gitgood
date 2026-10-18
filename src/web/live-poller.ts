export interface PollerOptions {
  load: (signal: AbortSignal) => Promise<void>;
  available: () => boolean;
  intervalMs: number;
  schedule: (callback: () => void, delay: number) => unknown;
  cancel: (timer: unknown) => void;
}

export function createLivePoller(options: PollerOptions) {
  let stopped = false;
  let running = false;
  let queued = false;
  let failures = 0;
  let timer: unknown;
  let controller: AbortController | undefined;
  const clear = () => { if (timer !== undefined) options.cancel(timer); timer = undefined; };
  const run = async () => {
    if (stopped || !options.available()) return;
    if (running) { queued = true; return; }
    clear();
    running = true;
    controller = new AbortController();
    try { await options.load(controller.signal); failures = 0; }
    catch { failures++; }
    finally {
      running = false;
      controller = undefined;
      if (!stopped && options.available()) {
        const delay = queued ? 0 : Math.min(60000, options.intervalMs * 2 ** Math.min(failures, 3));
        queued = false;
        timer = options.schedule(() => { timer = undefined; void run(); }, delay);
      }
    }
  };
  return {
    start: () => void run(),
    refresh: () => void run(),
    availabilityChanged: () => { clear(); if (options.available()) void run(); },
    stop: () => { stopped = true; queued = false; clear(); controller?.abort(); },
  };
}

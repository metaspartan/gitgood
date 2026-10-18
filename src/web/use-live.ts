import { useCallback, useEffect, useRef, useState } from "react";
import { createLivePoller } from "./live-poller.ts";

export function useLive<T>(loader: (signal?: AbortSignal) => Promise<T>, deps: readonly unknown[], intervalMs = 10000) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const [paused, setPaused] = useState(false);
  const refresh = useRef<() => void>(() => {});
  const reload = useCallback(() => refresh.current(), []);
  useEffect(() => {
    let disposed = false;
    let fingerprint: string | undefined;
    setLoading(true);
    setData(null);
    setError(null);
    setUpdatedAt(null);
    const available = () => !document.hidden && navigator.onLine;
    const poller = createLivePoller({
      intervalMs,
      available,
      schedule: (fn, delay) => setTimeout(fn, delay),
      cancel: timer => clearTimeout(timer as ReturnType<typeof setTimeout>),
      load: async signal => {
        try {
          const next = await loader(signal);
          if (disposed || signal.aborted) return;
          const serialized = JSON.stringify(next);
          if (serialized !== fingerprint) { setData(next); fingerprint = serialized; }
          setError(null);
          setUpdatedAt(Date.now());
        } catch (cause) {
          if (!disposed) setError(cause instanceof Error ? cause.message : "Live update failed");
          throw cause;
        } finally { if (!disposed) setLoading(false); }
      },
    });
    const wake = () => { setPaused(!available()); poller.availabilityChanged(); };
    setPaused(!available());
    refresh.current = poller.refresh;
    document.addEventListener("visibilitychange", wake);
    window.addEventListener("online", wake);
    window.addEventListener("offline", wake);
    poller.start();
    return () => {
      disposed = true;
      poller.stop();
      document.removeEventListener("visibilitychange", wake);
      window.removeEventListener("online", wake);
      window.removeEventListener("offline", wake);
      refresh.current = () => {};
    };
  }, [...deps, intervalMs]);
  return { data, error, loading, reload, updatedAt, paused };
}

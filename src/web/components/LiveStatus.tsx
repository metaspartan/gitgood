import type { ReactNode } from "react";

export interface LiveStatusProps {
  error: string | null;
  loading: boolean;
  paused: boolean;
  updatedAt: number | null;
}

export function LiveStatus({ error, loading, paused, updatedAt }: LiveStatusProps): ReactNode {
  const state = paused ? "paused" : error ? "retrying" : loading ? "connecting" : "current";
  const label = paused ? "Updates paused" : error ? "Reconnecting automatically" : loading ? "Connecting" : "Auto-updating";
  return (
    <div className={`live-status live-status-${state}`}>
      <span className="live-indicator" role="status">{label}</span>
      <span className="live-status-detail">
        {updatedAt ? <>Last checked <time dateTime={new Date(updatedAt).toISOString()}>{new Date(updatedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</time></> : "Waiting for the first update"}
      </span>
    </div>
  );
}

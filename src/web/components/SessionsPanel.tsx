import { useState, type ReactNode } from "react";
import { request } from "../api.ts";
import { ErrorBanner, timeAgo, useAsync } from "../components.tsx";
import { describeUserAgent } from "../user-agent.ts";
import { Icon } from "./Icons.tsx";

interface SessionRow {
  id: string;
  current: boolean;
  created_at: number;
  last_seen_at: number | null;
  expires_at: number;
  ip: string | null;
  user_agent: string | null;
}

export function SessionsPanel(): ReactNode {
  const sessions = useAsync(() => request<{ items: SessionRow[] }>("/api/account/sessions"), []);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const others = (sessions.data?.items ?? []).filter((session) => !session.current).length;

  const act = async (path: string, method: string): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await request(path, { method, ...(method === "POST" ? { headers: { "content-type": "application/json" }, body: "{}" } : {}) });
      sessions.reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not update sessions");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card sessions-panel" aria-labelledby="sessions-title">
      <div className="sessions-head">
        <div>
          <h3 id="sessions-title" style={{ margin: 0 }}>Sessions</h3>
          <p className="small muted" style={{ margin: "4px 0 0" }}>Devices signed in to your account. Revoke any you don’t recognise.</p>
        </div>
        <button type="button" className="danger small" disabled={busy || others === 0} onClick={() => void act("/api/account/sessions/revoke-others", "POST")}>
          Sign out other sessions
        </button>
      </div>
      <ErrorBanner message={error ?? sessions.error} />
      <ul className="session-list" aria-busy={sessions.loading}>
        {sessions.loading && !sessions.data
          ? [0, 1].map((index) => (
              <li key={index} className="session-row"><span className="skeleton-text" style={{ width: "40%" }} /></li>
            ))
          : (sessions.data?.items ?? []).map((session) => {
              const device = describeUserAgent(session.user_agent);
              return (
                <li key={session.id} className="session-row">
                  <Icon name={device.mobile ? "phone" : "device"} className="session-icon" />
                  <div className="session-text">
                    <div className="session-title">
                      <strong>{device.label}</strong>
                      {session.current ? <span className="badge open">This device</span> : null}
                    </div>
                    <div className="small muted">
                      {session.ip ? <span className="mono">{session.ip}</span> : "Unknown address"} · Last active {timeAgo(session.last_seen_at ?? session.created_at)} · Signed in {timeAgo(session.created_at)}
                    </div>
                  </div>
                  {session.current ? null : (
                    <button type="button" className="small" disabled={busy} onClick={() => void act(`/api/account/sessions/${session.id}`, "DELETE")}>
                      Revoke
                    </button>
                  )}
                </li>
              );
            })}
      </ul>
    </section>
  );
}

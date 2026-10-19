import { useState, type ReactNode } from "react";
import "../pages/Admin.css";
import { request } from "../api.ts";
import { EmptyState, ErrorBanner, timeAgo, useAsync } from "../components.tsx";
import { Icon } from "./Icons.tsx";

export interface RunnerRow {
  id: number;
  name: string;
  token_prefix: string;
  created_at: number;
  last_seen_at: number | null;
  last_ip: string | null;
  version: string | null;
  paused: boolean;
  online: boolean;
  active_jobs: number;
  scope: "instance" | "user" | "repo";
  scope_label: string;
}

const json = (method: string, body?: unknown): RequestInit => ({
  method,
  ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
});

export function runnerStatus(runner: Pick<RunnerRow, "paused" | "online">): "Paused" | "Online" | "Offline" {
  return runner.paused ? "Paused" : runner.online ? "Online" : "Offline";
}

export function RunnersPanel({ base, showScope = false, emptyHint }: { base: string; showScope?: boolean; emptyHint: string }): ReactNode {
  const list = useAsync(() => request<{ items: RunnerRow[]; mode_uses_runners: boolean; max?: number }>(base), [base]);
  const [name, setName] = useState("");
  const [token, setToken] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const origin = typeof window === "undefined" ? "" : window.location.origin;
  const atLimit = list.data?.max !== undefined && list.data.items.length >= list.data.max;

  const act = async (path: string, init: RequestInit): Promise<void> => {
    setError(null);
    try {
      await request(path, init);
      list.reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "That did not work");
    }
  };

  return (
    <div className="runners-panel">
      {list.data && !list.data.mode_uses_runners ? (
        <div className="notice-banner">This server is not in runner mode, so jobs run on the server instead of being queued for runners. An administrator can set <code>GITGOOD_CI_MODE=runner</code>.</div>
      ) : null}
      <ErrorBanner message={error ?? list.error} />
      <form
        className="card admin-card admin-inline-form"
        onSubmit={async (event) => {
          event.preventDefault();
          setError(null);
          setBusy(true);
          try {
            const created = await request<{ token: string }>(base, json("POST", { name: name.trim() }));
            setToken(created.token);
            setName("");
            list.reload();
          } catch (cause) {
            setError(cause instanceof Error ? cause.message : "Could not register the runner");
          } finally {
            setBusy(false);
          }
        }}
      >
        <label className="grow">Runner name<input required maxLength={80} value={name} onChange={(e) => setName(e.target.value)} placeholder="build-box-1" /></label>
        <button type="submit" className="btn-primary" disabled={busy || atLimit}><Icon name="plus" /> New runner</button>
      </form>
      {token ? (
        <div className="card admin-card admin-token" role="status">
          <h2 className="admin-card-title">Start the runner</h2>
          <p className="small muted">Copy the token now. It is shown only once.</p>
          <p className="small">On any machine with Docker, from a GitGood checkout:</p>
          <pre className="admin-code">{`GITGOOD_RUNNER_URL=${origin} \\
GITGOOD_RUNNER_TOKEN=${token} \\
docker compose --profile runner up -d runner`}</pre>
          <p className="small muted">Or run the agent directly with Bun: <code>{`bun runner/gitgood-runner.ts --url ${origin} --token ${token}`}</code></p>
          <button type="button" className="btn-secondary small" onClick={() => setToken(null)}>Done</button>
        </div>
      ) : null}
      <div className="admin-table-wrap">
        <table className="admin-table">
          <thead>
            <tr>
              <th>Runner</th>
              {showScope ? <th>Scope</th> : null}
              <th>Status</th>
              <th className="num">Jobs</th>
              <th className="hide-narrow">Last contact</th>
              <th className="hide-narrow">Version</th>
              <th aria-label="Actions" />
            </tr>
          </thead>
          <tbody aria-busy={list.loading}>
            {(list.data?.items ?? []).map((runner) => (
              <tr key={runner.id}>
                <td><strong>{runner.name}</strong><div className="small faint mono">{runner.token_prefix}…</div></td>
                {showScope ? (
                  <td className="small">
                    <span className="badge">{runner.scope === "instance" ? "Instance" : runner.scope === "user" ? "User" : "Repository"}</span>
                    <div className="faint">{runner.scope_label}</div>
                  </td>
                ) : null}
                <td>
                  <span className={`runner-dot is-${runnerStatus(runner).toLowerCase()}`} aria-hidden="true" />
                  {runnerStatus(runner)}
                </td>
                <td className="num">{runner.active_jobs}</td>
                <td className="small muted hide-narrow">{runner.last_seen_at ? `${timeAgo(runner.last_seen_at)}${runner.last_ip ? ` from ${runner.last_ip}` : ""}` : "Never"}</td>
                <td className="small mono hide-narrow">{runner.version ?? "–"}</td>
                <td className="admin-actions">
                  <button type="button" className="btn-secondary small" onClick={() => void act(`${base}/${runner.id}`, json("PATCH", { paused: !runner.paused }))}>{runner.paused ? "Resume" : "Pause"}</button>{" "}
                  <button type="button" className="btn-secondary small danger-text" onClick={() => { if (window.confirm(`Remove ${runner.name}? Its token stops working immediately.`)) void act(`${base}/${runner.id}`, json("DELETE")); }}>Remove</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {list.data && list.data.items.length === 0 ? <EmptyState title="No runners yet" hint={emptyHint} /> : null}
      </div>
    </div>
  );
}

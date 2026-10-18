import { WorkflowDispatch } from "../components/WorkflowDispatch.tsx";
import { createCiLogReader } from "../ci-log-reader.ts";
import { LiveStatus } from "../components/LiveStatus.tsx";
import { useLive } from "../use-live.ts";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { api, request } from "../api.ts";
import { EmptyState, ErrorBanner, Spinner, timeAgo } from "../components.tsx";
import type { CiLogLine, CiRun, CiRunnerInfo } from "../types.ts";

type CiTab = "runs" | "log" | "workflow";

function statusLabel(status: CiRun["status"]): { label: string; tone: "ok" | "bad" | "muted" | "pending" } {
  switch (status) {
    case "success":
      return { label: "Success", tone: "ok" };
    case "failure":
      return { label: "Failure", tone: "bad" };
    case "running":
      return { label: "Running…", tone: "pending" };
    default:
      return { label: "Queued", tone: "muted" };
  }
}

export function ActionsPage({ owner, repo }: { owner: string; repo: string }): ReactNode {
  const [tab, setTab] = useState<CiTab>("runs");
  const [selectedRun, setSelectedRun] = useState<CiRun | null>(null);

  const [cursors, setCursors] = useState<number[]>([]);
  const before = cursors[cursors.length - 1];
  useEffect(() => { setCursors([]); setSelectedRun(null); setTab("runs"); }, [owner, repo]);
  const runs = useLive((signal) => api.ciRuns(owner, repo, signal, before), [owner, repo, before]);
  const items = runs.data?.items ?? [];
  const runner = runs.data?.runner ?? null;

  return (
    <div className="card">
      <div className="row wrap" style={{ marginBottom: 12 }}>
        <h2 style={{ margin: 0, fontSize: 18 }}>Actions</h2>
        <span className="spacer" />
        <LiveStatus {...runs} />
      </div>
      {runs.error ? <ErrorBanner message={runs.error} /> : null}
      <RunnerNotice runner={runner} />
      <div className="actions-overview"><span><strong>{items.filter(r => r.status === "running").length}</strong>running on this page</span><span><strong>{items.filter(r => r.status === "queued").length}</strong>queued on this page</span><span><strong>{items.length}</strong>jobs on this page</span></div>

      <div className="actions-tabs" role="radiogroup" aria-label="Actions view">
        {(
          [
            { key: "runs", label: "Runs" },
            { key: "log", label: "Log" },
            { key: "workflow", label: "Workflow" },
          ] as const
        ).map((option) => (
          <label key={option.key} className="tablike">
            <input
              type="radio"
              name="ci-tab"
              checked={tab === option.key}
              onChange={() => setTab(option.key)}
            />
            <span>{option.label}</span>
          </label>
        ))}
      </div>

      {tab === "runs" ? <nav className="row wrap" aria-label="Workflow history pages" style={{ marginBottom: 16 }}>
        <button type="button" className="ghost small" disabled={!cursors.length || runs.loading} onClick={() => setCursors([])}>Latest jobs</button>
        <button type="button" className="ghost small" disabled={!cursors.length || runs.loading} onClick={() => setCursors(values => values.slice(0, -1))}>Newer</button>
        <span className="small faint" role="status">Page {cursors.length + 1}</span>
        <button type="button" className="ghost small" disabled={runs.loading || !runs.data?.next_before} onClick={() => { const next = runs.data?.next_before; if (next) setCursors(values => [...values, next]); }}>Older</button>
      </nav> : null}
      {tab === "workflow" ? <WorkflowView owner={owner} repo={repo} onDispatched={jobs => { setSelectedRun(jobs[0] ?? null); setTab("runs"); setCursors([]); runs.reload(); }} /> : null}
      {tab === "log" ? (
        <LogView owner={owner} repo={repo} run={items.find(r => r.id === selectedRun?.id) ?? selectedRun ?? items[0] ?? null} runner={runner} canWrite={runs.data?.can_write ?? false} onRerun={run => { setSelectedRun(run); runs.reload(); }} />
      ) : null}
      {tab === "runs" ? (
        <RunListView owner={owner} repo={repo} items={items} loading={runs.loading} onOpen={(r) => { setSelectedRun(r); setTab("log"); }} />
      ) : null}
    </div>
  );
}

function RunnerNotice({ runner }: { runner: CiRunnerInfo | null }): ReactNode {
  if (!runner) return null;
  if (runner.mode === "runner") {
    const online = runner.runnersOnline ?? 0;
    return (
      <div className={`aside-panel${online === 0 ? " is-warning" : ""}`} role="status" style={{ marginBottom: 12 }}>
        <h3>{online === 0 ? "No runner online" : `${online} runner${online === 1 ? "" : "s"} online`}</h3>
        <p className="small">
          {online === 0
            ? "Jobs are queued and start as soon as a runner connects. An administrator can register one under Admin \u2192 Runners."
            : "Jobs run in fresh containers on registered runners, never on the GitGood server."}
        </p>
      </div>
    );
  }
  const title = runner.mode === "disabled" ? "CI disabled" : "Trusted host, no isolation";
  return (
    <div className="aside-panel" role="status" style={{ marginBottom: 12 }}>
      <h3>{title}</h3>
      <p className="small">{runner.notice}</p>
      {runner.maxConcurrent !== undefined ? <p className="small faint">Shared process queue: {runner.active} / {runner.maxConcurrent} active · {runner.queued} queued · {runner.maxPending} maximum pending</p> : null}
    </div>
  );
}

function RunListView({
  items,
  loading,
  onOpen,
}: {
  owner: string;
  repo: string;
  items: CiRun[];
  loading: boolean;
  onOpen: (run: CiRun) => void;
}): ReactNode {
  if (loading) return <Spinner label="Loading runs" />;
  if (items.length === 0) {
    return (
      <EmptyState
        title="No runs yet"
        hint="Commit a `.gitgood-ci.yml` with `jobs:` steps on the `push` event, then push — runs appear here."
      />
    );
  }
  return (
    <table className="list">
      <thead>
        <tr>
          <th>Status</th>
          <th>Workflow / job</th>
          <th>Ref</th>
          <th>Commit</th>
          <th>When</th>
        </tr>
      </thead>
      <tbody>
        {items.map((run) => {
          const { label, tone } = statusLabel(run.status);
          return (
            <tr key={run.id} className="rowlink" onClick={() => onOpen(run)}>
              <td>
                <span className={`badge ${tone === "ok" ? "stat-add" : tone === "bad" ? "stat-del" : ""}`}>{label}</span>
              </td>
              <td className="small">
                <button type="button" className="linklike" onClick={(event) => { event.stopPropagation(); onOpen(run); }}>
                  {run.workflow_name} / {run.job_id}
                </button>
              </td>
              <td className="small faint">{run.ref_name}</td>
              <td className="small mono">{run.sha.slice(0, 8)}</td>
              <td className="small faint">{timeAgo(run.started_at)}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function LogView({ owner, repo, run: initial, runner, canWrite, onRerun }: {
  owner: string; repo: string; run: CiRun | null; runner: CiRunnerInfo | null; canWrite: boolean; onRerun: (run: CiRun) => void;
}): ReactNode {
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const status = useLive(signal => initial
    ? request<CiRun>(`/api/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/ci/runs/${initial.id}`, { signal })
    : Promise.resolve(null), [owner, repo, initial?.id]);
  const selected = status.data ?? initial;
  useEffect(() => { setConfirm(false); setError(null); }, [initial?.id, owner, repo]);
  const reader = useMemo(() => createCiLogReader((cursor, signal) => selected
    ? api.ciLog(owner, repo, selected.id, cursor, signal)
    : Promise.resolve({ items: [] })), [owner, repo, selected?.id]);
  const terminal = selected?.status === "success" || selected?.status === "failure";
  const log = useLive(signal => reader(terminal, signal), [reader, terminal]);
  const rerun = async () => {
    if (!selected) return;
    setBusy(true); setError(null);
    try {
      const result = await request<{ items: CiRun[] }>(`/api/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/ci/runs/${selected.id}/rerun`, { method: "POST" });
      if (result.items[0]) onRerun(result.items[0]);
      setConfirm(false);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Rerun failed"); }
    finally { setBusy(false); }
  };
  if (!selected) return <EmptyState title="Select a run" hint="Choose a run from the Runs tab to see its log." />;
  return <div>
    <div className="row wrap small faint" style={{ marginBottom: 12 }}>
      <span>#{selected.id} {selected.workflow_name} / {selected.job_id} — <code>{selected.sha.slice(0, 8)}</code> on {selected.ref_name}</span>
      <span className="spacer" /><LiveStatus {...log} />
      {terminal && runner?.enabled && canWrite ? <button type="button" className="ghost small" onClick={() => setConfirm(true)}>Re-run job</button> : null}
    </div>
    <ErrorBanner message={error ?? status.error ?? log.error} />
    {confirm ? <div className="workflow-confirm"><p>Re-run this job at its original commit <code>{selected.sha.slice(0, 8)}</code>? Repository write permission is required. Trusted-host jobs are not isolated.</p><div className="row"><button type="button" disabled={busy} onClick={() => void rerun()}>Confirm re-run</button><button type="button" className="ghost" onClick={() => setConfirm(false)}>Cancel</button></div></div> : null}
    {log.loading ? <Spinner label="Loading log" /> : <>
      <p className="small faint">{log.data?.items.length ?? 0} loaded lines. Logs are fetched incrementally; a running step may buffer output until it completes.</p>
      {log.data?.truncated ? <p role="status">Display limited to 4,000 lines. The log API supports paginated access.</p> : null}
      <pre className="ci-log" aria-label={`Build log for run ${selected.id}`}>{log.data?.items.map((line: CiLogLine) => <div key={line.seq} className="ci-log-line">{line.text}</div>)}</pre>
    </>}
  </div>;
}

function WorkflowView({ owner, repo, onDispatched }: { owner: string; repo: string; onDispatched: (runs: CiRun[]) => void }): ReactNode {
  return <div className="actions-workflow-layout">
    <WorkflowDispatch owner={owner} repo={repo} onDispatched={onDispatched} />
    <aside className="actions-guide"><h3>Start with a shell workflow</h3><p className="small muted">Commit <code>.gitgood-ci.yml</code> to the branch you want to build.</p>
      <pre>{`name: Build
on: [push, workflow_dispatch]
jobs:
  build:
    runs-on: host
    steps:
      - run: git status --short
      - run: echo "Build complete"`}</pre>
      <h3>Execution boundary</h3><p className="small muted">This is GitGood’s shell workflow format, not GitHub Actions or GitLab CI syntax compatibility. Marketplace actions, containers, matrices, secrets and approval environments are not supported. The host runner must only run trusted code.</p>
      <p className="small faint">Queued metadata is saved, but the worker queue is local to this server process. It is not a registered remote-runner fleet or a durable job broker.</p>
    </aside>
  </div>;
}

import { request } from "../api.ts";
import { useLive } from "../use-live.ts";
import { ErrorBanner } from "../components.tsx";
import { LiveStatus } from "./LiveStatus.tsx";
import type { CiRunnerInfo } from "../types.ts";

interface RunnerOverviewData {
  runner: CiRunnerInfo;
  active: number;
  queued: number;
  pending: number;
  maxConcurrent: number;
  maxPending: number;
}

export function RunnerOverview() {
  const state = useLive(signal => request<RunnerOverviewData>("/api/admin/runner", { signal }), []);
  return <section className="card" aria-label="CI runner administration">
    <div className="card-head"><h2>Workflow runner</h2><LiveStatus {...state} /></div>
    <ErrorBanner message={state.error} />
    {state.data ? <>
      <p><strong>{state.data.runner.enabled ? "Trusted host — no sandbox" : "Execution disabled"}</strong></p>
      <p className="muted small">{state.data.runner.notice}</p>
      <dl className="admin-config-grid">
        <div><dt>Active jobs</dt><dd>{state.data.active} / {state.data.maxConcurrent}</dd></div>
        <div><dt>Queued locally</dt><dd>{state.data.queued}</dd></div>
        <div><dt>Pending job records</dt><dd>{state.data.pending} / {state.data.maxPending}</dd></div>
        <div><dt>Execution policy</dt><dd><code>GITGOOD_CI_MODE</code></dd></div>
      </dl>
      <p className="small faint">This is one in-process worker queue, not a remote-runner fleet. Process restarts mark interrupted jobs failed; they are not resumed. Keep execution disabled for untrusted repositories; changing this setting requires a server restart.</p>
      <details><summary>Supported workflow setup</summary><p className="small">Commit <code>.gitgood-ci.yml</code> with <code>on: [push, workflow_dispatch]</code>. Writers can start jobs from Actions → Workflow. Each job uses a fresh checkout at an immutable commit. Scheduling, marketplace actions, per-job containers, environments and secrets are not implemented.</p></details>
    </> : <p className="muted small">Loading runner state…</p>}
  </section>;
}

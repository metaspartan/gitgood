import { useEffect, useState } from "react";
import { request } from "../api.ts";
import { useLive } from "../use-live.ts";
import { ErrorBanner, Spinner } from "../components.tsx";
import { Link } from "../router.tsx";
import type { CiRun, CiRunnerInfo } from "../types.ts";
import "./WorkflowDispatch.css";

interface WorkflowInfo {
  ref: string;
  sha: string | null;
  path: string;
  name?: string;
  jobs: Array<{ id: string; name?: string; steps?: Array<{ name: string }> }>;
  triggers: string[];
  warnings: string[];
  parse_error?: string | null;
  runner: CiRunnerInfo;
  can_dispatch: boolean;
  present: boolean;
}

export function WorkflowDispatch({ owner, repo, onDispatched }: { owner: string; repo: string; onDispatched: (runs: CiRun[]) => void }) {
  const [branch, setBranch] = useState("");
  const [chosen, setChosen] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const prefix = `/api/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  const info = useLive(signal => request<WorkflowInfo>(`${prefix}/ci/workflow${chosen ? `?ref=${encodeURIComponent(chosen)}` : ""}`, { signal }), [owner, repo, chosen]);
  useEffect(() => { setBranch(""); setChosen(""); setConfirm(false); setError(null); }, [owner, repo]);
  useEffect(() => { setConfirm(false); }, [info.data?.sha]);
  const dispatch = async () => {
    if (!info.data?.can_dispatch) return;
    setBusy(true); setError(null);
    try {
      const result = await request<{ items: CiRun[] }>(`${prefix}/ci/dispatch`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ref: info.data.ref }) });
      onDispatched(result.items); setConfirm(false);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Workflow dispatch failed"); }
    finally { setBusy(false); }
  };
  return <section className="workflow-dispatch" aria-label="Workflow dispatch">
    <header><div><h3>Run a workflow</h3><p className="muted small">Choose a branch and inspect its committed workflow before starting jobs.</p></div><code>.gitgood-ci.yml</code></header>
    <form className="workflow-branch" onSubmit={e => { e.preventDefault(); setConfirm(false); setChosen(branch.trim()); }}>
      <label htmlFor="workflow-branch">Branch</label><input id="workflow-branch" placeholder={info.data?.ref || "Repository default branch"} value={branch} onChange={e => setBranch(e.target.value)} autoComplete="off" spellCheck={false} />
      <button type="submit" className="ghost" disabled={info.loading}>Inspect branch</button>
    </form>
    <ErrorBanner message={error ?? info.error} />
    {info.loading ? <Spinner label="Reading workflow" /> : info.data ? <>
      <div className="workflow-details"><div><strong>{info.data.name || "Workflow"}</strong><p className="small faint">{info.data.ref} · {info.data.sha?.slice(0, 8) || "No commit"}</p></div><span className="badge">{info.data.jobs.length} {info.data.jobs.length === 1 ? "job" : "jobs"}</span></div>
      {info.data.jobs.length ? <ul className="workflow-jobs">{info.data.jobs.map(job => <li key={job.id}><code>{job.id}</code>{job.name && job.name !== job.id ? ` · ${job.name}` : ""}</li>)}</ul> : <p className="muted small">No runnable jobs on this branch. Commit a supported workflow file first.</p>}
      {info.data.parse_error ? <ErrorBanner message={info.data.parse_error} /> : null}
      {info.data.warnings.map((warning, i) => <p className="small workflow-warning" key={i}>{warning}</p>)}
      <p className="small faint">Triggers: {info.data.triggers.join(", ") || "none"}. Manual runs require <code>workflow_dispatch</code> and repository write permission.</p>
      <div className="row wrap">
        <button type="button" className="primary" disabled={!info.data.can_dispatch || busy} onClick={() => setConfirm(true)}>Run workflow</button>
        {info.data.sha && info.data.present ? <Link to={`/${owner}/${repo}/blob/${info.data.sha}/.gitgood-ci.yml`}>View workflow source</Link> : null}
      </div>
      {!info.data.runner.enabled ? <p className="small muted">Execution is disabled on this instance. An operator must configure a runner before jobs can start.</p> : null}
      {confirm ? <div className="workflow-confirm" role="region" aria-label="Confirm workflow run"><p>Start {info.data.jobs.length} job(s) from <strong>{info.data.ref}</strong>? This uses the branch’s current commit when the server accepts the request. Trusted-host jobs are not isolated.</p><div className="row"><button type="button" disabled={busy} onClick={() => void dispatch()}>{busy ? "Starting…" : "Confirm run"}</button><button type="button" className="ghost" disabled={busy} onClick={() => setConfirm(false)}>Cancel</button></div></div> : null}
    </> : null}
  </section>;
}

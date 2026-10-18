import { useState } from "react";
import { request } from "../../api.ts";
import { useLive } from "../../use-live.ts";
import { ErrorBanner } from "../../components.tsx";
import { LiveStatus } from "../../components/LiveStatus.tsx";
import "./BranchProtectionPanel.css";

interface Protection {
  items: Array<{ branch: string; require_pull_request: boolean }>;
  can_manage: boolean;
}

export function BranchProtectionPanel({ owner, repo }: { owner: string; repo: string }) {
  const endpoint = `/api/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/branch-protection`;
  const state = useLive(signal => request<Protection>(endpoint, { signal }), [owner, repo]);
  const [branch, setBranch] = useState("");
  const [removing, setRemoving] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const save = async (name: string, enabled: boolean) => {
    setBusy(true); setError(null); setNotice("");
    try {
      await request(endpoint, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ branch: name, require_pull_request: enabled }) });
      setNotice(enabled ? `Pull requests required for ${name}.` : `Protection removed from ${name}.`);
      if (enabled) setBranch("");
      setRemoving(null); state.reload();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not change protection"); }
    finally { setBusy(false); }
  };
  return <section className="branch-protection" aria-label="Branch protection">
    <div className="branch-protection-heading"><div><h3>Protected branches</h3><p className="small muted">Require pull requests instead of direct changes to important branches.</p></div><LiveStatus {...state} /></div>
    <ErrorBanner message={error ?? state.error} />
    <p className="small faint">Exact branch names only, including names such as <code>release/stable</code>. Direct pushes, force pushes, branch deletion and web edits are blocked. Owners must explicitly remove protection to make direct changes. Approval and check requirements are set under Merge requirements below.</p>
    {state.data?.items.length ? <ul className="branch-protection-list">{state.data.items.map(rule => <li key={rule.branch}><div><code>{rule.branch}</code><p className="small muted">Pull request required</p></div>{state.data?.can_manage ? <button type="button" className="ghost small" disabled={busy} onClick={() => setRemoving(rule.branch)}>Remove protection</button> : null}</li>)}</ul> : <p className="small muted">{state.loading ? "Loading protected branches…" : "No protected branches configured."}</p>}
    {state.data?.can_manage ? <form className="branch-protection-form" onSubmit={event => { event.preventDefault(); if (branch.trim()) void save(branch.trim(), true); }}><label htmlFor="protected-branch">Exact branch name</label><input id="protected-branch" value={branch} onChange={event => setBranch(event.target.value)} placeholder="main" maxLength={255} autoComplete="off" spellCheck={false} /><button type="submit" disabled={busy || !branch.trim()}>Require pull requests</button></form> : null}
    {removing ? <div className="branch-protection-confirm" role="region" aria-label="Confirm removal"><p>Allow direct changes to <strong>{removing}</strong>? Existing PR review requirements will not prevent direct pushes after removal.</p><div className="row wrap"><button type="button" className="danger" disabled={busy} onClick={() => void save(removing, false)}>Remove protection</button><button type="button" className="ghost" disabled={busy} onClick={() => setRemoving(null)}>Cancel</button></div></div> : null}
    <p className="small" role="status">{notice}</p>
  </section>;
}

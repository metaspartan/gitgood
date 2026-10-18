import { useState, type ReactNode } from "react";
import { request } from "../../api.ts";
import { useLive } from "../../use-live.ts";
import { ErrorBanner } from "../../components.tsx";
import { LiveStatus } from "../../components/LiveStatus.tsx";
import { Switch } from "../../components/Switch.tsx";
import "./MergeRequirementsPanel.css";

interface Policy {
  branch: string;
  required_approvals: number;
  require_checks: boolean;
}
interface PoliciesResponse {
  items: Policy[];
  can_manage: boolean;
}

const MAX_APPROVALS = 6;

export function MergeRequirementsPanel({ owner, repo }: { owner: string; repo: string }): ReactNode {
  const base = `/api/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  const state = useLive(signal => request<PoliciesResponse>(`${base}/pull-merge-policies`, { signal }), [owner, repo]);
  const [branch, setBranch] = useState("");
  const [approvals, setApprovals] = useState(1);
  const [checks, setChecks] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState("");

  const save = async (name: string): Promise<void> => {
    setBusy(true);
    setError(null);
    setNotice("");
    try {
      const saved = await request<{ items: Policy[] }>(`${base}/pull-merge-policy`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ branch: name, required_approvals: approvals, require_checks: checks }),
      });
      setNotice(`Saved: ${saved.items.length} branch requirement${saved.items.length === 1 ? "" : "s"} configured.`);
      setBranch("");
      state.reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save the requirements");
    } finally {
      setBusy(false);
    }
  };

  const remove = async (name: string): Promise<void> => {
    setBusy(true);
    setError(null);
    setNotice("");
    try {
      await request(`${base}/pull-merge-policy?branch=${encodeURIComponent(name)}`, { method: "DELETE" });
      setNotice(`Removed requirements from ${name}.`);
      setRemoving(null);
      state.reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not remove the requirements");
      setRemoving(null);
    } finally {
      setBusy(false);
    }
  };

  const canManage = state.data?.can_manage === true;

  return (
    <section className="merge-requirements" aria-label="Merge requirements">
      <div className="merge-requirements-heading">
        <div>
          <h3>Merge requirements</h3>
          <p className="small muted">
            Approvals and checks a pull request must satisfy before it can be merged.
          </p>
        </div>
        <LiveStatus {...state} />
      </div>
      <ErrorBanner message={error ?? state.error} />

      {state.data && state.data.items.length > 0 ? (
        <ul className="merge-requirement-list">
          {state.data.items.map((policy) => (
            <li key={policy.branch}>
              <div className="merge-requirement-detail">
                <code>{policy.branch}</code>
                <p className="small muted">
                  {policy.required_approvals === 0
                    ? "No approvals required"
                    : `${policy.required_approvals} approval${policy.required_approvals === 1 ? "" : "s"} required`}
                  {policy.require_checks ? " · successful checks required" : ""}
                </p>
              </div>
              {canManage ? (
                <button type="button" className="ghost small" disabled={busy} onClick={() => setRemoving(policy.branch)}>
                  Remove
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : (
        <p className="small muted">
          {state.loading ? "Loading merge requirements…" : "No merge requirements configured. Pull requests merge without review."}
        </p>
      )}

      {canManage ? (
        <form
          className="merge-requirement-form"
          onSubmit={(event) => {
            event.preventDefault();
            if (branch.trim()) void save(branch.trim());
          }}
        >
          <div className="stack-tight">
            <label htmlFor="merge-policy-branch">Branch</label>
            <input
              id="merge-policy-branch"
              value={branch}
              onChange={(event) => setBranch(event.target.value)}
              placeholder="main"
              maxLength={255}
              autoComplete="off"
              spellCheck={false}
            />
          </div>
          <div className="stack-tight">
            <label htmlFor="merge-policy-approvals">Approvals required</label>
            <select
              id="merge-policy-approvals"
              value={approvals}
              onChange={(event) => setApprovals(Number(event.target.value))}
            >
              {Array.from({ length: MAX_APPROVALS + 1 }, (_, count) => (
                <option key={count} value={count}>
                  {count === 0 ? "None" : count}
                </option>
              ))}
            </select>
          </div>
          <Switch
            checked={checks}
            onChange={setChecks}
            label="Require successful checks"
            hint="Every check on the head commit must pass. Pending does not count as a pass."
          />
          <button type="submit" disabled={busy || !branch.trim()}>
            {busy ? "Saving…" : "Save requirements"}
          </button>
        </form>
      ) : null}

      {removing ? (
        <div className="merge-requirement-confirm" role="region" aria-label="Confirm removal">
          <p>
            Remove requirements from <strong>{removing}</strong>? Pull requests into it will merge without
            review again.
          </p>
          <div className="row wrap">
            <button type="button" className="danger" disabled={busy} onClick={() => void remove(removing)}>
              Remove requirements
            </button>
            <button type="button" className="ghost" disabled={busy} onClick={() => setRemoving(null)}>
              Cancel
            </button>
          </div>
        </div>
      ) : null}
      <p className="small" role="status">
        {notice}
      </p>
    </section>
  );
}

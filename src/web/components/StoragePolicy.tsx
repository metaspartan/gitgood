import { useState } from "react";
import { request } from "../api.ts";
import { useLive } from "../use-live.ts";
import { parseQuotaInput } from "../quota-input.ts";
import { ErrorBanner, formatBytes } from "../components.tsx";

export function StoragePolicy() {
  const state = useLive(signal => request<{ bytes: number; source: string }>("/api/admin/storage-policy", { signal }), []);
  const [draft, setDraft] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [notice, setNotice] = useState("");
  const save = async () => {
    setBusy(true); setError(null);
    try {
      const value = parseQuotaInput(draft ?? String(state.data?.bytes ?? 0));
      if (value === null) throw new Error("Enter 0 for unlimited or a whole number of bytes.");
      await request("/api/admin/storage-policy", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ default_repo_quota_bytes: value }) });
      setDraft(null); setConfirm(false); state.reload(); setNotice("Default quota saved. Existing explicit repository limits are unchanged.");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Save failed"); }
    finally { setBusy(false); }
  };
  return <section className="card" aria-label="Default repository storage policy">
    <h2>Default repository quota</h2>
    <ErrorBanner message={error ?? state.error} />
    <p><strong>{state.data ? state.data.bytes === 0 ? "Unlimited" : formatBytes(state.data.bytes) : "Loading…"}</strong> <span className="small faint">{state.data ? `· ${state.data.source}` : ""}</span></p>
    <p className="muted small">Applies to existing and new repositories that inherit the instance default. Unlimited means no configured repository quota—not unlimited disk space. Git LFS retains its separate per-object transfer limit; this is not an aggregate Git+LFS quota.</p>
    <form onSubmit={event => { event.preventDefault(); setConfirm(true); setNotice(""); }}>
      <label htmlFor="default-repo-quota">Default quota in bytes · 0 means unlimited</label>
      <div className="row wrap" style={{ gap: 12, marginTop: 10 }}><input id="default-repo-quota" inputMode="numeric" value={draft ?? String(state.data?.bytes ?? 0)} disabled={!state.data || busy} onChange={event => { setDraft(event.target.value); setConfirm(false); }} style={{ maxWidth: 360 }} /><button type="submit" disabled={!state.data || busy}>Review change</button></div>
    </form>
    {confirm ? <div className="workflow-confirm"><p>Apply this default immediately? Lowering it can block pushes to repositories already above the limit. No data is deleted and explicit per-repository quotas are preserved.</p><div className="row wrap"><button type="button" disabled={busy} onClick={() => void save()}>Save default quota</button><button type="button" className="ghost" disabled={busy} onClick={() => setConfirm(false)}>Cancel</button></div></div> : null}
    <p className="small" role="status">{notice}</p>
  </section>;
}

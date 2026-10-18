import { Link } from "../router.tsx";
import { LiveStatus } from "../components/LiveStatus.tsx";
import { useLive } from "../use-live.ts";
import { useState, type ReactNode } from "react";
import { useSession } from "../App.tsx";
import { api } from "../api.ts";
import { ErrorBanner, Spinner } from "../components.tsx";

const labels = { local: "Local disk", nas: "Network storage", "google-drive": "Google Drive" };

export function BackupsPage(): ReactNode {
  const { user } = useSession();
  const state = useLive((signal) => user?.is_admin ? api.backups(signal) : Promise.resolve(null), [user?.id]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState("");
  if (!user?.is_admin) return <div className="card"><h2>Administrator access required</h2><p>Sign in with an instance administrator account to manage backups.</p></div>;
  const start = async () => {
    setBusy(true);
    setError(null);
    try { await api.startBackup(selected); setSelected(""); state.reload(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Backup could not start"); }
    finally { setBusy(false); }
  };
  return (
    <div className="backup-page">
      <header className="backup-heading">
        <div><p className="backup-eyebrow">INSTANCE ADMINISTRATION</p><h1>Backups</h1><p className="muted">Protect your repositories. Keep a recovery copy outside this instance.</p></div>
        <LiveStatus {...state} />
      </header>
      <nav className="tabs" aria-label="Administration"><Link to="/admin/backups" className="active" ariaCurrent="page">Backups</Link><Link to="/admin/configuration">Configuration</Link></nav>
      <ErrorBanner message={error ?? state.error} />
      <div className="backup-layout">
        <section className="backup-main">


          <div className="card"><div className="card-head"><h2>Storage destinations</h2><span className="badge">{state.data?.destinations.length ?? 0} configured</span></div>
            <p className="muted small">Choose where to create a new backup. Existing snapshots are never overwritten.</p>
            {state.loading && !state.data ? <Spinner label="Loading destinations" /> : null}
            {state.data?.destinations.map(d => (
              <div className="backup-destination" key={d.id}>
                <span className="backup-storage-icon" aria-hidden="true">{d.kind === "google-drive" ? "↗" : "▤"}</span>
                <div className="backup-destination-copy"><h3>{d.name}</h3><p>{labels[d.kind]}</p><span className="faint small">Configured · connection not pre-tested</span></div>
                <button type="button" disabled={busy || state.data?.active} onClick={() => setSelected(d.id)}>Back up here</button>
              </div>
            ))}
            {state.data && !state.data.destinations.length ? <div className="backup-empty"><h3>Add your first destination</h3><p>Configure a local directory, mounted NAS, or an authorized Google Drive rclone remote on the server. Credentials never pass through this page.</p><code>GITGOOD_BACKUP_DESTINATIONS</code></div> : null}
            {selected ? <div className="backup-confirm" role="region" aria-label="Confirm backup"><p>Create a backup to <strong>{state.data?.destinations.find(d => d.id === selected)?.name}</strong>? This copies instance data and may consume substantial disk space or cloud storage.</p><div className="row wrap"><button type="button" className="primary" disabled={busy || state.data?.active} onClick={() => void start()}>{busy ? "Starting…" : "Create backup"}</button><button type="button" className="ghost" disabled={busy} onClick={() => setSelected("")}>Cancel</button></div></div> : null}
          </div>
          <div className="card"><div className="card-head"><h2>Recent activity</h2><span className="faint small">This server session</span></div>
            <div aria-live="polite">{state.data?.active ? <p className="backup-running">Backup in progress. You can leave this page.</p> : null}</div>
            {state.data?.jobs.map(job => <div className="backup-job" key={job.id}><div><strong>{state.data?.destinations.find(d => d.id === job.destination)?.name ?? job.destination}</strong><p className="faint small">{new Date(job.started).toLocaleString()}</p><code>{job.id}</code>{job.state === "failed" ? <p className="small">Backup or transfer failed. Check storage permissions, available space and remote configuration. Partial files are retained for inspection.</p> : null}</div><span className={`badge backup-state-${job.state}`}>{job.state}</span></div>)}
            {!state.data?.jobs.length ? <p className="backup-empty small faint">No backups started during this server session.</p> : null}
          </div>
        </section>
        <aside className="backup-guide card"><p className="backup-eyebrow">RECOVERY CHECKLIST</p><h2>A copy is only the first step</h2><ul><li>Pause repository and asset writes for a consistent recovery point.</li><li>Keep a copy off this machine.</li><li>Protect backups like passwords: they include private repositories and credential data.</li><li>Test restoration on a separate instance.</li></ul><hr /><details className="backup-help"><summary>Destination setup & limitations</summary><h3>Supported destinations</h3><p><strong>Local & NAS</strong><br />A server-side directory or mounted SMB/NFS share.</p><p><strong>Google Drive</strong><br />A pre-authorized rclone remote. Copies are checked after transfer; local staging is retained.</p><p className="small faint">Manual backups only. No scheduling or automatic retention yet. See DEPLOYMENT.md for setup and recovery instructions.</p></details></aside>
      </div>
    </div>
  );
}

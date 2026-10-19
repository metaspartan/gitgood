import { useState, type ReactNode } from "react";
import "./Admin.css";
import "./Backups.css";
import { api } from "../api.ts";
import { copyText } from "../clipboard.ts";
import { EmptyState, ErrorBanner, formatBytes, timeAgo } from "../components.tsx";
import { Icon } from "../components/Icons.tsx";
import type { BackupDestinationInfo, BackupDestinationInput, BackupJobInfo, BackupKind, BackupSchedule, GoogleDriveAccount } from "../types.ts";
import { GoogleDrivePanel } from "../components/GoogleDrivePanel.tsx";
import { useLive } from "../use-live.ts";

const KIND_LABELS: Record<BackupKind, string> = { local: "Local folder", nas: "NAS / network mount", "google-drive": "Google Drive", rclone: "rclone remote (advanced)" };
const KIND_PLACEHOLDERS: Record<BackupKind, string> = { local: "/var/backups/gitgood", nas: "/mnt/nas/gitgood", "google-drive": "GitGood Backups", rclone: "s3:bucket/gitgood" };
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export function shortJobId(id: string): string {
  return id.replace(/^backup-/, "").slice(0, 8);
}

export function slugify(name: string): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
  return /^[a-z]/.test(slug) ? slug : `backup-${slug}`.slice(0, 40).replace(/-+$/, "");
}

export function scheduleSummary(destination: Pick<BackupDestinationInput, "schedule" | "hour" | "weekday" | "keep">): string {
  const time = `${String(destination.hour).padStart(2, "0")}:00 UTC`;
  const when = destination.schedule === "manual" ? "Manual only" : destination.schedule === "daily" ? `Daily at ${time}` : `${WEEKDAYS[destination.weekday]}s at ${time}`;
  return `${when} · ${destination.keep === 0 ? "keeps every copy" : `keeps the latest ${destination.keep}`}`;
}

function localHourHint(hour: number): string {
  const date = new Date(Date.UTC(2026, 0, 5, hour));
  return date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

function duration(job: BackupJobInfo): string {
  if (!job.finished_at) return "–";
  const seconds = Math.max(1, Math.round((job.finished_at - job.started_at) / 1000));
  return seconds < 90 ? `${seconds}s` : `${Math.round(seconds / 60)}m`;
}

function StateBadge({ state }: { state: BackupJobInfo["state"] }): ReactNode {
  const label = state === "running" ? "Running" : state === "completed" ? "Completed" : "Failed";
  return <span className={`backup-state is-${state}`}><span className="runner-dot" aria-hidden="true" />{label}</span>;
}

const EMPTY_FORM: BackupDestinationInput = { id: "", name: "", kind: "local", target: "", schedule: "daily", hour: 3, weekday: 0, keep: 7 };

function DestinationForm({ initial, editing, accounts, onSaved, onCancel }: {
  initial: BackupDestinationInput;
  editing: BackupDestinationInfo | null;
  accounts: GoogleDriveAccount[];
  onSaved: () => void;
  onCancel: () => void;
}): ReactNode {
  const [form, setForm] = useState<BackupDestinationInput>(initial);
  const [idTouched, setIdTouched] = useState(editing !== null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const managed = editing?.source === "environment";
  const set = <K extends keyof BackupDestinationInput>(key: K, value: BackupDestinationInput[K]) => setForm((current) => ({ ...current, [key]: value }));

  return (
    <form
      className="card admin-card backup-form"
      onSubmit={async (event) => {
        event.preventDefault();
        setBusy(true);
        setError(null);
        try {
          if (editing) {
            const { id: _id, ...rest } = form;
            void _id;
            await api.updateBackupDestination(editing.id, managed ? { schedule: rest.schedule, hour: rest.hour, weekday: rest.weekday, keep: rest.keep } : rest);
          } else {
            await api.createBackupDestination(form);
          }
          onSaved();
        } catch (cause) {
          setError(cause instanceof Error ? cause.message : "Could not save the destination");
          setBusy(false);
        }
      }}
    >
      <h2 className="admin-card-title">{editing ? `Edit ${editing.name}` : "New destination"}</h2>
      {managed ? <p className="small muted">This destination is defined in the server environment. Its location is managed there; you can change its schedule and retention here.</p> : null}
      <ErrorBanner message={error} />
      <div className="backup-form-grid">
        <label>
          Name
          <input required maxLength={80} disabled={managed} value={form.name} placeholder="Offsite NAS" onChange={(e) => { set("name", e.target.value); if (!idTouched) set("id", slugify(e.target.value)); }} />
        </label>
        <label>
          ID
          <input required maxLength={40} pattern="[a-z][a-z0-9-]*" disabled={editing !== null} value={form.id} className="mono" onChange={(e) => { setIdTouched(true); set("id", e.target.value); }} />
        </label>
        <label>
          Type
          <select
            value={form.kind}
            disabled={managed}
            onChange={(e) => {
              const kind = e.target.value as BackupKind;
              setForm((current) => ({
                ...current,
                kind,
                target: kind === "google-drive" && !current.target ? KIND_PLACEHOLDERS["google-drive"] : current.target,
                account_id: kind === "google-drive" ? current.account_id ?? accounts[0]?.id ?? null : null,
              }));
            }}
          >
            {(Object.keys(KIND_LABELS) as BackupKind[]).map((kind) => <option key={kind} value={kind}>{KIND_LABELS[kind]}</option>)}
          </select>
        </label>
        {!managed && form.kind === "google-drive" ? (
          <label>
            Google account
            {accounts.length ? (
              <select required value={form.account_id ?? ""} onChange={(e) => set("account_id", Number(e.target.value))}>
                {accounts.map((account) => <option key={account.id} value={account.id}>{account.email}</option>)}
              </select>
            ) : (
              <span className="small danger">Sign in with Google in the Google Drive section first.</span>
            )}
          </label>
        ) : null}
        {managed ? null : (
          <label className="backup-form-wide">
            {form.kind === "google-drive" ? "Folder in My Drive" : form.kind === "rclone" ? "rclone remote and folder" : "Absolute path on the server"}
            <input required maxLength={1024} value={form.target} className="mono" placeholder={KIND_PLACEHOLDERS[form.kind]} onChange={(e) => set("target", e.target.value)} />
            <span className="small faint">
              {form.kind === "google-drive"
                ? "Created in the account’s My Drive if it does not exist. Each backup is uploaded as one .tar archive and checked after upload."
                : form.kind === "rclone"
                ? "For S3, B2, SFTP and other rclone remotes configured on the server with rclone config. Backups are staged locally, copied, then verified."
                : form.kind === "nas"
                  ? "The share must already be mounted. GitGood will not create the mount point."
                  : "Created if missing. Must be outside GitGood's own data directories."}
            </span>
          </label>
        )}
        <label>
          Schedule
          <select value={form.schedule} onChange={(e) => set("schedule", e.target.value as BackupSchedule)}>
            <option value="manual">Manual only</option>
            <option value="daily">Daily</option>
            <option value="weekly">Weekly</option>
          </select>
        </label>
        {form.schedule === "weekly" ? (
          <label>
            Day
            <select value={form.weekday} onChange={(e) => set("weekday", Number(e.target.value))}>
              {WEEKDAYS.map((day, index) => <option key={day} value={index}>{day}</option>)}
            </select>
          </label>
        ) : null}
        {form.schedule === "manual" ? null : (
          <label>
            Time (UTC)
            <select value={form.hour} onChange={(e) => set("hour", Number(e.target.value))}>
              {Array.from({ length: 24 }, (_, hour) => <option key={hour} value={hour}>{`${String(hour).padStart(2, "0")}:00 UTC (${localHourHint(hour)} local)`}</option>)}
            </select>
          </label>
        )}
        <label>
          Keep
          <input type="number" min={0} max={365} value={form.keep} onChange={(e) => set("keep", Math.max(0, Math.min(365, Number(e.target.value) || 0)))} />
          <span className="small faint">Older copies made by GitGood are deleted after each successful backup. 0 keeps everything.</span>
        </label>
      </div>
      <div className="row">
        <button type="submit" className="primary" disabled={busy}>{busy ? "Saving…" : editing ? "Save changes" : "Add destination"}</button>
        <button type="button" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}

function DestinationCard({ destination, active, onEdit, onChanged, onError }: {
  destination: BackupDestinationInfo;
  active: boolean;
  onEdit: () => void;
  onChanged: () => void;
  onError: (message: string) => void;
}): ReactNode {
  const [test, setTest] = useState<{ ok: boolean; message: string; free_bytes: number | null } | null>(null);
  const [testing, setTesting] = useState(false);
  const run = async (action: () => Promise<unknown>): Promise<void> => {
    try {
      await action();
      onChanged();
    } catch (cause) {
      onError(cause instanceof Error ? cause.message : "That did not work");
    }
  };

  return (
    <li className="backup-destination">
      <div className="backup-destination-icon"><Icon name={destination.kind === "google-drive" || destination.kind === "rclone" ? "download" : "database"} /></div>
      <div className="backup-destination-body">
        <div className="backup-destination-title">
          <strong>{destination.name}</strong>
          <span className="badge">{KIND_LABELS[destination.kind]}</span>
          {destination.source === "environment" ? <span className="badge">Server environment</span> : null}
        </div>
        {destination.kind === "google-drive" ? (
          <div className="small muted backup-target">{destination.account_email ?? "Disconnected account"} · My Drive / {destination.target}</div>
        ) : destination.target ? <div className="small mono muted backup-target">{destination.target}</div> : null}
        <div className="small muted">{scheduleSummary(destination)}{destination.next_run_at ? ` · next ${new Date(destination.next_run_at).toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" })}` : ""}</div>
        <div className="small">
          {destination.last_job ? (
            <>
              <StateBadge state={destination.last_job.state} /> <span className="muted">{timeAgo(destination.last_job.started_at)}</span>
              {destination.last_job.error ? <span className="danger"> · {destination.last_job.error}</span> : null}
            </>
          ) : <span className="faint">Never backed up</span>}
        </div>
        {test ? (
          <div className={`backup-test ${test.ok ? "is-ok" : "is-bad"}`} role="status">
            <Icon name={test.ok ? "check" : "alert"} /> {test.message}{test.free_bytes !== null ? ` ${formatBytes(test.free_bytes)} free.` : ""}
          </div>
        ) : null}
      </div>
      <div className="backup-destination-actions">
        <button type="button" className="primary small" disabled={active} onClick={() => void run(() => api.startBackup(destination.id))}>Back up now</button>
        <button
          type="button"
          className="small"
          disabled={testing}
          onClick={async () => {
            setTesting(true);
            setTest(null);
            try {
              setTest(await api.testBackupDestination(destination.id));
            } catch (cause) {
              setTest({ ok: false, message: cause instanceof Error ? cause.message : "Test failed", free_bytes: null });
            } finally {
              setTesting(false);
            }
          }}
        >
          {testing ? "Testing…" : "Test"}
        </button>
        <button type="button" className="small" onClick={onEdit}>Edit</button>
        {destination.source === "admin" ? (
          <button type="button" className="small danger" onClick={() => { if (window.confirm(`Remove ${destination.name}? Existing backup files are not deleted.`)) void run(() => api.deleteBackupDestination(destination.id)); }}>Remove</button>
        ) : null}
      </div>
    </li>
  );
}

export function BackupsPage(): ReactNode {
  const state = useLive((signal) => api.backups(signal), [], 5000);
  const [formFor, setFormFor] = useState<BackupDestinationInfo | "new" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const data = state.data;
  const active = data?.active ?? false;
  const latestOk = data?.jobs.find((job) => job.state === "completed");

  return (
    <>
      <div className="admin-head">
        <h1 className="admin-title">Backups</h1>
        <span className="spacer" />
        {formFor === null ? (
          <button type="button" className="btn-primary" disabled={(data?.destinations.length ?? 0) >= (data?.max_destinations ?? 12)} onClick={() => setFormFor("new")}>
            <Icon name="plus" /> New destination
          </button>
        ) : null}
      </div>
      <p className="muted admin-lede">
        Each backup captures the database, every repository, Git LFS objects and release assets. Schedule copies to a local disk, a NAS or your Google Drive, and keep a set number of them.
      </p>
      <div className="admin-stats backup-stats">
        <div className="admin-stat"><div className="admin-stat-label">Last successful backup</div><div className="admin-stat-value">{latestOk ? timeAgo(latestOk.finished_at ?? latestOk.started_at) : "–"}</div><div className="admin-stat-sub">{latestOk ? `${latestOk.destination_name} · ${latestOk.bytes ? formatBytes(latestOk.bytes) : "size unknown"}` : "\u00a0"}</div></div>
        <div className="admin-stat"><div className="admin-stat-label">Destinations</div><div className="admin-stat-value">{data?.destinations.length ?? "–"}</div><div className="admin-stat-sub">{data ? `${data.destinations.filter((d) => d.schedule !== "manual").length} scheduled` : "\u00a0"}</div></div>
        <div className="admin-stat"><div className="admin-stat-label">Status</div><div className="admin-stat-value backup-status-value">{active ? "Backing up" : "Idle"}</div><div className="admin-stat-sub">{data ? "Schedules use UTC" : "\u00a0"}</div></div>
      </div>
      <ErrorBanner message={error ?? state.error} />
      {formFor !== null ? (
        <DestinationForm
          key={formFor === "new" ? "new" : formFor.id}
          initial={formFor === "new" ? EMPTY_FORM : { id: formFor.id, name: formFor.name, kind: formFor.kind, target: formFor.target ?? "", account_id: formFor.account_id ?? null, schedule: formFor.schedule, hour: formFor.hour, weekday: formFor.weekday, keep: formFor.keep }}
          editing={formFor === "new" ? null : formFor}
          accounts={data?.google.accounts ?? []}
          onCancel={() => setFormFor(null)}
          onSaved={() => { setFormFor(null); state.reload(); }}
        />
      ) : null}
      <section className="card admin-card" aria-labelledby="backup-destinations-title">
        <h2 id="backup-destinations-title" className="admin-card-title">Destinations</h2>
        {data && data.destinations.length === 0 ? (
          <EmptyState title="No destinations yet" hint="Add a local folder or a mounted NAS share, or sign in with Google below to back up to Drive." />
        ) : (
          <ul className="backup-destinations" aria-busy={state.loading}>
            {(data?.destinations ?? []).map((destination) => (
              <DestinationCard
                key={destination.id}
                destination={destination}
                active={active}
                onEdit={() => setFormFor(destination)}
                onChanged={() => { setError(null); state.reload(); }}
                onError={setError}
              />
            ))}
            {!data ? <li className="backup-destination"><span className="skeleton-text" style={{ width: "50%" }} /></li> : null}
          </ul>
        )}
      </section>
      <GoogleDrivePanel state={data?.google} onChanged={state.reload} />
      <section className="card admin-card" aria-labelledby="backup-history-title">
        <h2 id="backup-history-title" className="admin-card-title">History</h2>
        {data && data.jobs.length === 0 ? <p className="small muted" style={{ margin: 0 }}>No backups have run yet.</p> : (
          <div className="admin-table-wrap">
            <table className="admin-table">
              <thead><tr><th>Started</th><th>Destination</th><th>Status</th><th className="num">Size</th><th className="hide-narrow">Duration</th><th className="hide-narrow">Location</th></tr></thead>
              <tbody>
                {(data?.jobs ?? []).map((job) => (
                  <tr key={job.id} className={job.pruned ? "is-pruned" : ""}>
                    <td className="small" title={new Date(job.started_at).toLocaleString()}>{timeAgo(job.started_at)}<div className="faint">{job.trigger === "scheduled" ? "Scheduled" : "Manual"}</div></td>
                    <td className="small">{job.destination_name}</td>
                    <td className="small"><StateBadge state={job.state} />{job.error ? <div className="danger">{job.error}</div> : null}{job.pruned ? <div className="faint">Removed by retention</div> : null}</td>
                    <td className="num small">{job.bytes ? formatBytes(job.bytes) : "–"}</td>
                    <td className="small muted hide-narrow">{duration(job)}</td>
                    <td className="small hide-narrow">
                      {job.location && !job.pruned && job.location.startsWith("https://drive.google.com/") ? (
                        <a className="small" href={job.location} target="_blank" rel="noopener noreferrer">Open in Drive <Icon name="external" /></a>
                      ) : job.location && !job.pruned ? (
                        <button type="button" className="ghost small mono backup-location" title={`Copy ${job.location}`} onClick={() => void copyText(job.location!)}>{shortJobId(job.id)} <Icon name="copy" /></button>
                      ) : "–"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      <section className="card admin-card" aria-labelledby="backup-restore-title">
        <h2 id="backup-restore-title" className="admin-card-title">Restoring</h2>
        <p className="small muted" style={{ margin: 0 }}>Restores replace live data, so they run from the command line with the server stopped. Check a backup first; it never touches live state:</p>
        <pre className="admin-code">{`bun tools/restore-check.ts --from <backup folder>
bun tools/admin.ts restore --from <backup folder> --dry-run
# stop GitGood, then:
bun tools/admin.ts restore --from <backup folder>`}</pre>
        <ul className="small muted backup-checklist">
          <li>Keep at least one destination off this machine.</li>
          <li>Backups contain private repositories and credential hashes; protect them like passwords.</li>
          <li>Rehearse a restore on a separate instance now and then.</li>
        </ul>
      </section>
    </>
  );
}

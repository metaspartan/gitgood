import { useEffect, useRef, useState, type ReactNode } from "react";
import { api } from "../api.ts";
import { copyText } from "../clipboard.ts";
import { ErrorBanner, timeAgo } from "../components.tsx";
import type { GoogleBackupState } from "../types.ts";
import { Icon } from "./Icons.tsx";

type Connect = { session: string; user_code: string; verification_url: string; expires_at: number; interval: number };

function GoogleMark(): ReactNode {
  return (
    <svg className="google-mark" viewBox="0 0 48 48" aria-hidden="true" focusable="false">
      <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z" />
      <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z" />
      <path fill="#FBBC05" d="M10.53 28.59A14.5 14.5 0 0 1 9.5 24c0-1.59.28-3.14.76-4.59l-7.98-6.19A23.94 23.94 0 0 0 0 24c0 3.77.9 7.35 2.56 10.78l7.97-6.19z" />
      <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z" />
    </svg>
  );
}

function ClientSetup({ onSaved }: { onSaved: (state: GoogleBackupState) => void }): ReactNode {
  const [clientId, setClientId] = useState("");
  const [secret, setSecret] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <div className="google-setup">
      <p className="small">
        Google needs to know which app is asking for access. Create one OAuth client for this GitGood server. This is a one-time setup and takes about two minutes:
      </p>
      <ol className="small google-steps">
        <li>Open <a href="https://console.cloud.google.com/apis/library/drive.googleapis.com" target="_blank" rel="noopener noreferrer">Google Cloud Console → Google Drive API</a> and click <strong>Enable</strong>.</li>
        <li>Under <a href="https://console.cloud.google.com/auth/branding" target="_blank" rel="noopener noreferrer">Google Auth Platform</a>, fill in the app name and choose <strong>External</strong> or <strong>Internal</strong>. Under <strong>Audience</strong>, add your Google account as a test user, or publish the app.</li>
        <li>Under <a href="https://console.cloud.google.com/auth/clients" target="_blank" rel="noopener noreferrer">Clients</a>, create a client of type <strong>TVs and Limited Input devices</strong>, then paste its ID and secret below.</li>
      </ol>
      <ErrorBanner message={error} />
      <form
        className="google-client-form"
        onSubmit={async (event) => {
          event.preventDefault();
          setBusy(true);
          setError(null);
          try {
            onSaved(await api.saveGoogleClient(clientId.trim(), secret.trim()));
          } catch (cause) {
            setError(cause instanceof Error ? cause.message : "Could not save the client");
          } finally {
            setBusy(false);
          }
        }}
      >
        <label>Client ID<input required className="mono" value={clientId} placeholder="1234567890-abc.apps.googleusercontent.com" autoComplete="off" onChange={(e) => setClientId(e.target.value)} /></label>
        <label>Client secret<input required type="password" className="mono" value={secret} placeholder="GOCSPX-…" autoComplete="off" onChange={(e) => setSecret(e.target.value)} /></label>
        <div className="row"><button type="submit" className="primary" disabled={busy}>{busy ? "Saving…" : "Save client"}</button></div>
      </form>
      <p className="small faint">GitGood only asks for access to files it creates (the <code>drive.file</code> scope). It cannot see anything else in the Drive. The secret is stored encrypted.</p>
    </div>
  );
}

function ConnectDialog({ onDone }: { onDone: (connected: boolean) => void }): ReactNode {
  const [flow, setFlow] = useState<Connect | null>(null);
  const [status, setStatus] = useState<"starting" | "waiting" | "denied" | "expired" | "connected">("starting");
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [email, setEmail] = useState("");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    let session: string | null = null;
    const poll = (current: Connect, delay: number) => {
      timer.current = setTimeout(async () => {
        if (!alive.current) return;
        try {
          const result = await api.pollGoogleConnect(current.session);
          if (!alive.current) return;
          if (result.state === "pending") return poll(current, Math.max(1, result.retry_after ?? current.interval) * 1000);
          session = null;
          if (result.state === "connected") {
            setEmail(result.account?.email ?? "");
            setStatus("connected");
          } else setStatus(result.state);
        } catch (cause) {
          if (alive.current) setError(cause instanceof Error ? cause.message : "Sign-in failed");
        }
      }, delay);
    };
    api.startGoogleConnect().then(
      (started) => {
        if (!alive.current) return void api.cancelGoogleConnect(started.session).catch(() => undefined);
        session = started.session;
        setFlow(started);
        setStatus("waiting");
        poll(started, started.interval * 1000);
      },
      (cause: unknown) => setError(cause instanceof Error ? cause.message : "Could not start sign-in"),
    );
    return () => {
      alive.current = false;
      if (timer.current) clearTimeout(timer.current);
      if (session) void api.cancelGoogleConnect(session).catch(() => undefined);
    };
  }, []);

  return (
    <div className="finder-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onDone(status === "connected")}>
      <div className="google-dialog" role="dialog" aria-modal="true" aria-labelledby="google-connect-title" onKeyDown={(event) => event.key === "Escape" && onDone(status === "connected")}>
        <header>
          <GoogleMark />
          <h2 id="google-connect-title">Sign in with Google</h2>
        </header>
        <ErrorBanner message={error} />
        {status === "connected" ? (
          <div className="google-dialog-body google-done" role="status">
            <Icon name="check" />
            <p><strong>Connected{email ? ` as ${email}` : ""}.</strong></p>
            <p className="small muted">You can now add a Google Drive destination with this account.</p>
            <button type="button" className="primary" autoFocus onClick={() => onDone(true)}>Done</button>
          </div>
        ) : status === "denied" || status === "expired" ? (
          <div className="google-dialog-body" role="status">
            <p>{status === "denied" ? "Access was not granted." : "The code expired before sign-in finished."}</p>
            <button type="button" onClick={() => onDone(false)}>Close</button>
          </div>
        ) : (
          <div className="google-dialog-body">
            <p className="small">1. Open Google’s sign-in page:</p>
            <a className="btn-primary google-open" href={flow?.verification_url ?? "https://www.google.com/device"} target="_blank" rel="noopener noreferrer" aria-disabled={!flow}>
              Open {(flow?.verification_url ?? "https://www.google.com/device").replace(/^https:\/\//, "")} <Icon name="external" />
            </a>
            <p className="small">2. Enter this code and choose the account to store backups in:</p>
            <button
              type="button"
              className="google-code mono"
              aria-label={flow ? `Copy code ${flow.user_code}` : "Loading code"}
              disabled={!flow}
              onClick={() => {
                if (!flow) return;
                void copyText(flow.user_code);
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              }}
            >
              {flow?.user_code ?? "\u00a0\u00a0\u00a0\u00a0-\u00a0\u00a0\u00a0\u00a0"}
              <span className="small muted">{copied ? "Copied" : "Copy"}</span>
            </button>
            <p className="small muted google-wait" aria-live="polite">
              <span className="spinner" aria-hidden="true" /> {flow ? `Waiting for you to approve… the code works for ${Math.max(1, Math.round((flow.expires_at - Date.now()) / 60_000))} minutes.` : "Contacting Google…"}
            </p>
            <div className="row"><button type="button" onClick={() => onDone(false)}>Cancel</button></div>
          </div>
        )}
      </div>
    </div>
  );
}

export function GoogleDrivePanel({ state, onChanged }: { state: GoogleBackupState | undefined; onChanged: () => void }): ReactNode {
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editingClient, setEditingClient] = useState(false);
  if (!state) return null;
  const showSetup = !state.client.configured || editingClient;

  return (
    <section className="card admin-card google-panel" aria-labelledby="google-drive-title">
      <div className="google-panel-head">
        <GoogleMark />
        <h2 id="google-drive-title" className="admin-card-title">Google Drive</h2>
        <span className="spacer" />
        {state.client.configured && !editingClient ? (
          <button type="button" className="btn-primary google-signin" onClick={() => setConnecting(true)}>
            <GoogleMark /> {state.accounts.length ? "Connect another account" : "Sign in with Google"}
          </button>
        ) : null}
      </div>
      <ErrorBanner message={error} />
      {showSetup ? (
        <ClientSetup onSaved={() => { setEditingClient(false); onChanged(); }} />
      ) : (
        <>
          {state.accounts.length === 0 ? (
            <p className="small muted" style={{ margin: 0 }}>Sign in with the Google account you want backups stored in. GitGood creates a folder there and uploads each backup as a single archive.</p>
          ) : (
            <ul className="google-accounts">
              {state.accounts.map((account) => (
                <li key={account.id}>
                  <span className="google-avatar" aria-hidden="true">{(account.display_name || account.email).slice(0, 1).toUpperCase()}</span>
                  <div className="google-account-text">
                    <strong>{account.email}</strong>
                    <div className="small faint">Connected {timeAgo(account.created_at)} · {account.destinations === 0 ? "not used yet" : `${account.destinations} destination${account.destinations === 1 ? "" : "s"}`}</div>
                  </div>
                  <button
                    type="button"
                    className="small danger"
                    disabled={account.destinations > 0}
                    title={account.destinations > 0 ? "Remove the destinations that use this account first" : undefined}
                    onClick={async () => {
                      if (!window.confirm(`Disconnect ${account.email}? GitGood’s access is revoked; files already in Drive stay there.`)) return;
                      try {
                        await api.disconnectGoogleAccount(account.id);
                        onChanged();
                      } catch (cause) {
                        setError(cause instanceof Error ? cause.message : "Could not disconnect");
                      }
                    }}
                  >
                    Disconnect
                  </button>
                </li>
              ))}
            </ul>
          )}
          <p className="small faint google-client-line">
            OAuth client {state.client.client_id_hint}
            {state.client.source === "environment" ? " (set by the server environment)" : (
              <>
                {" · "}
                <button type="button" className="link-button" onClick={() => setEditingClient(true)}>Change</button>
                {state.accounts.length === 0 ? (
                  <>
                    {" · "}
                    <button type="button" className="link-button" onClick={async () => { try { await api.removeGoogleClient(); onChanged(); } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not remove"); } }}>Remove</button>
                  </>
                ) : null}
              </>
            )}
          </p>
        </>
      )}
      {connecting ? <ConnectDialog onDone={(connected) => { setConnecting(false); if (connected) onChanged(); }} /> : null}
    </section>
  );
}

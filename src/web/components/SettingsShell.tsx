import { useState, type ReactNode } from "react";
import { api } from "../api.ts";
import { Avatar, EmptyState, ErrorBanner, timeAgo, useAsync } from "../components.tsx";
import { Link } from "../router.tsx";
import type { User } from "../types.ts";
import { Icon, type IconName } from "./Icons.tsx";

export type SettingsSection = "profile" | "appearance" | "security" | "sessions" | "keys" | "tokens";

const SECTIONS: { id: SettingsSection; label: string; icon: IconName; group: "Account" | "Access" }[] = [
  { id: "profile", label: "Public profile", icon: "eye", group: "Account" },
  { id: "appearance", label: "Appearance", icon: "gear", group: "Account" },
  { id: "security", label: "Password and authentication", icon: "lock", group: "Access" },
  { id: "sessions", label: "Sessions", icon: "device", group: "Access" },
  { id: "keys", label: "SSH keys", icon: "key", group: "Access" },
  { id: "tokens", label: "Personal access tokens", icon: "code", group: "Access" },
];

export function settingsSectionFrom(location: string): SettingsSection {
  const second = location.split("?")[0]!.split("/").filter(Boolean)[1];
  return SECTIONS.some((item) => item.id === second) ? (second as SettingsSection) : "profile";
}

export function SettingsNav({ section, user }: { section: SettingsSection; user: User }): ReactNode {
  const groups = ["Account", "Access"] as const;
  return (
    <aside className="settings-nav">
      <div className="settings-identity">
        <Avatar user={user} size="lg" />
        <div className="settings-identity-text">
          <strong>{user.display_name}</strong>
          <span className="small muted">Your personal account</span>
        </div>
        <Link to={`/${user.username}`} className="btn-secondary small settings-profile-link">Go to your profile</Link>
      </div>
      <nav aria-label="Settings">
        {groups.map((group) => (
          <div key={group} className="settings-nav-group">
            {group === "Access" ? <div className="settings-nav-heading">Access</div> : null}
            {SECTIONS.filter((item) => item.group === group).map((item) => (
              <Link
                key={item.id}
                to={item.id === "profile" ? "/settings" : `/settings/${item.id}`}
                className={section === item.id ? "active" : ""}
                {...(section === item.id ? { ariaCurrent: "page" as const } : {})}
              >
                <Icon name={item.icon} />
                <span>{item.label}</span>
              </Link>
            ))}
          </div>
        ))}
      </nav>
    </aside>
  );
}

export function SshKeysPanel(): ReactNode {
  const keys = useAsync(() => api.sshKeys(), []);
  const [title, setTitle] = useState("");
  const [publicKey, setPublicKey] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(false);

  const add = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await api.addSshKey({ title: title.trim() || undefined, public_key: publicKey.trim() } as { title?: string; public_key: string });
      setTitle("");
      setPublicKey("");
      setAdding(false);
      keys.reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not add the key");
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id: number, label: string): Promise<void> => {
    if (!window.confirm(`Delete the SSH key "${label}"? Anything using it will lose access.`)) return;
    setError(null);
    try {
      await api.removeSshKey(id);
      keys.reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not delete the key");
    }
  };

  return (
    <section className="card" aria-labelledby="ssh-keys-title">
      <div className="settings-subhead">
        <h2 id="ssh-keys-title">SSH keys</h2>
        <button type="button" className="primary small" onClick={() => setAdding((value) => !value)}>
          New SSH key
        </button>
      </div>
      <p className="muted small">These keys can push to and pull from every repository you have access to. Remove any you no longer use.</p>
      <ErrorBanner message={error ?? keys.error} />
      {adding ? (
        <form
          className="stack ssh-key-form"
          onSubmit={(event) => {
            event.preventDefault();
            void add();
          }}
        >
          <label>
            Title
            <input value={title} maxLength={100} placeholder="Work laptop" onChange={(event) => setTitle(event.target.value)} />
          </label>
          <label>
            Key
            <textarea
              value={publicKey}
              required
              rows={5}
              spellCheck={false}
              className="mono"
              placeholder="Begins with ssh-ed25519, ssh-rsa, ecdsa-sha2-nistp256, sk-ssh-ed25519@openssh.com or sk-ecdsa-sha2-nistp256@openssh.com"
              onChange={(event) => setPublicKey(event.target.value)}
            />
          </label>
          <div className="row">
            <button type="submit" className="primary" disabled={busy || !publicKey.trim()}>{busy ? "Adding\u2026" : "Add SSH key"}</button>
            <button type="button" className="ghost" onClick={() => setAdding(false)}>Cancel</button>
          </div>
        </form>
      ) : null}
      {keys.loading && !keys.data ? (
        <ul className="ssh-key-list" aria-hidden="true"><li className="ssh-key-row"><span className="skeleton-text" style={{ width: "50%" }} /></li></ul>
      ) : (keys.data?.items.length ?? 0) === 0 ? (
        <EmptyState title="No SSH keys yet" hint="Add a public key to clone and push over SSH." />
      ) : (
        <ul className="ssh-key-list">
          {keys.data?.items.map((key) => (
            <li key={key.id} className="ssh-key-row">
              <Icon name="key" className="session-icon" />
              <div className="session-text">
                <div className="session-title">
                  <strong>{key.title}</strong>
                  <span className="badge">{key.algorithm}</span>
                </div>
                <div className="small mono muted">{key.fingerprint}</div>
                <div className="small faint">Added {timeAgo(key.created_at)}</div>
              </div>
              <button type="button" className="danger small" onClick={() => void remove(key.id, key.title)}>Delete</button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export function CommitEmailsPanel(): ReactNode {
  const emails = useAsync(() => api.commitEmails(), []);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const run = async (action: () => Promise<unknown>): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await action();
      emails.reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not update emails");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card" aria-labelledby="commit-emails-title">
      <div className="settings-subhead">
        <h2 id="commit-emails-title">Commit emails</h2>
      </div>
      <p className="muted small">
        Commits authored with any of these addresses count on your contribution graph. Your account email is always included. Emails are never shown publicly.
      </p>
      <ErrorBanner message={error ?? emails.error} />
      <ul className="ssh-key-list">
        <li className="ssh-key-row">
          <Icon name="check" className="session-icon" />
          <div className="session-text"><strong>{emails.data?.primary ?? "\u00a0"}</strong></div>
          <span className="badge">Account email</span>
        </li>
        {(emails.data?.items ?? []).map((email) => (
          <li key={email} className="ssh-key-row">
            <Icon name="commit" className="session-icon" />
            <div className="session-text"><span>{email}</span></div>
            <button type="button" className="danger small" disabled={busy} onClick={() => void run(() => api.removeCommitEmail(email))}>Remove</button>
          </li>
        ))}
      </ul>
      <form
        className="row commit-email-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (!draft.trim()) return;
          void run(async () => {
            await api.addCommitEmail(draft.trim());
            setDraft("");
          });
        }}
      >
        <input type="email" value={draft} placeholder="Add a commit email" aria-label="Commit email" onChange={(event) => setDraft(event.target.value)} />
        <button type="submit" disabled={busy || !draft.trim() || (emails.data ? emails.data.items.length >= emails.data.max : false)}>Add</button>
      </form>
    </section>
  );
}

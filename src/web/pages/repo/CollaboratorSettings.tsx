import { useState, type ReactNode } from "react";
import { api } from "../../api.ts";
import { useAsync } from "../../components.tsx";
import { Avatar, ErrorBanner } from "../../components.tsx";

function CollaboratorSettings({ owner, repo }: { owner: string; repo: string }): ReactNode {
  const state = useAsync(() => api.collaborators(owner, repo), [owner, repo]);
  const [username, setUsername] = useState("");
  const [permission, setPermission] = useState<"read" | "write">("write");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState("");

  const add = async () => {
    const name = username.trim();
    if (!name) return;
    setBusy(true); setError(null); setNotice("");
    try {
      await api.addCollaborator(owner, repo, name, permission);
      setNotice(`Gave ${name} ${permission} access.`);
      setUsername("");
      state.reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not add a collaborator");
    } finally { setBusy(false); }
  };

  const remove = async (name: string) => {
    setBusy(true); setError(null); setNotice("");
    try {
      await api.removeCollaborator(owner, repo, name);
      setNotice(`Removed ${name}.`);
      state.reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not remove a collaborator");
    } finally { setBusy(false); }
  };

  const items = state.data?.items ?? [];
  return (
    <section aria-labelledby="collaborators-heading">
      <h3 id="collaborators-heading">People with access</h3>
      <p className="muted small">
        Give someone read or write access to this repository without making them a member of an
        organisation. They sign in with their own account, and the same permissions apply to
        cloning, pushing and the web interface.
      </p>
      <ErrorBanner message={error ?? state.error} />
      {items.length > 0 ? (
        <ul className="collaborator-list">
          {items.map((person) => (
            <li key={person.user_id}>
              <Avatar user={person} />
              <div>
                <strong>{person.username}</strong>
                <span className="badge">{person.permission}</span>
              </div>
              {state.data?.can_manage ? (
                <button type="button" className="ghost small" disabled={busy} onClick={() => void remove(person.username)}>
                  Remove
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : (
        <p className="faint small">No collaborators yet. Only the owner, organisation members and administrators can reach this repository.</p>
      )}
      {state.data?.can_manage ? (
        <form
          className="collaborator-form"
          onSubmit={(event) => {
            event.preventDefault();
            void add();
          }}
        >
          <label htmlFor="collaborator-username">Username</label>
          <input
            id="collaborator-username"
            value={username}
            onChange={(event) => setUsername(event.target.value)}
            placeholder="someone"
            autoComplete="off"
            spellCheck={false}
            disabled={busy}
          />
          <label htmlFor="collaborator-permission">Permission</label>
          <select
            id="collaborator-permission"
            value={permission}
            onChange={(event) => setPermission(event.target.value as "read" | "write")}
            disabled={busy}
          >
            <option value="read">Read</option>
            <option value="write">Write</option>
          </select>
          <button type="submit" disabled={busy || !username.trim()}>
            {busy ? "Working…" : "Add person"}
          </button>
        </form>
      ) : null}
      <p className="small" role="status">{notice}</p>
    </section>
  );
}

export { CollaboratorSettings };

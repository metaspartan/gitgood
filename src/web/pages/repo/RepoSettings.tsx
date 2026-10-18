import "./RepoSettings.css";
import { BranchProtectionPanel } from "./BranchProtectionPanel.tsx";
import { MergeRequirementsPanel } from "./MergeRequirementsPanel.tsx";
import { TopicsPanel } from "./TopicsPanel.tsx";
import { CollaboratorSettings } from "./CollaboratorSettings.tsx";
import { useState, useEffect, type ReactNode } from "react";
import { api } from "../../api.ts";
import { ErrorBanner, useAsync } from "../../components.tsx";
import { Switch } from "../../components/Switch.tsx";
import { navigate } from "../../router.tsx";
import { PushPolicyPanel } from "./PushPolicyPanel.tsx";
import { WebhookManager } from "./WebhookManager.tsx";
import { ForkList } from "./ForkList.tsx";

export function RepoSettings({ owner, repo }: { owner: string; repo: string }): ReactNode {
  const detail = useAsync(() => api.repo(owner, repo), [owner, repo]);
  const [description, setDescription] = useState("");
  const [visibility, setVisibility] = useState("public");
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  useEffect(() => {
    if (detail.data) {
      setDescription(detail.data.description);
      setVisibility(detail.data.visibility);
    }
  }, [detail.data]);

  const save = async (): Promise<void> => {
    setError(null);
    try {
      await api.updateRepo(owner, repo, { description, visibility });
      setMessage("Settings saved.");
      detail.reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save settings");
    }
  };

  return (
    <div className="card repository-settings">
      <h3>Repository settings</h3>
      <ErrorBanner message={error} />
      {message ? <div className="notice-banner">{message}</div> : null}
      <form
        className="stack"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <label>
          Description
          <input value={description} onChange={(event) => setDescription(event.target.value)} />
        </label>
        <label>
          Visibility
          <select value={visibility} onChange={(event) => setVisibility(event.target.value)}>
            <option value="public">Public</option>
            <option value="private">Private</option>
          </select>
        </label>
        <div className="row">
          <button type="submit" className="primary">
            Save changes
          </button>
        </div>
      </form>

      <div className="repository-settings-section">
        <h3>Features</h3>
        <Switch
          checked={detail.data?.actions_enabled !== false}
          disabled={!detail.data}
          onChange={(value) => {
            setError(null);
            void api.updateRepo(owner, repo, { actions_enabled: value }).then(() => detail.reload(), (cause: unknown) => setError(cause instanceof Error ? cause.message : "Could not update Actions"));
          }}
          label="Actions"
          hint="Run the workflow in .gitgood-ci.yml on every push. Jobs execute on the instance's runners."
        />
      </div>

      <div className="repository-settings-section"><PushPolicyPanel owner={owner} repo={repo} /></div>
      <BranchProtectionPanel owner={owner} repo={repo} />
      <div className="repository-settings-section"><MergeRequirementsPanel owner={owner} repo={repo} /></div>
      <div className="repository-settings-section"><TopicsPanel owner={owner} repo={repo} canEdit /></div>
      <div className="repository-settings-section"><CollaboratorSettings owner={owner} repo={repo} /></div>

      <div className="repository-settings-section"><WebhookManager owner={owner} repo={repo} /></div>

      <div className="repository-settings-section"><ForkList owner={owner} repo={repo} /></div>

      <hr style={{ border: "none", borderTop: "1px solid var(--border)", margin: "20px 0" }} />
      <h3 style={{ color: "var(--danger)" }}>Danger zone</h3>
      <p className="muted small">Deleting a repository removes its git data and cannot be undone.</p>
      {confirmingDelete ? (
        <div className="row">
          <button
            className="danger"
            onClick={() => {
              void api.deleteRepo(owner, repo).then(() => navigate("/"));
            }}
          >
            Yes, delete {owner}/{repo}
          </button>
          <button className="ghost" onClick={() => setConfirmingDelete(false)}>
            Cancel
          </button>
        </div>
      ) : (
        <button className="danger" onClick={() => setConfirmingDelete(true)}>
          Delete repository
        </button>
      )}
    </div>
  );
}

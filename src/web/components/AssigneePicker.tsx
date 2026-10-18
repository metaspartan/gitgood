import "./AssigneePicker.css";
import { useState, type ReactNode } from "react";
import { api } from "../api.ts";
import { Avatar, ErrorBanner, useAsync } from "../components.tsx";
import type { Assignee } from "../types.ts";

function Chip({
  person,
  canEdit,
  busy,
  onRemove,
}: {
  person: Assignee;
  canEdit: boolean;
  busy: boolean;
  onRemove: () => void;
}): ReactNode {
  return (
    <span className="assignee-chip">
      <Avatar user={person} />
      <span>{person.username}</span>
      {canEdit ? (
        <button
          type="button"
          className="assignee-chip-remove"
          disabled={busy}
          onClick={onRemove}
          aria-label={`Unassign ${person.username}`}
          title={`Unassign ${person.username}`}
        >
          ×
        </button>
      ) : null}
    </span>
  );
}

export function AssigneePicker({
  owner,
  repo,
  number,
  kind,
  assignees,
  canEdit,
  onChanged,
}: {
  owner: string;
  repo: string;
  number: number;
  kind: "issue" | "pull";
  assignees: Assignee[];
  canEdit: boolean;
  onChanged: () => void;
}): ReactNode {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const assignable = useAsync(
    () => (canEdit ? api.assignableUsers(owner, repo) : Promise.resolve({ items: [] })),
    [owner, repo, canEdit],
  );

  const mutate = async (body: { add?: string[]; remove?: string[] }): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await api.assign(owner, repo, kind, number, body);
      onChanged();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not change the assignees");
    } finally {
      setBusy(false);
    }
  };

  const assigned = new Set(assignees.map((person) => person.id));
  const available = (assignable.data?.items ?? []).filter((person) => !assigned.has(person.id));

  return (
    <div className="assignee-picker">
      <span className="assignee-label">Assignees</span>
      {error ? <ErrorBanner message={error} /> : null}
      {canEdit && available.length > 0 ? (
        <label className="assignee-add">
          <span className="sr-only">Add an assignee</span>
          <select
            value=""
            disabled={busy || assignable.loading}
            onChange={(event) => {
              if (event.target.value) void mutate({ add: [event.target.value] });
            }}
          >
            <option value="">Add assignee…</option>
            {available.map((person) => (
              <option key={person.id} value={person.username}>
                {person.username}
              </option>
            ))}
          </select>
        </label>
      ) : null}

      <div className="assignee-chips">
        {assignees.length === 0 ? <span className="faint small">No one assigned</span> : null}
        {assignees.map((person) => (
          <Chip
            key={person.id}
            person={person}
            canEdit={canEdit}
            busy={busy}
            onRemove={() => void mutate({ remove: [person.username] })}
          />
        ))}
      </div>
    </div>
  );
}

export function AssigneeAvatars({ assignees }: { assignees: Assignee[] }): ReactNode {
  if (assignees.length === 0) return null;
  return (
    <span className="assignee-avatars" title={assignees.map((a) => a.username).join(", ")}>
      {assignees.slice(0, 3).map((person) => (
        <Avatar key={person.id} user={person} />
      ))}
      {assignees.length > 3 ? <span className="faint small">+{assignees.length - 3}</span> : null}
    </span>
  );
}

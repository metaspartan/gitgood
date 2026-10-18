import { useState, type ReactNode } from "react";
import "./Milestones.css";
import { api } from "../api.ts";
import { EmptyState, ErrorBanner, Spinner, useAsync } from "../components.tsx";
import { Link } from "../router.tsx";
import type { Milestone } from "../types.ts";

function dueLabel(milestone: Milestone): { text: string; overdue: boolean } {
  if (milestone.due_on === null) return { text: "No due date", overdue: false };
  const due = new Date(milestone.due_on);
  const text = due.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" });
  const overdue = milestone.state === "open" && milestone.due_on < Date.now();
  return { text, overdue };
}

function MilestoneRow({ owner, repo, milestone }: { owner: string; repo: string; milestone: Milestone }): ReactNode {
  const due = dueLabel(milestone);
  const complete = milestone.completion_percent;
  return (
    <li className="milestone-row">
      <div className="milestone-row-head">
        <Link to={`/${owner}/${repo}/milestones/${milestone.number}`} className="milestone-title">
          {milestone.title}
        </Link>
        {milestone.state === "closed" ? <span className="badge">closed</span> : null}
        {due.overdue ? <span className="badge danger">overdue</span> : null}
      </div>
      {milestone.description ? <p className="muted small milestone-description">{milestone.description}</p> : null}
      <div
        className="progress"
        role="progressbar"
        aria-valuenow={complete}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={`${milestone.title} completion`}
      >
        <span className="progress-fill" style={{ width: `${complete}%` }} />
      </div>
      <p className="small milestone-meta">
        {complete}% · {milestone.closed_count} closed / {milestone.open_count} open ·{" "}
        {milestone.open_issues} open issue{milestone.open_issues === 1 ? "" : "s"} ·{" "}
        {milestone.open_pulls} open pull request{milestone.open_pulls === 1 ? "" : "s"} · due{" "}
        <span className={due.overdue ? "danger" : undefined}>{due.text}</span>
      </p>
    </li>
  );
}

export function MilestoneListPage({ owner, repo }: { owner: string; repo: string }): ReactNode {
  const [state, setState] = useState<"open" | "closed" | "all">("open");
  const milestones = useAsync(() => api.milestones(owner, repo, state), [owner, repo, state]);
  const [creating, setCreating] = useState(false);
  const [title, setTitle] = useState("");
  const [dueOn, setDueOn] = useState("");
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const detail = useAsync(() => (creating ? Promise.resolve(null) : api.repo(owner, repo)), [owner, repo, creating]);
  const canCreate = detail.data?.permissions?.write === true;

  const create = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await api.createMilestone(owner, repo, {
        title: title.trim(),
        ...(description.trim() ? { description: description.trim() } : {}),
        ...(dueOn ? { due_on: dueOn } : {}),
      });
      setTitle("");
      setDescription("");
      setDueOn("");
      setCreating(false);
      milestones.reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not create the milestone");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="stack">
      <div className="row spread">
        <h2 style={{ margin: 0 }}>Milestones</h2>
        {canCreate && !creating ? (
          <button type="button" onClick={() => setCreating(true)}>
            New milestone
          </button>
        ) : null}
      </div>
      <p className="muted small measure">
        Group issues and pull requests under a dated goal. A milestone is complete when everything filed
        against it is closed or merged.
      </p>
      <ErrorBanner message={error ?? milestones.error} />
      {creating ? (
        <form
          className="card stack"
          onSubmit={(event) => {
            event.preventDefault();
            void create();
          }}
        >
          <div className="stack-tight">
            <label htmlFor="milestone-title">Title</label>
            <input
              id="milestone-title"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              placeholder="2.0 release"
              required
              maxLength={256}
            />
          </div>
          <div className="stack-tight">
            <label htmlFor="milestone-description">Description</label>
            <textarea
              id="milestone-description"
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              rows={3}
              maxLength={65536}
            />
          </div>
          <div className="stack-tight milestone-due-field">
            <label htmlFor="milestone-due">Due date</label>
            <input
              id="milestone-due"
              type="date"
              value={dueOn}
              onChange={(event) => setDueOn(event.target.value)}
            />
          </div>
          <div className="row">
            <button type="submit" className="primary" disabled={busy || !title.trim()}>
              {busy ? "Creating…" : "Create milestone"}
            </button>
            <button type="button" onClick={() => setCreating(false)} disabled={busy}>
              Cancel
            </button>
          </div>
        </form>
      ) : null}
      <div className="tabs" role="group" aria-label="Filter milestones by state">
        {(["open", "closed", "all"] as const).map((value) => (
          <button
            key={value}
            aria-pressed={state === value}
            className={state === value ? "tab active" : "tab"}
            onClick={() => setState(value)}
            type="button"
          >
            {value === "all" ? "All" : value === "open" ? "Open" : "Closed"}
          </button>
        ))}
      </div>
      {milestones.loading && !milestones.data ? <Spinner label="Loading milestones" /> : null}
      {milestones.data && milestones.data.items.length === 0 ? (
        <EmptyState
          title={state === "open" ? "No open milestones" : "Nothing here yet"}
          hint={
            state === "open"
              ? "Create one to group the issues and pull requests that ship together."
              : "Try another filter."
          }
        />
      ) : null}
      {milestones.data && milestones.data.items.length > 0 ? (
        <ul className="milestone-list">
          {milestones.data.items.map((milestone) => (
            <MilestoneRow key={milestone.id} owner={owner} repo={repo} milestone={milestone} />
          ))}
        </ul>
      ) : null}
    </div>
  );
}

export function MilestoneDetailPage({
  owner,
  repo,
  number,
}: {
  owner: string;
  repo: string;
  number: number;
}): ReactNode {
  const milestone = useAsync(() => api.milestone(owner, repo, number), [owner, repo, number]);
  const items = useAsync(() => api.milestoneItems(owner, repo, number), [owner, repo, number]);

  if (milestone.loading && !milestone.data) return <Spinner label="Loading milestone" />;
  if (milestone.error || !milestone.data) {
    return <EmptyState title="Milestone not found" hint="It may have been deleted." />;
  }
  const value = milestone.data;
  const due = dueLabel(value);
  return (
    <div className="stack">
      <div className="row spread">
        <h2 style={{ margin: 0 }}>
          {value.title} <span className="faint small">#{value.number}</span>
        </h2>
        {value.state === "closed" ? <span className="badge">closed</span> : null}
      </div>
      {value.description ? <div className="card">{value.description}</div> : null}
      <div
        className="progress"
        role="progressbar"
        aria-valuenow={value.completion_percent}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={`${value.title} completion`}
      >
        <span className="progress-fill" style={{ width: `${value.completion_percent}%` }} />
      </div>
      <p className="small muted">
        {value.completion_percent}% complete · {value.closed_count} closed of {value.total_count} ·{" "}
        {value.open_issues} open issue{value.open_issues === 1 ? "" : "s"} · {value.open_pulls} open pull
        request{value.open_pulls === 1 ? "" : "s"} · due <span className={due.overdue ? "danger" : ""}>{due.text}</span>
      </p>
      {items.loading && !items.data ? <Spinner label="Loading items" /> : null}
      {items.data ? (
        <div className="milestone-items">
          {items.data.total === 0 ? (
            <EmptyState
              title="Nothing filed yet"
              hint="Open an issue or pull request and set its milestone to fill this bar."
            />
          ) : null}
          {items.data.issues.length > 0 ? (
            <section>
              <h3>Issues</h3>
              <ul className="plain-list">
                {items.data.issues.map((issue) => (
                  <li key={issue.id}>
                    <Link to={`/${owner}/${repo}/issues/${issue.number}`}>
                      #{issue.number} {issue.title}
                    </Link>
                    <span className="faint small"> {issue.state}</span>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
          {items.data.pulls.length > 0 ? (
            <section>
              <h3>Pull requests</h3>
              <ul className="plain-list">
                {items.data.pulls.map((pull) => (
                  <li key={pull.id}>
                    <Link to={`/${owner}/${repo}/pulls/${pull.number}`}>
                      #{pull.number} {pull.title}
                    </Link>
                    <span className="faint small"> {pull.state}</span>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export function MilestonePicker({
  owner,
  repo,
  value,
  onChange,
  disabled,
}: {
  owner: string;
  repo: string;
  value: number | null;
  onChange: (milestoneId: number | null) => void;
  disabled?: boolean;
}): ReactNode {
  const milestones = useAsync(() => api.milestones(owner, repo, "open"), [owner, repo]);
  return (
    <label className="milestone-picker">
      <span>Milestone</span>
      <select
        value={value === null ? "" : String(value)}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value === "" ? null : Number(event.target.value))}
      >
        <option value="">No milestone</option>
        {(milestones.data?.items ?? []).map((milestone) => (
          <option key={milestone.id} value={milestone.id}>
            {milestone.title}
          </option>
        ))}
      </select>
    </label>
  );
}

import { useState, type ReactNode } from "react";
import { api } from "../api.ts";
import { MilestonePicker } from "./Milestones.tsx";
import { AssigneeAvatars, AssigneePicker } from "../components/AssigneePicker.tsx";
import { ThreadTimeline } from "../components/ThreadTimeline.tsx";
import { Avatar, Badge, EmptyState, ErrorBanner, Markdown, Spinner, timeAgo, useAsync } from "../components.tsx";
import { Link, navigate, useLocation } from "../router.tsx";
import { useSession } from "../App.tsx";
import { referenceHref } from "../issue-reference.ts";
import type { Comment } from "../types.ts";
import { ThreadRow } from "../components/ThreadRow.tsx";

const STATES = ["open", "closed", "all"] as const;

export function IssueListPage({
  owner,
  repo,
  state,
}: {
  owner: string;
  repo: string;
  state: string;
}): ReactNode {
  const { user } = useSession();
  const [showForm, setShowForm] = useState(false);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [error, setError] = useState<string | null>(null);
  const search = new URLSearchParams(useLocation().split("?")[1] ?? "");
  const assignee = search.get("assignee") ?? "";
  const unassigned = search.get("no_assignee") === "true";
  const issues = useAsync(
    () => api.issues(owner, repo, state, 1, assignee ? { assignee } : unassigned ? { noAssignee: true } : {}),
    [owner, repo, state, assignee, unassigned],
  );

  const setFilter = (next: { assignee?: string; noAssignee?: boolean }): void => {
    const params = new URLSearchParams();
    if (state !== "open") params.set("state", state);
    if (next.assignee) params.set("assignee", next.assignee);
    if (next.noAssignee) params.set("no_assignee", "true");
    const query = params.toString();
    navigate(`/${owner}/${repo}/issues${query ? `?${query}` : ""}`);
  };

  const canFilter = useAsync(() => api.repo(owner, repo), [owner, repo]);
  const mayFilter = canFilter.data?.permissions?.write === true;
  const people = useAsync(
    () => (mayFilter ? api.assignableUsers(owner, repo) : Promise.resolve({ items: [] })),
    [owner, repo, mayFilter],
  );

  const submit = async (): Promise<void> => {
    setError(null);
    try {
      const issue = await api.createIssue(owner, repo, { title, body });
      setTitle("");
      setBody("");
      setShowForm(false);
      navigate(`/${owner}/${repo}/issues/${issue.number}`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not create issue");
    }
  };

  return (
    <>
      <div className="card thread-box-head">
        <div className="row wrap">
          <div className="tabs sub">
            {STATES.map((value) => (
              <Link
                key={value}
                to={`/${owner}/${repo}/issues${value === "open" ? "" : `?state=${value}`}`}
                className={state === value ? "active" : ""}
              >
                {value === "all" ? "All" : value === "open" ? "Open" : "Closed"}
              </Link>
            ))}
          </div>
          <span className="spacer" />
          {mayFilter ? (
            <div className="row wrap issue-filters">
              {assignee || unassigned ? (
                <button
                  className="ghost small"
                  onClick={() => setFilter({})}
                  aria-label="Clear the assignee filter"
                >
                  Assigned to anyone
                </button>
              ) : null}
              <label className="stack-tight">
                <span className="sr-only">Filter by assignee</span>
                <select
                  value={unassigned ? "__unassigned" : assignee}
                  onChange={(event) => {
                    const value = event.target.value;
                    setFilter(
                      value === "__unassigned"
                        ? { noAssignee: true }
                        : value === ""
                          ? {}
                          : { assignee: value },
                    );
                  }}
                >
                  <option value="">Anyone</option>
                  <option value="__unassigned">No one</option>
                  {(people.data?.items ?? []).map((person) => (
                    <option key={person.id} value={person.username}>
                      {person.username}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          ) : null}
          {user ? (
            <button type="button" className="btn-primary" onClick={() => setShowForm((value) => !value)}>
              New issue
            </button>
          ) : null}
        </div>

        {showForm ? (
          <form
            className="stack"
            style={{ marginTop: "var(--s4)", maxWidth: "none" }}
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
          >
            <ErrorBanner message={error} />
            <label>
              Title
              <input value={title} onChange={(event) => setTitle(event.target.value)} required />
            </label>
            <label>
              Description
              <textarea value={body} onChange={(event) => setBody(event.target.value)} placeholder="Markdown supported" />
            </label>
            <div className="row">
              <button type="submit" className="primary" disabled={!title.trim()}>
                Create issue
              </button>
              <button type="button" className="ghost" onClick={() => setShowForm(false)}>
                Cancel
              </button>
            </div>
          </form>
        ) : null}
      </div>

      <div className="card thread-box-body">
        <ErrorBanner message={issues.error} />
        {issues.loading ? (
          <Spinner />
        ) : (issues.data?.items.length ?? 0) === 0 ? (
          <EmptyState title="No issues" hint="Nothing matches this filter." />
        ) : (
          <ul className="thread-list">
            {issues.data?.items.map((issue) => (
              <ThreadRow
                key={issue.id}
                kind="issue"
                href={`/${owner}/${repo}/issues/${issue.number}`}
                state={issue.state}
                title={issue.title}
                number={issue.number}
                createdAt={issue.created_at}
                author={issue.author?.username ?? null}
                labels={issue.labels ?? []}
                comments={issue.comment_count ?? 0}
                aside={<AssigneeAvatars assignees={issue.assignees ?? []} />}
              />
            ))}
          </ul>
        )}
      </div>
    </>
  );
}

function CommentThread({
  comments,
  onAdd,
  canComment,
  owner,
  repo,
}: {
  comments: Comment[];
  onAdd: (body: string) => Promise<void>;
  canComment: boolean;
  owner: string;
  repo: string;
}): ReactNode {
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <div className="card">
      <h3>Comments</h3>
      {comments.length === 0 ? <p className="faint small">No comments yet.</p> : null}
      {comments.map((comment) => (
        <div key={comment.id} style={{ borderTop: "1px solid var(--border)", paddingTop: 12, marginTop: 12 }}>
          <div className="row small muted">
            {comment.author ? <Avatar user={comment.author} /> : null}
            <strong>{comment.author?.username ?? "unknown"}</strong>
            <span className="faint">commented {timeAgo(comment.created_at)}</span>
          </div>
          <div style={{ marginTop: 8 }}>
            <Markdown source={comment.body} resolveReference={(raw) => referenceHref(owner, repo, raw)} />
          </div>
        </div>
      ))}

      {canComment ? (
        <form
          className="stack"
          style={{ marginTop: "var(--s4)", maxWidth: "none" }}
          onSubmit={(event) => {
            event.preventDefault();
            setBusy(true);
            setError(null);
            onAdd(body)
              .then(() => setBody(""))
              .catch((cause: unknown) =>
                setError(cause instanceof Error ? cause.message : "Could not post comment"),
              )
              .finally(() => setBusy(false));
          }}
        >
          <ErrorBanner message={error} />
          <label>
            Add a comment
            <textarea value={body} onChange={(event) => setBody(event.target.value)} required />
          </label>
          <div className="row">
            <button type="submit" className="primary" disabled={busy || !body.trim()}>
              Comment
            </button>
          </div>
        </form>
      ) : (
        <p className="small muted" style={{ marginTop: 14 }}>
          <Link to="/login">Sign in</Link> to comment.
        </p>
      )}
    </div>
  );
}

export function IssueDetailPage({
  owner,
  repo,
  number,
}: {
  owner: string;
  repo: string;
  number: number;
}): ReactNode {
  const { user } = useSession();
  const issue = useAsync(() => api.issue(owner, repo, number), [owner, repo, number]);
  const comments = useAsync(() => api.issueComments(owner, repo, number), [owner, repo, number]);
  const repoDetail = useAsync(() => api.repo(owner, repo), [owner, repo]);
  const canManage = repoDetail.data?.permissions?.write === true;
  const [error, setError] = useState<string | null>(null);

  if (issue.loading) return <Spinner label="Loading issue" />;
  if (issue.error) return <ErrorBanner message={issue.error} />;
  if (!issue.data) return <EmptyState title="Issue not found" />;

  const toggle = async (): Promise<void> => {
    setError(null);
    try {
      await api.updateIssue(owner, repo, number, {
        state: issue.data?.state === "open" ? "closed" : "open",
      });
      issue.reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not update issue");
    }
  };

  return (
    <>
      <div className="card">
        <ErrorBanner message={error} />
        <div className="row wrap">
          <h2>
            {issue.data.title} <span className="faint">#{issue.data.number}</span>
          </h2>
          <Badge kind={issue.data.state}>{issue.data.state}</Badge>
          <span className="spacer" />
          {user ? (
            <button onClick={() => void toggle()}>
              {issue.data.state === "open" ? "Close issue" : "Reopen issue"}
            </button>
          ) : null}
        </div>
        <div className="small faint" style={{ marginTop: 6 }}>
          {issue.data.author?.username} opened {timeAgo(issue.data.created_at)}
        </div>
        <div className="thread-controls">
          <AssigneePicker
            owner={owner}
            repo={repo}
            number={number}
            kind="issue"
            assignees={issue.data.assignees ?? []}
            canEdit={canManage}
            onChanged={() => issue.reload()}
          />
          <MilestonePicker
            owner={owner}
            repo={repo}
            value={issue.data.milestone_id ?? null}
            disabled={!canManage}
            onChange={async (milestoneId) => {
              setError(null);
              try {
                await api.setIssueMilestone(owner, repo, number, milestoneId);
                issue.reload();
              } catch (cause) {
                setError(cause instanceof Error ? cause.message : "Could not set the milestone");
              }
            }}
          />
        </div>
        <div style={{ marginTop: 14 }}>
          <Markdown source={issue.data.body || "_No description provided._"} resolveReference={(raw) => referenceHref(owner, repo, raw)} />
        </div>
      </div>

      <ThreadTimeline
        owner={owner}
        repo={repo}
        kind="issue"
        number={number}
        commentCount={comments.data?.items.length ?? 0}
      />

      <CommentThread
        comments={comments.data?.items ?? []}
        canComment={user !== null}
        owner={owner}
        repo={repo}
        onAdd={async (body) => {
          await api.addIssueComment(owner, repo, number, body);
          comments.reload();
        }}
      />
    </>
  );
}

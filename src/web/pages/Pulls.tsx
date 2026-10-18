import { PullReviews } from "../components/PullReviews.tsx";
import { useState, type ReactNode } from "react";
import { api } from "../api.ts";
import { MilestonePicker } from "./Milestones.tsx";
import { AssigneeAvatars, AssigneePicker } from "../components/AssigneePicker.tsx";
import { ThreadTimeline } from "../components/ThreadTimeline.tsx";
import { Avatar, Badge, EmptyState, ErrorBanner, Markdown, Spinner, timeAgo, useAsync } from "../components.tsx";
import { Link, navigate } from "../router.tsx";
import { useSession } from "../App.tsx";
import { referenceHref } from "../issue-reference.ts";
import { hasMoreFileRows, visibleFileRows } from "../pr-file-list.ts";
import type { Comment } from "../types.ts";
import { ThreadRow } from "../components/ThreadRow.tsx";

const STATES = ["open", "closed", "merged", "all"] as const;

export function PullListPage({
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
  const [head, setHead] = useState("");
  const [base, setBase] = useState("");
  const [error, setError] = useState<string | null>(null);
  const pulls = useAsync(() => api.pulls(owner, repo, state), [owner, repo, state]);
  const branches = useAsync(() => api.branches(owner, repo), [owner, repo]);

  const submit = async (): Promise<void> => {
    setError(null);
    try {
      const pull = await api.createPull(owner, repo, { title, body, head, base });
      setTitle("");
      setBody("");
      setShowForm(false);
      navigate(`/${owner}/${repo}/pulls/${pull.number}`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not create pull request");
    }
  };

  const branchNames = (branches.data?.items ?? []).map((branch) => branch.name);

  return (
    <>
      <div className="card thread-box-head">
        <div className="row wrap">
          <div className="tabs sub">
            {STATES.map((value) => (
              <Link
                key={value}
                to={`/${owner}/${repo}/pulls${value === "open" ? "" : `?state=${value}`}`}
                className={state === value ? "active" : ""}
              >
                {value[0]?.toUpperCase()}
                {value.slice(1)}
              </Link>
            ))}
          </div>
          <span className="spacer" />
          {user ? (
            <button type="button" className="btn-primary" onClick={() => setShowForm((value) => !value)}>
              New pull request
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
            <div className="row">
              <label style={{ flex: 1 }}>
                Base branch (merge into)
                <select value={base} onChange={(event) => setBase(event.target.value)} required>
                  <option value="">Select…</option>
                  {branchNames.map((name) => (
                    <option key={name} value={name}>
                      {name}
                    </option>
                  ))}
                </select>
              </label>
              <label style={{ flex: 1 }}>
                Head branch (from)
                <select value={head} onChange={(event) => setHead(event.target.value)} required>
                  <option value="">Select…</option>
                  {branchNames.map((name) => (
                    <option key={name} value={name}>
                      {name}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <label>
              Description
              <textarea value={body} onChange={(event) => setBody(event.target.value)} />
            </label>
            <div className="row">
              <button type="submit" className="primary" disabled={!title.trim() || !head || !base}>
                Create pull request
              </button>
              <button type="button" className="ghost" onClick={() => setShowForm(false)}>
                Cancel
              </button>
            </div>
          </form>
        ) : null}
      </div>

      <div className="card thread-box-body">
        <ErrorBanner message={pulls.error} />
        {pulls.loading ? (
          <Spinner />
        ) : (pulls.data?.items.length ?? 0) === 0 ? (
          <EmptyState title="No pull requests" hint="Nothing matches this filter." />
        ) : (
          <ul className="thread-list">
            {pulls.data?.items.map((pull) => (
              <ThreadRow
                key={pull.id}
                kind="pull"
                href={`/${owner}/${repo}/pulls/${pull.number}`}
                state={pull.merged_at ? "merged" : pull.state}
                title={pull.title}
                number={pull.number}
                createdAt={pull.created_at}
                author={pull.author?.username ?? null}
                extra={
                  <span className="thread-branches mono">
                    {pull.head} → {pull.base}
                  </span>
                }
                comments={pull.comment_count ?? 0}
                aside={<AssigneeAvatars assignees={pull.assignees ?? []} />}
              />
            ))}
          </ul>
        )}
      </div>
    </>
  );
}

export function PullDetailPage({
  owner,
  repo,
  number,
}: {
  owner: string;
  repo: string;
  number: number;
}): ReactNode {
  const { user } = useSession();
  const pull = useAsync(() => api.pull(owner, repo, number), [owner, repo, number]);
  const repoDetail = useAsync(() => api.repo(owner, repo), [owner, repo]);
  const canManage = repoDetail.data?.permissions?.write === true;
  const files = useAsync(() => api.pullFiles(owner, repo, number), [owner, repo, number]);
  const comments = useAsync(() => api.pullComments(owner, repo, number), [owner, repo, number]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [commentBody, setCommentBody] = useState("");
  const [filePages, setFilePages] = useState(1);

  if (pull.loading) return <Spinner label="Loading pull request" />;
  if (pull.error) return <ErrorBanner message={pull.error} />;
  if (!pull.data) return <EmptyState title="Pull request not found" />;

  const merge = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await api.mergePull(owner, repo, number);
      pull.reload();
      files.reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Merge failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="card">
        <ErrorBanner message={error} />
        <div className="row wrap">
          <h2>
            {pull.data.title} <span className="faint">#{pull.data.number}</span>
          </h2>
          <Badge kind={pull.data.state}>{pull.data.state}</Badge>
          <span className="spacer" />
          {user && pull.data.state === "open" ? (
            <button className="primary" onClick={() => void merge()} disabled={busy}>
              {busy ? "Merging…" : "Merge pull request"}
            </button>
          ) : null}
        </div>
        <div className="small faint" style={{ marginTop: 6 }}>
          {pull.data.author?.username} wants to merge{" "}
          <span className="mono">{pull.data.head}</span> into <span className="mono">{pull.data.base}</span> ·{" "}
          {timeAgo(pull.data.created_at)}
        </div>
        {pull.data.merged_sha ? (
          <div className="small" style={{ marginTop: 8 }}>
            Merged as <span className="mono">{pull.data.merged_sha.slice(0, 10)}</span>
          </div>
        ) : null}
        <div className="thread-controls">
          <AssigneePicker
            owner={owner}
            repo={repo}
            number={number}
            kind="pull"
            assignees={pull.data.assignees ?? []}
            canEdit={canManage}
            onChanged={() => pull.reload()}
          />
          <MilestonePicker
            owner={owner}
            repo={repo}
            value={pull.data.milestone_id ?? null}
            disabled={!canManage}
            onChange={async (milestoneId) => {
              setError(null);
              try {
                await api.setPullMilestone(owner, repo, number, milestoneId);
                pull.reload();
              } catch (cause) {
                setError(cause instanceof Error ? cause.message : "Could not set the milestone");
              }
            }}
          />
        </div>
        <div style={{ marginTop: 14 }}>
          <Markdown source={pull.data.body || "_No description provided._"} resolveReference={(raw) => referenceHref(owner, repo, raw)} />
        </div>
      </div>

      <PullReviews owner={owner} repo={repo} number={number} base={pull.data.base} open={pull.data.state === "open"} onChanged={() => { files.reload(); }} />

      <div className="card">
        <h3>Files changed</h3>
        {files.data?.comparison_kind === "merge_snapshot" ? <p className="small muted">Saved comparison at merge time. Later branch changes do not alter this history.</p> : null}
        {files.data?.comparison_available === false ? <p className="muted" role="status">{files.data.comparison_message}</p> : files.loading ? (
          <Spinner />
        ) : (
          <>
            <div className="row small faint" style={{ marginBottom: 10 }}>
              <span>{files.data?.stats.files_changed ?? 0} {(files.data?.stats.files_changed ?? 0) === 1 ? "file" : "files"}</span>
              <span className="stat-add">+{files.data?.stats.additions ?? 0}</span>
              <span className="stat-del">-{files.data?.stats.deletions ?? 0}</span>
            </div>
            <div className="diff">
              {(files.data?.items ?? []).slice(0, visibleFileRows(files.data?.items.length ?? 0, filePages)).map((file) => (
                <div className="file" key={file.path}>
                  <div className="head">
                    <span className="mono">{file.path}</span>
                    <span className="spacer" />
                    {file.binary ? (
                      <span className="faint small">binary</span>
                    ) : (
                      <>
                        <span className="stat-add">+{file.additions}</span>
                        <span className="stat-del">-{file.deletions}</span>
                      </>
                    )}
                  </div>
                </div>
              ))}
              {hasMoreFileRows(files.data?.items.length ?? 0, filePages) ? (
                <button
                  type="button"
                  className="ghost small"
                  style={{ marginTop: "var(--s4)" }}
                  onClick={() => setFilePages((pages) => pages + 1)}
                >
                  Show more files ({((files.data?.items.length ?? 0) - visibleFileRows(files.data?.items.length ?? 0, filePages)).toLocaleString()} hidden)
                </button>
              ) : null}
            </div>
          </>
        )}
      </div>

      <ThreadTimeline
        owner={owner}
        repo={repo}
        kind="pull"
        number={number}
        commentCount={comments.data?.items.length ?? 0}
      />

      <div className="card">
        <h3>Conversation</h3>
        {(comments.data?.items ?? []).length === 0 ? <p className="faint small">No comments yet.</p> : null}
        {(comments.data?.items ?? []).map((comment: Comment) => (
          <div key={comment.id} style={{ borderTop: "1px solid var(--border)", paddingTop: 12, marginTop: 12 }}>
            <div className="row small muted">
              {comment.author ? <Avatar user={comment.author} /> : null}
              <strong>{comment.author?.username ?? "unknown"}</strong>
              <span className="faint">{timeAgo(comment.created_at)}</span>
            </div>
            <div style={{ marginTop: 8 }}>
              <Markdown source={comment.body} resolveReference={(raw) => referenceHref(owner, repo, raw)} />
            </div>
          </div>
        ))}
        {user ? (
          <form
            className="stack"
            style={{ marginTop: "var(--s4)", maxWidth: "none" }}
            onSubmit={(event) => {
              event.preventDefault();
              void api
                .addPullComment(owner, repo, number, commentBody)
                .then(() => {
                  setCommentBody("");
                  comments.reload();
                })
                .catch((cause: unknown) =>
                  setError(cause instanceof Error ? cause.message : "Could not post comment"),
                );
            }}
          >
            <label>
              Add a comment
              <textarea value={commentBody} onChange={(event) => setCommentBody(event.target.value)} required />
            </label>
            <div className="row">
              <button type="submit" className="primary" disabled={!commentBody.trim()}>
                Comment
              </button>
            </div>
          </form>
        ) : null}
      </div>
    </>
  );
}

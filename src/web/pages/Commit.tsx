import { useState, type ReactNode } from "react";
import { api } from "../api.ts";
import { ErrorBanner, timeAgo, useAsync } from "../components.tsx";
import { CommitAuthor } from "../components/CommitAuthor.tsx";
import { DiffView } from "../components/DiffView.tsx";
import { Icon } from "../components/Icons.tsx";
import { OverflowMenu, type MenuEntry } from "../components/OverflowMenu.tsx";
import { Link } from "../router.tsx";
import { copyText } from "../clipboard.ts";

function CopyButton({ value, label }: { value: string; label: string }): ReactNode {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="ghost icon-only commit-copy"
      aria-label={copied ? "Copied" : label}
      title={copied ? "Copied!" : label}
      onClick={() => {
        void copyText(value).then((ok) => {
          setCopied(ok);
          if (ok) setTimeout(() => setCopied(false), 1500);
        });
      }}
    >
      <Icon name={copied ? "check" : "copy"} />
    </button>
  );
}

function CommitMenu({ owner, repo, sha, shortSha }: { owner: string; repo: string; sha: string; shortSha: string }): ReactNode {
  const entries: MenuEntry[] = [
    { label: "Browse repository at this point", to: `/${owner}/${repo}/tree/${sha}` },
    { label: "View history from here", to: `/${owner}/${repo}/commits/${sha}` },
    { separator: true },
    { label: "Copy full SHA", onSelect: () => void copyText(sha) },
    { label: "Copy short SHA", onSelect: () => void copyText(shortSha) },
    { label: "Copy link to commit", onSelect: () => void copyText(`${location.origin}/${owner}/${repo}/commit/${sha}`) },
  ];
  return <OverflowMenu label={`Options for commit ${shortSha}`} entries={entries} />;
}

function CommitSkeleton(): ReactNode {
  return (
    <div className="commit-header-box" aria-busy="true">
      <div className="commit-header-message">
        <span className="skeleton-text" style={{ width: "55%", height: 20 }} />
      </div>
      <div className="commit-header-meta"><span className="skeleton-text" style={{ width: "35%" }} /></div>
    </div>
  );
}

export function CommitPage({ owner, repo, sha }: { owner: string; repo: string; sha: string }): ReactNode {
  const commit = useAsync(() => api.commit(owner, repo, sha), [owner, repo, sha]);
  const diff = useAsync(() => api.commitDiff(owner, repo, sha), [owner, repo, sha]);
  const detail = commit.data;

  return (
    <>
      <div className="commit-page-head">
        <h2 className="commit-page-title">
          Commit <span className="mono">{detail?.short_sha ?? sha.slice(0, 7)}</span>
        </h2>
        <span className="spacer" />
        <Link to={`/${owner}/${repo}/tree/${detail?.sha ?? sha}`} className="btn-secondary commit-browse-files">
          <Icon name="code" /> Browse files
        </Link>
        {detail ? <CommitMenu owner={owner} repo={repo} sha={detail.sha} shortSha={detail.short_sha} /> : null}
      </div>

      {commit.error ? <ErrorBanner message={commit.error} /> : null}
      {!detail && !commit.error ? <CommitSkeleton /> : null}
      {detail ? (
        <section className="commit-header-box" aria-label="Commit details">
          <div className="commit-header-message">
            <h1 className="commit-header-title commit-subject">{detail.message}</h1>
            {detail.body ? <pre className="commit-body">{detail.body}</pre> : null}
            {detail.refs && (detail.refs.branches.length || detail.refs.tags.length) ? (
              <div className="commit-refs" aria-label="Branches and tags containing this commit">
                {detail.refs.branches.map((branch) => (
                  <Link key={`b-${branch}`} to={`/${owner}/${repo}/tree/${branch}`} className="commit-ref-pill"><Icon name="branch" /> {branch}</Link>
                ))}
                {detail.refs.tags.map((tag) => (
                  <Link key={`t-${tag}`} to={`/${owner}/${repo}/tree/${tag}`} className="commit-ref-pill"><Icon name="tag" /> {tag}</Link>
                ))}
                {detail.refs.more ? <span className="small faint">and more</span> : null}
              </div>
            ) : null}
          </div>
          <div className="commit-header-meta">
            <div className="commit-header-author">
              <CommitAuthor author={detail.author} />
              <span className="muted">committed</span>
              <time className="muted" dateTime={new Date(detail.authored_at).toISOString()} title={new Date(detail.authored_at).toLocaleString()}>
                {timeAgo(detail.authored_at)}
              </time>
            </div>
            <span className="spacer" />
            <div className="commit-header-ids small">
              {detail.parents.length === 0 ? (
                <span className="muted">0 parents</span>
              ) : (
                <span className="muted">
                  {detail.parents.length} parent{detail.parents.length === 1 ? "" : "s"}{" "}
                  {detail.parents.map((parent, index) => (
                    <span key={parent}>
                      {index > 0 ? " + " : ""}
                      <Link to={`/${owner}/${repo}/commit/${parent}`} className="mono commit-parent">{parent.slice(0, 7)}</Link>
                    </span>
                  ))}
                </span>
              )}
              <span className="commit-full-sha">
                <span className="muted">commit</span> <span className="mono">{detail.sha}</span>
                <CopyButton value={detail.sha} label="Copy full SHA" />
              </span>
            </div>
          </div>
        </section>
      ) : null}

      <div className="commit-diff">
        {diff.error ? <ErrorBanner message={diff.error} /> : null}
        {diff.loading ? (
          <div className="card commit-diff-skeleton" aria-busy="true"><span className="skeleton-text" style={{ width: "40%" }} /></div>
        ) : diff.data && detail ? (
          <DiffView
            diff={diff.data}
            emptyLabel="This commit made no changes."
            context={{ owner, repo, ref: detail.sha, baseRef: detail.parents[0] ?? null }}
          />
        ) : null}
      </div>
    </>
  );
}

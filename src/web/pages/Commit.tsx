import { useState, type ReactNode } from "react";
import { api } from "../api.ts";
import { Avatar, ErrorBanner, Spinner, timeAgo, useAsync } from "../components.tsx";
import { DiffView } from "../components/DiffView.tsx";
import { OverflowMenu, type MenuEntry } from "../components/OverflowMenu.tsx";
import { Link } from "../router.tsx";
import type { Commit as CommitShape } from "../types.ts";
import { copyText } from "../clipboard.ts";

export function CommitPage({
  owner,
  repo,
  sha,
}: {
  owner: string;
  repo: string;
  sha: string;
}): ReactNode {
  const commit = useAsync(() => api.commit(owner, repo, sha), [owner, repo, sha]);
  const diff = useAsync(() => api.commitDiff(owner, repo, sha), [owner, repo, sha]);

  if (commit.loading) return <Spinner label="Loading commit" />;
  if (commit.error) return <ErrorBanner message={commit.error} />;
  if (!commit.data) return null;

  const detail: CommitShape = commit.data;

  return (
    <>
      <div className="card">
        <div className="row wrap" style={{ gap: 10 }}>
          <h2 style={{ margin: 0, fontSize: 18 }} className="commit-subject">
            {detail.message}
          </h2>
          <span className="spacer" />
          <Link to={`/${owner}/${repo}/tree/${detail.sha}`} className="small" title="Browse the whole tree as of this commit">
            Browse files
          </Link>
          <CommitMenu owner={owner} repo={repo} sha={detail.sha} shortSha={detail.short_sha} />
        </div>

        {detail.body ? <pre className="commit-body">{detail.body}</pre> : null}

        <div className="row wrap small muted" style={{ marginTop: 10, gap: 10 }}>
          <Avatar
            user={{
              username: detail.author.name,
              display_name: detail.author.name,
              avatar_hue: hueFrom(detail.author.email),
            }}
          />
          <strong>{detail.author.name}</strong>
          <span className="faint">authored {timeAgo(detail.authored_at)}</span>
          <span className="spacer" />
          <CopyableSha sha={detail.sha} short={detail.short_sha} />
        </div>

        {detail.parents.length > 0 ? (
          <div className="row wrap small" style={{ marginTop: 8, gap: 6 }}>
            <span className="faint">parents:</span>
            {detail.parents.map((parent) => (
              <Link key={parent} to={`/${owner}/${repo}/commit/${parent}`} className="mono small">
                {parent.slice(0, 8)}
              </Link>
            ))}
          </div>
        ) : (
          <div className="small faint" style={{ marginTop: 8 }}>
            root commit
          </div>
        )}

      </div>

      <div className="card">
        {diff.error ? <ErrorBanner message={diff.error} /> : null}
        {diff.loading ? (
          <Spinner label="Loading diff" />
        ) : diff.data ? (
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


function CopyableSha({ sha, short }: { sha: string; short: string }): ReactNode {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="ghost small mono sha-chip"
      title={sha}
      aria-label={`Commit ${sha}. Activate to copy the full SHA.`}
      onClick={() => {
        void copyText(sha).then((ok) => {
          setCopied(ok);
          setTimeout(() => setCopied(false), 1500);
        });
      }}
    >
      {copied ? "copied" : short}
    </button>
  );
}

function CommitMenu({ owner, repo, sha, shortSha }: { owner: string; repo: string; sha: string; shortSha: string }): ReactNode {
  const entries: MenuEntry[] = [
    { label: "Browse files at this commit", to: `/${owner}/${repo}/tree/${sha}`, title: "Open the tree this commit produced" },
    { separator: true },
    { label: "Copy full SHA", onSelect: () => void copyText(sha) },
    { label: "Copy short SHA", onSelect: () => void copyText(shortSha) },
  ];

  return <OverflowMenu label={`Options for commit ${shortSha}`} entries={entries} />;
}

function hueFrom(value: string): number {
  let hash = 0;
  for (let i = 0; i < value.length; i++) {
    hash = (hash * 31 + value.charCodeAt(i)) % 360;
  }
  return hash;
}

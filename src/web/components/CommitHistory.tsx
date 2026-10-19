import { useState, type ReactNode } from "react";
import { timeAgo } from "../components.tsx";
import { CommitAuthor } from "./CommitAuthor.tsx";
import { Icon } from "./Icons.tsx";
import { Link } from "../router.tsx";
import type { Commit } from "../types.ts";
import { copyText } from "../clipboard.ts";

export interface CommitDay {
  key: string;
  label: string;
  commits: Commit[];
}

export function groupCommitsByDay(commits: readonly Commit[], locale?: string): CommitDay[] {
  const groups: CommitDay[] = [];
  const formatter = new Intl.DateTimeFormat(locale, { month: "short", day: "numeric", year: "numeric" });
  for (const commit of commits) {
    const date = new Date(commit.authored_at);
    const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
    const last = groups.at(-1);
    if (last && last.key === key) {
      last.commits.push(commit);
    } else {
      groups.push({ key, label: formatter.format(date), commits: [commit] });
    }
  }
  return groups;
}

export { hueFromString } from "./CommitAuthor.tsx";


function CommitRow({ owner, repo, commit }: { owner: string; repo: string; commit: Commit }): ReactNode {
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);
  const body = commit.body?.trim() ?? "";
  const bodyId = `commit-body-${commit.sha}`;

  return (
    <li className="commit-row">
      <div className="commit-row-main">
        <div className="commit-row-title">
          <Link to={`/${owner}/${repo}/commit/${commit.sha}`} className="commit-row-subject">
            {commit.message}
          </Link>
          {body ? (
            <button
              type="button"
              className="commit-body-toggle"
              aria-expanded={expanded}
              aria-controls={bodyId}
              aria-label={expanded ? "Hide description" : "Show description"}
              title={expanded ? "Hide description" : "Show description"}
              onClick={() => setExpanded((value) => !value)}
            >
              <span aria-hidden="true">{"\u2026"}</span>
            </button>
          ) : null}
        </div>
        {body && expanded ? (
          <pre id={bodyId} className="commit-row-body">
            {body}
          </pre>
        ) : null}
        <div className="commit-row-meta">
          <CommitAuthor author={commit.author} /> committed{" "}
          <time dateTime={new Date(commit.authored_at).toISOString()} title={new Date(commit.authored_at).toLocaleString()}>
            {timeAgo(commit.authored_at)}
          </time>
        </div>
      </div>
      <div className="commit-row-actions">
        <button
          type="button"
          className="commit-sha-button mono"
          title={`Copy full SHA ${commit.sha}`}
          aria-label={`Copy full SHA for ${commit.short_sha}`}
          onClick={() => {
            void copyText(commit.sha).then((ok) => {
              setCopied(ok);
              if (ok) setTimeout(() => setCopied(false), 1500);
            });
          }}
        >
          {copied ? "Copied!" : commit.short_sha}
          <Icon name={copied ? "check" : "copy"} />
        </button>
        <Link
          to={`/${owner}/${repo}/tree/${commit.sha}`}
          className="commit-browse"
          title="Browse the repository at this point in the history"
          ariaLabel={`Browse files at ${commit.short_sha}`}
        >
          <Icon name="code" />
        </Link>
      </div>
    </li>
  );
}

export function CommitHistory({
  owner,
  repo,
  commits,
}: {
  owner: string;
  repo: string;
  commits: readonly Commit[];
}): ReactNode {
  return (
    <div className="commit-history">
      {groupCommitsByDay(commits).map((day) => (
        <section key={day.key} className="commit-day" aria-label={`Commits on ${day.label}`}>
          <h4 className="commit-day-label">
            <Icon name="commit" className="commit-day-icon" />
            Commits on {day.label}
          </h4>
          <ol className="commit-day-list">
            {day.commits.map((commit) => (
              <CommitRow key={commit.sha} owner={owner} repo={repo} commit={commit} />
            ))}
          </ol>
        </section>
      ))}
    </div>
  );
}

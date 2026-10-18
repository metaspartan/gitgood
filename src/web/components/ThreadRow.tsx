import type { ReactNode } from "react";
import { Link } from "../router.tsx";
import { timeAgo } from "../components.tsx";
import { Icon, type IconName } from "./Icons.tsx";

export type ThreadState = "open" | "closed" | "merged";

export function threadStateIcon(kind: "issue" | "pull", state: string): { icon: IconName; tone: string; label: string } {
  if (kind === "issue") {
    return state === "open"
      ? { icon: "issue", tone: "is-open", label: "Open issue" }
      : { icon: "issueClosed", tone: "is-done", label: "Closed issue" };
  }
  if (state === "merged") return { icon: "pullMerged", tone: "is-done", label: "Merged pull request" };
  if (state === "closed") return { icon: "pullClosed", tone: "is-closed", label: "Closed pull request" };
  return { icon: "pull", tone: "is-open", label: "Open pull request" };
}

export function ThreadRow({
  kind,
  href,
  state,
  title,
  number,
  createdAt,
  author,
  labels,
  extra,
  comments,
  aside,
}: {
  kind: "issue" | "pull";
  href: string;
  state: string;
  title: string;
  number: number;
  createdAt: number;
  author?: string | null;
  labels?: readonly string[];
  extra?: ReactNode;
  comments: number;
  aside?: ReactNode;
}): ReactNode {
  const status = threadStateIcon(kind, state);
  return (
    <li className="thread-row">
      <span className={`thread-state ${status.tone}`} title={status.label}>
        <Icon name={status.icon} />
        <span className="sr-only">{status.label}</span>
      </span>
      <div className="thread-main">
        <div className="thread-title-line">
          <Link to={href} className="thread-title">
            {title}
          </Link>
          {labels?.map((label) => (
            <span key={label} className="thread-label">
              {label}
            </span>
          ))}
        </div>
        <div className="thread-meta">
          #{number} opened <time dateTime={new Date(createdAt).toISOString()} title={new Date(createdAt).toLocaleString()}>{timeAgo(createdAt)}</time>
          {author ? <> by {author}</> : null}
          {extra ? <> · {extra}</> : null}
        </div>
      </div>
      <div className="thread-aside">
        {aside}
        {comments > 0 ? (
          <Link to={href} className="thread-comments muted-link" aria-label={`${comments} ${comments === 1 ? "comment" : "comments"}`}>
            <Icon name="comment" />
            {comments}
          </Link>
        ) : null}
      </div>
    </li>
  );
}

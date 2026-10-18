import { useState, type ReactNode } from "react";
import { api } from "../api.ts";
import { useAsync } from "../components.tsx";
import { EmptyState, ErrorBanner, timeAgo } from "../components.tsx";
import type { ThreadEvent } from "../types.ts";
import "./ThreadTimeline.css";

function describe(event: ThreadEvent): string {
  const label = typeof event.detail.label === "string" ? event.detail.label : null;
  const assignee = typeof event.detail.assignee === "string" ? event.detail.assignee : null;
  const from = typeof event.detail.from === "string" ? event.detail.from : null;
  const to = typeof event.detail.to === "string" ? event.detail.to : null;
  switch (event.kind) {
    case "closed":
      return "closed this";
    case "reopened":
      return "reopened this";
    case "labeled":
      return `added the ${label} label`;
    case "unlabeled":
      return `removed the ${label} label`;
    case "assigned":
      return `assigned ${assignee}`;
    case "unassigned":
      return `unassigned ${assignee}`;
    case "milestone_changed":
      if (to && from) return `moved this from ${from} to ${to}`;
      return to ? `moved this to ${to}` : "removed this from its milestone";
    case "commented":
      return "commented";
    case "merged":
      return "merged this";
    case "review_approved":
      return "approved these changes";
    case "review_requested":
      return "requested a review";
    default:
      return event.kind.replace(/_/g, " ");
  }
}

const ACTIVE_KINDS = new Set<ThreadEvent["kind"]>([
  "closed",
  "reopened",
  "labeled",
  "unlabeled",
  "assigned",
  "unassigned",
  "milestone_changed",
  "commented",
  "merged",
  "review_approved",
  "review_requested",
]);

export function ThreadTimeline({
  owner,
  repo,
  kind,
  number,
  commentCount,
}: {
  owner: string;
  repo: string;
  kind: "issue" | "pull";
  number: number;
  commentCount: number;
}): ReactNode {
  const events = useAsync(() => api.threadEvents(owner, repo, kind, number), [owner, repo, kind, number]);
  const [showAll, setShowAll] = useState(false);

  const items = events.data?.items ?? [];
  const hidden = Math.max(0, items.length - 5);
  const visible = showAll ? items : items.slice(hidden);

  if (!events.loading && items.length === 0 && commentCount === 0) {
    return null;
  }

  return (
    <section className="thread-timeline" aria-label="Activity">
      <ErrorBanner message={events.error} />
      <ol className="thread-timeline-list">
        {hidden > 0 && !showAll ? (
          <li className="thread-timeline-more">
            <button type="button" onClick={() => setShowAll(true)}>
              Show {hidden} earlier {hidden === 1 ? "event" : "events"}
            </button>
          </li>
        ) : null}
        {visible.map((event) => {
          if (!ACTIVE_KINDS.has(event.kind)) return null;
          const who = event.actor;
          return (
            <li key={event.id} className={`thread-event thread-event-${event.kind}`}>
              <span className="thread-event-avatar">
                {who ? (
                  <span className="avatar" aria-hidden="true">
                    {(who.display_name || who.username).slice(0, 1).toUpperCase()}
                  </span>
                ) : (
                  <span className="avatar" aria-hidden="true">⌁</span>
                )}
              </span>
              <span className="thread-event-body">
                {who ? (
                  <span className="thread-event-actor">
                    <span className="thread-event-name">{who.username}</span>
                    {who.id === null ? <span className="faint small"> (no longer on this instance)</span> : null}
                  </span>
                ) : (
                  <span className="thread-event-actor faint">This instance</span>
                )}{" "}
                {describe(event)}
                <span className="faint small"> · {timeAgo(event.created_at)}</span>
              </span>
            </li>
          );
        })}
      </ol>
      {items.length === 0 && !events.loading && commentCount > 0 ? (
        <EmptyState title="No activity yet" hint="Closing this or adding a label will show up here." />
      ) : null}
      {showAll && items.length > 5 ? (
        <button type="button" className="ghost small" onClick={() => setShowAll(false)}>
          Show less
        </button>
      ) : null}
    </section>
  );
}

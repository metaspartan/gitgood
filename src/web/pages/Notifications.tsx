import { useState, type ReactNode } from "react";
import { api, splitRepoFullName } from "../api.ts";
import { EmptyState, ErrorBanner, Spinner, timeAgo, Badge, useAsync } from "../components.tsx";
import { Link } from "../router.tsx";
import { useSession } from "../App.tsx";
import type { Notification } from "../types.ts";

const KIND_LABEL: Record<string, string> = {
  issue_opened: "opened an issue",
  issue_closed: "closed an issue",
  issue_commented: "commented on an issue",
  issue_assigned: "assigned you an issue",
  pull_opened: "opened a pull request",
  pull_merged: "merged a pull request",
  pull_closed: "closed a pull request",
  pull_commented: "commented on a pull request",
  pull_assigned: "assigned you a pull request",
  push: "pushed to",
  repository_over_quota: "is over its storage limit",
};

function destination(item: Notification): string | null {
  if (!item.repository) return null;
  const parts = splitRepoFullName(item.repository);
  if (!parts) return null;
  const base = `/${parts.owner}/${parts.name}`;
  if (!item.subject) return base;
  if (item.subject.type === "issue" && item.subject.number !== null) {
    return `${base}/issues/${item.subject.number}`;
  }
  if (item.subject.type === "pull" && item.subject.number !== null) {
    return `${base}/pulls/${item.subject.number}`;
  }
  return base;
}

function Row({
  item,
  onToggle,
  onDismiss,
}: {
  item: Notification;
  onToggle: (item: Notification) => void;
  onDismiss: (item: Notification) => void;
}): ReactNode {
  const to = destination(item);
  const label = KIND_LABEL[item.kind] ?? item.kind.replace(/_/g, " ");
  const subject = item.subject?.title ?? "";

  return (
    <div className={`notification${item.unread ? " unread" : ""}`}>
      <span className="notification-dot" aria-hidden="true" />
      <div className="notification-body">
        <div className="small">
          {item.actor ? <span className="mono">{item.actor}</span> : <span className="muted">Someone</span>}{" "}
          <span className="muted">{label}</span>{" "}
          {item.repository ? (
            to ? (
              <Link to={`/${item.repository}`} className="mono">
                {item.repository}
              </Link>
            ) : (
              <span className="mono">{item.repository}</span>
            )
          ) : null}
        </div>
        {subject ? (
          <div>
            {to ? (
              <Link to={to}>{subject}</Link>
            ) : (
              <span className="muted">{subject}</span>
            )}
            {item.subject?.number !== null && item.subject?.number !== undefined ? (
              <span className="faint small"> #{item.subject.number}</span>
            ) : null}
          </div>
        ) : null}
        <div className="faint small">{timeAgo(item.updated_at)}</div>
      </div>
      <div className="row" style={{ gap: 4 }}>
        <button className="ghost small" onClick={() => onToggle(item)}>
          {item.unread ? "Mark read" : "Mark unread"}
        </button>
        <button className="ghost small" onClick={() => onDismiss(item)} aria-label="Dismiss">
          Dismiss
        </button>
      </div>
    </div>
  );
}

export function NotificationsPage(): ReactNode {
  const { user } = useSession();
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [page, setPage] = useState(1);
  const list = useAsync(
    () => api.notifications({ unread: unreadOnly, page }),
    [unreadOnly, page],
  );

  if (!user) {
    return (
      <div className="card">
        <h2>Notifications</h2>
        <p className="muted">
          <Link to="/login">Sign in</Link> to see your notifications.
        </p>
      </div>
    );
  }

  const items = list.data?.items ?? [];
  const unread = list.data?.unread ?? 0;
  const total = list.data?.total ?? 0;
  const perPage = list.data?.per_page ?? 30;
  const lastPage = Math.max(1, Math.ceil(total / perPage));

  const toggle = async (item: Notification): Promise<void> => {
    await api.readNotification(item.id, item.unread);
    list.reload();
  };

  const dismiss = async (item: Notification): Promise<void> => {
    await api.deleteNotification(item.id);
    list.reload();
  };

  return (
    <>
      <div className="card">
        <div className="row wrap">
          <h2 style={{ margin: 0 }}>Notifications</h2>
          {unread > 0 ? <Badge kind="private">{unread} unread</Badge> : null}
          <span className="spacer" />
          <button
            className={unreadOnly ? "" : "ghost"}
            onClick={() => {
              setUnreadOnly((value) => !value);
              setPage(1);
            }}
          >
            {unreadOnly ? "Showing unread" : "Showing all"}
          </button>
          {unread > 0 ? (
            <button
              className="ghost"
              onClick={() => {
                void api.readAllNotifications().then(() => list.reload());
              }}
            >
              Mark all read
            </button>
          ) : null}
          {items.length > 0 ? (
            <button
              className="ghost"
              onClick={() => {
                void api.clearNotifications().then(() => list.reload());
              }}
            >
              Clear all
            </button>
          ) : null}
        </div>
      </div>

      <div className="card">
        <ErrorBanner message={list.error} />
        {list.loading ? (
          <Spinner label="Loading notifications" />
        ) : items.length === 0 ? (
          <EmptyState
            title={unreadOnly ? "Nothing unread" : "No notifications yet"}
            hint={
              unreadOnly
                ? "Everything has been read."
                : "Watch a repository or take part in an issue to start receiving them."
            }
          />
        ) : (
          <div className="notification-list">
            {items.map((item) => (
              <Row key={item.id} item={item} onToggle={toggle} onDismiss={dismiss} />
            ))}
          </div>
        )}
      </div>

      {lastPage > 1 ? (
        <div className="card">
          <div className="row">
            <button
              className="ghost"
              disabled={page <= 1}
              onClick={() => setPage((value) => Math.max(1, value - 1))}
            >
              Previous
            </button>
            <span className="faint small">
              Page {page} of {lastPage}
            </span>
            <button
              className="ghost"
              disabled={page >= lastPage}
              onClick={() => setPage((value) => value + 1)}
            >
              Next
            </button>
          </div>
        </div>
      ) : null}
    </>
  );
}

export function useUnreadCount(): number {
  const { user } = useSession();
  const state = useAsync(
    () => (user ? api.unreadCount() : Promise.resolve({ unread: 0 })),
    [user?.id ?? 0],
  );
  return state.data?.unread ?? 0;
}

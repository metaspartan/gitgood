import { useState, type ReactNode } from "react";
import { api } from "../api.ts";
import { useSession } from "../App.tsx";
import { Avatar, ErrorBanner, Markdown, timeAgo, useAsync } from "../components.tsx";
import { referenceHref } from "../issue-reference.ts";
import { Link } from "../router.tsx";
import type { Comment, ReactionContent, ReactionSummary } from "../types.ts";
import { usePopover } from "../use-popover.ts";
import { Icon } from "./Icons.tsx";

export const REACTION_EMOJI: Record<ReactionContent, { emoji: string; label: string }> = {
  "+1": { emoji: "\u{1F44D}", label: "Thumbs up" },
  "-1": { emoji: "\u{1F44E}", label: "Thumbs down" },
  laugh: { emoji: "\u{1F604}", label: "Laugh" },
  hooray: { emoji: "\u{1F389}", label: "Hooray" },
  confused: { emoji: "\u{1F615}", label: "Confused" },
  heart: { emoji: "\u2764\uFE0F", label: "Heart" },
  rocket: { emoji: "\u{1F680}", label: "Rocket" },
  eyes: { emoji: "\u{1F440}", label: "Eyes" },
};

export function toggleReaction(reactions: readonly ReactionSummary[], content: ReactionContent): { next: ReactionSummary[]; adding: boolean } {
  const existing = reactions.find((reaction) => reaction.content === content);
  const adding = !existing?.me;
  const order = Object.keys(REACTION_EMOJI) as ReactionContent[];
  const next = reactions
    .map((reaction) => (reaction.content === content ? { ...reaction, count: reaction.count + (adding ? 1 : -1), me: adding } : reaction))
    .filter((reaction) => reaction.count > 0);
  if (!existing && adding) next.push({ content, count: 1, me: true });
  next.sort((a, b) => order.indexOf(a.content) - order.indexOf(b.content));
  return { next, adding };
}

function ReactionBar({ owner, repo, comment, canReact }: { owner: string; repo: string; comment: Comment; canReact: boolean }): ReactNode {
  const [reactions, setReactions] = useState<ReactionSummary[]>(comment.reactions ?? []);
  const picker = usePopover<HTMLDivElement>();

  const toggle = async (content: ReactionContent): Promise<void> => {
    picker.setOpen(false);
    if (!canReact) return;
    const previous = reactions;
    const { next, adding } = toggleReaction(reactions, content);
    setReactions(next);
    try {
      const result = adding ? await api.addReaction(owner, repo, comment.id, content) : await api.removeReaction(owner, repo, comment.id, content);
      setReactions(result.reactions);
    } catch {
      setReactions(previous);
    }
  };

  if (!canReact && reactions.length === 0) return null;
  return (
    <div className="reaction-bar">
      {canReact ? (
        <div className="reaction-picker-wrap" ref={picker.ref}>
          <button type="button" className="reaction-add" aria-label="Add a reaction" aria-haspopup="menu" aria-expanded={picker.open} onClick={() => picker.setOpen((v) => !v)}>
            <Icon name="smiley" />
          </button>
          {picker.open ? (
            <div className="reaction-picker" role="menu" aria-label="Pick a reaction">
              {(Object.keys(REACTION_EMOJI) as ReactionContent[]).map((content) => {
                const active = reactions.some((reaction) => reaction.content === content && reaction.me);
                return (
                  <button key={content} type="button" role="menuitemcheckbox" aria-checked={active} title={REACTION_EMOJI[content].label} className={active ? "is-active" : ""} onClick={() => void toggle(content)}>
                    {REACTION_EMOJI[content].emoji}
                  </button>
                );
              })}
            </div>
          ) : null}
        </div>
      ) : null}
      {reactions.map((reaction) => (
        <button
          key={reaction.content}
          type="button"
          className={`reaction-pill${reaction.me ? " is-mine" : ""}`}
          aria-pressed={reaction.me}
          aria-label={`${REACTION_EMOJI[reaction.content].label}: ${reaction.count}`}
          disabled={!canReact}
          onClick={() => void toggle(reaction.content)}
        >
          <span aria-hidden="true">{REACTION_EMOJI[reaction.content].emoji}</span>
          <span className="reaction-count">{reaction.count}</span>
        </button>
      ))}
    </div>
  );
}

function CommentEditor({ initial, submitLabel, busy, onSubmit, onCancel, owner, repo, autoFocus }: {
  initial: string;
  submitLabel: string;
  busy: boolean;
  onSubmit: (body: string) => void;
  onCancel?: () => void;
  owner: string;
  repo: string;
  autoFocus?: boolean;
}): ReactNode {
  const [body, setBody] = useState(initial);
  const [tab, setTab] = useState<"write" | "preview">("write");
  return (
    <form
      className="comment-editor"
      onSubmit={(event) => {
        event.preventDefault();
        if (body.trim()) onSubmit(body);
      }}
    >
      <div className="comment-editor-tabs" role="group" aria-label="Editor mode">
        <button type="button" aria-pressed={tab === "write"} className={tab === "write" ? "active" : ""} onClick={() => setTab("write")}>Write</button>
        <button type="button" aria-pressed={tab === "preview"} className={tab === "preview" ? "active" : ""} onClick={() => setTab("preview")}>Preview</button>
      </div>
      <div className="comment-editor-body">
        {tab === "write" ? (
          <textarea
            value={body}
            aria-label="Comment"
            placeholder="Leave a comment"
            autoFocus={autoFocus}
            onChange={(event) => setBody(event.target.value)}
            onKeyDown={(event) => {
              if ((event.ctrlKey || event.metaKey) && event.key === "Enter" && body.trim()) {
                event.preventDefault();
                onSubmit(body);
              }
            }}
          />
        ) : (
          <div className="comment-preview">
            {body.trim() ? <Markdown source={body} resolveReference={(raw) => referenceHref(owner, repo, raw)} /> : <p className="faint small">Nothing to preview</p>}
          </div>
        )}
      </div>
      <div className="comment-editor-footer">
        <span className="small faint">Markdown is supported</span>
        <span className="spacer" />
        {onCancel ? <button type="button" onClick={onCancel}>Cancel</button> : null}
        <button type="submit" className="primary" disabled={busy || !body.trim()}>{submitLabel}</button>
      </div>
    </form>
  );
}

function CommentItem({ owner, repo, comment, canModerate, onChanged }: {
  owner: string;
  repo: string;
  comment: Comment;
  canModerate: boolean;
  onChanged: () => void;
}): ReactNode {
  const { user } = useSession();
  const menu = usePopover<HTMLDivElement>();
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isAuthor = user !== null && comment.author?.id === user.id;
  const canEdit = isAuthor || user?.is_admin === true;
  const canDelete = isAuthor || canModerate;
  const anchor = `issuecomment-${comment.id}`;

  const save = async (body: string): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await api.editComment(owner, repo, comment.id, body);
      setEditing(false);
      onChanged();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not update the comment");
    } finally {
      setBusy(false);
    }
  };

  const remove = async (): Promise<void> => {
    menu.setOpen(false);
    if (!window.confirm("Delete this comment? This cannot be undone.")) return;
    try {
      await api.deleteComment(owner, repo, comment.id);
      onChanged();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not delete the comment");
    }
  };

  return (
    <li className="timeline-comment-item" id={anchor}>
      <div className="timeline-avatar">{comment.author ? <Avatar user={comment.author} size="lg" /> : null}</div>
      <div className={`timeline-comment${isAuthor ? " is-own" : ""}`}>
        <div className="timeline-comment-header">
          <span className="timeline-comment-meta">
            {comment.author ? <Link to={`/${comment.author.username}`} className="timeline-author">{comment.author.username}</Link> : <strong>ghost</strong>}
            <span className="muted"> commented </span>
            <a href={`#${anchor}`} className="muted-link" title={new Date(comment.created_at).toLocaleString()}>{timeAgo(comment.created_at)}</a>
            {comment.updated_at ? <span className="muted" title={`Edited ${new Date(comment.updated_at).toLocaleString()}`}> · edited</span> : null}
          </span>
          <span className="spacer" />
          {isAuthor ? <span className="badge timeline-role">Author</span> : null}
          {user ? (
            <div className="btn-group" ref={menu.ref}>
              <button type="button" className="ghost icon-only timeline-menu" aria-label="Comment actions" aria-haspopup="menu" aria-expanded={menu.open} onClick={() => menu.setOpen((v) => !v)}>
                <Icon name="kebab" />
              </button>
              {menu.open ? (
                <div className="action-menu" role="menu">
                  <button type="button" role="menuitem" className="action-menu-item" onClick={() => { menu.setOpen(false); void navigator.clipboard?.writeText(`${location.origin}${location.pathname}#${anchor}`); }}>
                    <span className="action-menu-text"><strong>Copy link</strong></span>
                  </button>
                  {canEdit ? (
                    <button type="button" role="menuitem" className="action-menu-item" onClick={() => { menu.setOpen(false); setEditing(true); }}>
                      <span className="action-menu-text"><strong>Edit</strong></span>
                    </button>
                  ) : null}
                  {canDelete ? (
                    <button type="button" role="menuitem" className="action-menu-item danger-text" onClick={() => void remove()}>
                      <span className="action-menu-text"><strong>Delete</strong></span>
                    </button>
                  ) : null}
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
        <ErrorBanner message={error} />
        {editing ? (
          <div className="timeline-comment-edit">
            <CommentEditor initial={comment.body} submitLabel="Update comment" busy={busy} owner={owner} repo={repo} autoFocus onSubmit={(body) => void save(body)} onCancel={() => setEditing(false)} />
          </div>
        ) : (
          <div className="timeline-comment-body">
            <Markdown source={comment.body} resolveReference={(raw) => referenceHref(owner, repo, raw)} />
          </div>
        )}
        <ReactionBar owner={owner} repo={repo} comment={comment} canReact={user !== null} />
      </div>
    </li>
  );
}

export function CommentThread({
  owner,
  repo,
  comments,
  onAdd,
  onChanged,
}: {
  owner: string;
  repo: string;
  comments: readonly Comment[];
  onAdd: (body: string) => Promise<void>;
  onChanged: () => void;
}): ReactNode {
  const { user } = useSession();
  const detail = useAsync(() => api.repo(owner, repo), [owner, repo]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [formKey, setFormKey] = useState(0);
  const canModerate = detail.data?.permissions?.write === true;

  return (
    <section className="comment-thread" aria-label="Comments">
      <ol className="timeline-comments">
        {comments.map((comment) => (
          <CommentItem key={`${comment.id}-${comment.updated_at ?? 0}`} owner={owner} repo={repo} comment={comment} canModerate={canModerate} onChanged={onChanged} />
        ))}
      </ol>
      {user ? (
        <div className="timeline-comment-item timeline-new">
          <div className="timeline-avatar"><Avatar user={user} size="lg" /></div>
          <div className="timeline-comment">
            <div className="timeline-comment-header"><strong>Add a comment</strong></div>
            <ErrorBanner message={error} />
            <CommentEditor
              key={formKey}
              initial=""
              submitLabel="Comment"
              busy={busy}
              owner={owner}
              repo={repo}
              onSubmit={(body) => {
                setBusy(true);
                setError(null);
                onAdd(body)
                  .then(() => setFormKey((key) => key + 1))
                  .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : "Could not post comment"))
                  .finally(() => setBusy(false));
              }}
            />
          </div>
        </div>
      ) : (
        <p className="small muted timeline-signin">
          <Link to="/login">Sign in</Link> to join this conversation.
        </p>
      )}
    </section>
  );
}

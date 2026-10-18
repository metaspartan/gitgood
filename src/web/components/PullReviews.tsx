import { request } from "../api.ts";
import { useEffect, useRef, useState } from "react";
import { useSession } from "../App.tsx";
import { ErrorBanner, Markdown, timeAgo } from "../components.tsx";
import { useLive } from "../use-live.ts";
import { LiveStatus } from "./LiveStatus.tsx";
import "./PullReviews.css";

type ReviewEvent = "APPROVE" | "REQUEST_CHANGES" | "COMMENT";
interface ReviewSummary {
  items: Array<{ id: number; user: { id: number; username: string }; event: ReviewEvent; body: string; commit_id: string; created_at: number }>;
  head_sha: string | null;
  approvals: number;
  changes_requested: number;
  required_approvals: number;
  require_checks: boolean;
  can_review: boolean;
  can_manage_policy: boolean;
}

export function PullReviews({ owner, repo, number, base, open, onChanged }: {
  owner: string; repo: string; number: number; base: string; open: boolean; onChanged: () => void;
}) {
  const { user } = useSession();
  const prefix = `/api/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  const state = useLive(signal => request<ReviewSummary>(`${prefix}/pulls/${number}/reviews`, { signal }), [owner, repo, number, user?.id, open]);
  const [body, setBody] = useState("");
  const [event, setEvent] = useState<ReviewEvent>("COMMENT");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const [required, setRequired] = useState(0);
  const [checks, setChecks] = useState(false);
  const [reviewSha, setReviewSha] = useState<string | null>(null);
  const previousHead = useRef<string | null>(null);
  const notifyChanged = useRef(onChanged);
  notifyChanged.current = onChanged;
  useEffect(() => {
    const head = state.data?.head_sha;
    if (!head) return;
    if (previousHead.current && previousHead.current !== head) notifyChanged.current();
    previousHead.current = head;
  }, [state.data?.head_sha]);
  useEffect(() => {
    setRequired(state.data?.required_approvals ?? 0);
    setChecks(state.data?.require_checks ?? false);
  }, [state.data?.required_approvals, state.data?.require_checks]);
  useEffect(() => {
    if (!body && event === "COMMENT") setReviewSha(state.data?.head_sha ?? null);
  }, [state.data?.head_sha, body, event]);
  useEffect(() => { setBody(""); setEvent("COMMENT"); setError(null); setNotice(""); setReviewSha(null); }, [owner, repo, number]);
  const stale = reviewSha !== null && reviewSha !== state.data?.head_sha;
  const submit = async () => {
    if (!reviewSha || stale) return;
    setBusy(true); setError(null); setNotice("");
    try {
      await request(`${prefix}/pulls/${number}/reviews`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ event, body, commit_id: reviewSha }) });
      setBody(""); setEvent("COMMENT"); setNotice("Review submitted."); state.reload(); onChanged();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Review failed"); state.reload(); }
    finally { setBusy(false); }
  };
  const savePolicy = async () => {
    setBusy(true); setError(null); setNotice("");
    try {
      await request(`${prefix}/pull-merge-policy`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ branch: base, required_approvals: required, require_checks: checks }) });
      setNotice("Pull-request merge policy saved."); state.reload(); onChanged();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Policy could not be saved"); }
    finally { setBusy(false); }
  };
  const canManage = state.data?.can_manage_policy === true;
  return <section className="card pull-reviews" aria-label="Pull request reviews">
    <div className="pull-review-heading"><div><h3>Reviews & merge requirements</h3><p className="muted small">Review the current changes before approving. New commits invalidate earlier approvals.</p></div><LiveStatus {...state} /></div>
    <ErrorBanner message={error ?? state.error} />
    {state.data ? <>
      <div className="pull-review-summary">
        <span><strong>{state.data.approvals}</strong> / {state.data.required_approvals} required approvals</span>
        <span>{state.data.changes_requested ? `${state.data.changes_requested} reviewer(s) requesting changes` : "No change requests"}</span>
        <span>{state.data.require_checks ? "Successful checks required" : "Successful checks not required"}</span>
      </div>
      <p className="small faint">These approval rules govern PR merges. To prevent direct pushes, also enable Protected branches in repository Settings. Change requests remain blocking until that reviewer approves.</p>
      {canManage ? <details className="pull-review-policy"><summary>Manage merge requirements for <code>{base}</code></summary>
        <form onSubmit={e => { e.preventDefault(); void savePolicy(); }}>
          <label htmlFor="required-approvals">Required approvals</label><select id="required-approvals" value={required} onChange={e => setRequired(Number(e.target.value))}>{[0, 1, 2, 3, 4, 5, 6].map(n => <option key={n} value={n}>{n}</option>)}</select>
          <label className="row"><input type="checkbox" checked={checks} onChange={e => setChecks(e.target.checked)} />Require successful checks for the current commit</label>
          <p className="small faint">With production CI disabled, requiring checks will prevent merging until an appropriate successful check exists. This is not a GitHub branch-protection rule.</p>
          <button type="submit" disabled={busy}>Save merge requirements</button>
        </form>
      </details> : null}
      {state.data.items.length ? <ol className="pull-review-history">{state.data.items.map(review => <li key={review.id}>
        <div className="row wrap"><strong>{review.user.username}</strong><span className={`badge review-${review.event.toLowerCase()}`}>{review.event === "APPROVE" ? "Approved" : review.event === "REQUEST_CHANGES" ? "Requested changes" : "Commented"}</span><span className="small faint">{timeAgo(review.created_at)} · <code>{review.commit_id.slice(0, 8)}</code>{review.event === "APPROVE" && review.commit_id !== state.data?.head_sha ? " · outdated approval" : ""}</span></div>
        {review.body ? <Markdown source={review.body} /> : null}
      </li>)}</ol> : <p className="muted small">No reviews yet.</p>}
      {user && open && state.data.head_sha ? <form className="pull-review-compose" onSubmit={e => { e.preventDefault(); void submit(); }}>
        <label htmlFor="review-body">Your review</label><textarea id="review-body" maxLength={65536} rows={3} value={body} onChange={e => { if (!body) setReviewSha(state.data?.head_sha ?? null); setBody(e.target.value); }} placeholder="Explain your feedback (Markdown supported)" />
        <div className="row wrap"><label htmlFor="review-event">Decision</label><select id="review-event" value={event} onChange={e => { setEvent(e.target.value as ReviewEvent); if (!body) setReviewSha(state.data?.head_sha ?? null); }}><option value="COMMENT">Comment</option>{state.data.can_review ? <><option value="APPROVE">Approve</option><option value="REQUEST_CHANGES">Request changes</option></> : null}</select><button type="submit" className="primary" disabled={busy || stale || !reviewSha || (event !== "APPROVE" && !body.trim())}>{busy ? "Submitting…" : "Submit review"}</button></div>
        {!state.data.can_review ? <p className="small faint">Only other repository writers can approve or request changes.</p> : null}
        {stale ? <div role="alert"><p>The branch changed while you were reviewing. Inspect the new diff before submitting.</p><button type="button" onClick={() => setReviewSha(state.data?.head_sha ?? null)}>I reviewed the latest commit</button></div> : null}
      </form> : null}
    </> : null}
    <p className="small" role="status">{notice}</p>
  </section>;
}

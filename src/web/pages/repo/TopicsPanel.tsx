import { useState } from "react";
import { request } from "../../api.ts";
import { useLive } from "../../use-live.ts";
import { ErrorBanner } from "../../components.tsx";
import { LiveStatus } from "../../components/LiveStatus.tsx";
import "./TopicsPanel.css";

interface TopicsResponse {
  topics: string[];
  topics_csv: string;
  max_topics: number;
}

export function TopicsPanel({ owner, repo, canEdit }: { owner: string; repo: string; canEdit: boolean }) {
  const base = `/api/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/topics`;
  const state = useLive((signal) => request<TopicsResponse>(base, { signal }), [owner, repo]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState("");

  const save = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    setNotice("");
    try {
      const names = draft.split(",").map((name) => name.trim()).filter(Boolean);
      const saved = await request<TopicsResponse>(base, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ names }),
      });
      setDraft(saved.topics_csv);
      setNotice(saved.topics.length === 0 ? "Topics cleared." : `Saved ${saved.topics.length} topic${saved.topics.length === 1 ? "" : "s"}.`);
      state.reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save the topics");
    } finally {
      setBusy(false);
    }
  };

  const topics = state.data?.topics ?? [];
  return (
    <section className="topics-panel" aria-label="Topics">
      <div className="topics-heading">
        <div>
          <h3>Topics</h3>
          <p className="small muted">
            Words that describe what this repository <em>is</em>, so it can be found by them. Lowercase
            letters, digits and hyphens; up to {state.data?.max_topics ?? 20}.
          </p>
        </div>
        <LiveStatus {...state} />
      </div>
      <ErrorBanner message={error ?? state.error} />
      {topics.length > 0 ? (
        <ul className="topic-list">
          {topics.map((topic) => (
            <li key={topic}>
              <a href={`/search?q=topic:${encodeURIComponent(topic)}`} className="topic-chip">
                {topic}
              </a>
            </li>
          ))}
        </ul>
      ) : (
        <p className="small muted">
          {state.loading ? "Loading topics…" : "No topics yet. A repository with topics is easier to find."}
        </p>
      )}
      {canEdit ? (
        <form
          className="topic-form"
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <label htmlFor="repo-topics">Topics</label>
          <input
            id="repo-topics"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder="backend, database, web-api"
            maxLength={1200}
            autoComplete="off"
            spellCheck={false}
            disabled={busy}
            aria-describedby="repo-topics-hint"
          />
          <p id="repo-topics-hint" className="small faint">
            Comma separated. Saving replaces the list, so the field always shows what is currently set.
          </p>
          <button type="submit" disabled={busy || draft === (state.data?.topics_csv ?? "")}>
            {busy ? "Saving…" : "Save topics"}
          </button>
        </form>
      ) : null}
      <p className="small" role="status">{notice}</p>
    </section>
  );
}

export function TopicBadges({ topics }: { topics: string[] }) {
  if (topics.length === 0) return null;
  return (
    <ul className="topic-list topic-badges" aria-label="Repository topics">
      {topics.map((topic) => (
        <li key={topic}>
          <a href={`/search?q=topic:${encodeURIComponent(topic)}`} className="topic-chip">
            {topic}
          </a>
        </li>
      ))}
    </ul>
  );
}

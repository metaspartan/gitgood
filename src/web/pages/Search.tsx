import { useEffect, useState, type ReactNode } from "react";
import { api } from "../api.ts";
import { Badge, EmptyState, ErrorBanner, Spinner, timeAgo, useAsync } from "../components.tsx";
import { Link, parseLocation, useLocation } from "../router.tsx";
import type { CodeHit, SearchResults } from "../types.ts";

type Mode = "repos" | "code";

function Highlight({ text, needle }: { text: string; needle: string }): ReactNode {
  if (!needle) return <>{text}</>;
  const lower = text.toLowerCase();
  const target = needle.toLowerCase();
  const parts: ReactNode[] = [];
  let cursor = 0;
  let index = lower.indexOf(target);
  let key = 0;
  while (index !== -1) {
    if (index > cursor) parts.push(text.slice(cursor, index));
    parts.push(<mark key={key++}>{text.slice(index, index + needle.length)}</mark>);
    cursor = index + needle.length;
    index = lower.indexOf(target, cursor);
  }
  parts.push(text.slice(cursor));
  return <>{parts}</>;
}

function RepoResults({ results, query }: { results: SearchResults; query: string }): ReactNode {
  const total = results.repos.length + results.issues.length + results.pulls.length;
  return (
    <>
      {total === 0 ? <EmptyState title={`No matches for “${query}”`} /> : null}

      {results.repos.length > 0 ? (
        <div className="filelist">
          {results.repos.map((repo) => (
            <div className="entry" key={repo.id}>
              <div className="name">
                <Link to={`/${repo.owner}/${repo.name}`} style={{ fontWeight: 600 }}>
                  <Highlight text={repo.full_name} needle={query} />
                </Link>
                {repo.visibility === "private" ? <Badge kind="private">private</Badge> : null}
                {repo.description ? (
                  <div className="muted small">
                    <Highlight text={repo.description} needle={query} />
                  </div>
                ) : null}
              </div>
              <div className="size faint small">{timeAgo(repo.updated_at)}</div>
            </div>
          ))}
        </div>
      ) : null}

      {results.issues.length > 0 ? (
        <div style={{ marginTop: 18 }}>
          <h3>Issues</h3>
          <div className="filelist">
            {results.issues.map((issue) => (
              <div className="entry" key={issue.id}>
                <div className="name">
                  <Link to={`/${issue.repository}/issues/${issue.number}`} style={{ fontWeight: 600 }}>
                    <Highlight text={issue.title} needle={query} />
                  </Link>
                  <div className="muted small mono">
                    {issue.repository} #{issue.number}
                  </div>
                </div>
                <Badge kind={issue.state === "open" ? "open" : "closed"}>{issue.state}</Badge>
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {results.pulls.length > 0 ? (
        <div style={{ marginTop: 18 }}>
          <h3>Pull requests</h3>
          <div className="filelist">
            {results.pulls.map((pull) => (
              <div className="entry" key={pull.id}>
                <div className="name">
                  <Link to={`/${pull.repository}/pulls/${pull.number}`} style={{ fontWeight: 600 }}>
                    <Highlight text={pull.title} needle={query} />
                  </Link>
                  <div className="muted small mono">
                    {pull.repository} #{pull.number}
                  </div>
                </div>
                <Badge
                  kind={pull.state === "merged" ? "merged" : pull.state === "open" ? "open" : "closed"}
                >
                  {pull.state}
                </Badge>
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </>
  );
}

function CodeResults({ hits, query }: { hits: CodeHit[]; query: string }): ReactNode {
  if (hits.length === 0) {
    return (
      <EmptyState
        title={`No file contents match “${query}”`}
        hint="Code search covers the default branch of indexed repositories."
      />
    );
  }
  return (
    <div className="codelist">
      {hits.map((hit, index) => (
        <div className="code-hit" key={`${hit.repository}:${hit.path}:${index}`}>
          <div className="row wrap" style={{ gap: 8, alignItems: "baseline" }}>
            <Link to={`/${hit.repository}`} className="mono small">
              {hit.repository}
            </Link>
            <span className="faint">/</span>
            <span className="mono small">{hit.path}</span>
            {hit.language ? <Badge kind="open">{hit.language}</Badge> : null}
          </div>
          <pre className="code-snippet">
            <Highlight text={hit.snippet.trim()} needle={query} />
          </pre>
        </div>
      ))}
    </div>
  );
}

export function SearchPage({ query }: { query: string }): ReactNode {
  const location = useLocation();
  const params = parseLocation(location).search;
  const mode: Mode = params.get("type") === "code" ? "code" : "repos";
  const [draft, setDraft] = useState(query);

  useEffect(() => setDraft(query), [query]);

  const topicQuery = query.startsWith("topic:") ? query.slice("topic:".length).trim() : "";

  const repos = useAsync(
    () => (query && mode === "repos" && !topicQuery ? api.search(query) : Promise.resolve(null)),
    [query, mode, topicQuery],
  );
  const topicRepos = useAsync(
    () => (topicQuery && mode === "repos" ? api.reposByTopic(topicQuery) : Promise.resolve(null)),
    [topicQuery, mode],
  );
  const code = useAsync(
    () => (query && mode === "code" ? api.searchCode(query) : Promise.resolve(null)),
    [query, mode],
  );

  if (!query) {
    return (
      <div className="card">
        <h2 style={{ marginTop: 0 }}>Search</h2>
        <p className="muted">Type a query in the box above and press enter.</p>
      </div>
    );
  }

  const active = topicQuery ? topicRepos : repos;
  const loading = mode === "repos" ? active.loading : code.loading;
  const error = mode === "repos" ? active.error : code.error;
  const repoCount = topicQuery
    ? (topicRepos.data?.items.length ?? 0)
    : repos.data
      ? repos.data.repos.length + repos.data.issues.length + repos.data.pulls.length
      : 0;
  const codeHits = code.data?.items ?? [];

  const go = (nextMode: Mode, text = query): void => {
    const trimmed = text.trim();
    if (!trimmed) return;
    window.location.assign(
      `/search?q=${encodeURIComponent(trimmed)}${nextMode === "code" ? "&type=code" : ""}`,
    );
  };

  return (
    <>
      <div className="card">
        <div className="row wrap">
          <h2 style={{ margin: 0 }}>
            {topicQuery ? (
              <>
                Repositories tagged <span className="mono">{topicQuery}</span>{" "}
                <Link to="/search" className="small">
                  clear
                </Link>
              </>
            ) : (
              <>
                Results for <span className="mono">{query}</span>
              </>
            )}
          </h2>
          <span className="spacer" />
          <span className="faint small">
            {mode === "repos" ? `${repoCount} matching` : `${codeHits.length} file matches`}
          </span>
        </div>

        <form
          className="row wrap"
          style={{ marginTop: 12 }}
          onSubmit={(event) => {
            event.preventDefault();
            go(mode, draft);
          }}
          role="search"
        >
          <input
            type="search"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            aria-label="Search query"
            style={{ flex: 1, minWidth: 200 }}
          />
          <button type="submit">Search</button>
        </form>

        <div className="tabs" style={{ marginTop: 12, marginBottom: 0 }}>
          <Link
            to={`/search?q=${encodeURIComponent(query)}`}
            className={mode === "repos" ? "active" : ""}
            {...(mode === "repos" ? { ariaCurrent: "page" as const } : {})}
          >
            Repositories &amp; threads
          </Link>
          <Link
            to={`/search?q=${encodeURIComponent(query)}&type=code`}
            className={mode === "code" ? "active" : ""}
            {...(mode === "code" ? { ariaCurrent: "page" as const } : {})}
          >
            Code
          </Link>
        </div>
      </div>

      <div className="card">
        <ErrorBanner message={error} />
        {loading ? (
          <Spinner label={mode === "repos" ? "Searching" : "Searching file contents"} />
        ) : mode === "repos" ? (
          topicQuery
            ? topicRepos.data
              ? <TopicResults result={topicRepos.data} topic={topicQuery} />
              : null
            : repos.data
              ? <RepoResults results={repos.data} query={query} />
              : null
        ) : (
          <>
            <CodeResults hits={codeHits} query={query} />
            {code.data?.at_result_limit ? (
              <p className="faint small" style={{ marginTop: 12 }}>
                Showing the first {codeHits.length} matches. Narrow the query to see more.
              </p>
            ) : null}
            {code.data?.truncated_index ? (
              <p className="faint small" style={{ marginTop: 6 }}>
                Some repositories are not indexed yet, so their contents are not searched.
              </p>
            ) : null}
          </>
        )}
      </div>
    </>
  );
}

interface TopicSearchResult {
  items: Array<{
    full_name: string;
    name: string;
    owner: string;
    description: string;
    html_url?: string;
  }>;
  total: number;
}

function TopicResults({ result, topic }: { result: TopicSearchResult; topic: string }) {
  if (result.items.length === 0) {
    return (
      <EmptyState
        title={`No repositories tagged "${topic}" that you can see`}
        hint="Topics are set on a repository's Settings page."
      />
    );
  }
  return (
    <ul className="list">
      {result.items.map((repo) => (
        <li key={repo.full_name}>
          <Link to={`/${repo.full_name}`} className="repo-name">
            {repo.full_name}
          </Link>
          {repo.description ? <p className="muted small">{repo.description}</p> : null}
        </li>
      ))}
    </ul>
  );
}

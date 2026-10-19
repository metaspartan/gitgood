import { useMemo, useState, type ReactNode } from "react";
import "./User.css";
import { api } from "../api.ts";
import { useSession } from "../App.tsx";
import { Avatar, EmptyState, ErrorBanner, timeAgo, useAsync } from "../components.tsx";
import { Icon } from "../components/Icons.tsx";
import { compactCount } from "../components/RepoSocialActions.tsx";
import { ContributionGraph } from "../components/ContributionGraph.tsx";
import { Link, navigate, useLocation } from "../router.tsx";
import type { Repo } from "../types.ts";

export type ProfileTab = "overview" | "repositories" | "stars";
export type RepoSort = "updated" | "name" | "stars";

export function repoStars(repo: Repo): number {
  return repo.stars ?? repo.stats?.stars ?? 0;
}

export function repoForks(repo: Repo): number {
  return repo.forks ?? repo.stats?.forks ?? 0;
}

export function profileTabFrom(search: string): ProfileTab {
  const tab = new URLSearchParams(search).get("tab");
  return tab === "repositories" || tab === "stars" ? tab : "overview";
}

export function filterAndSortRepos(repos: readonly Repo[], query: string, sort: RepoSort): Repo[] {
  const needle = query.trim().toLowerCase();
  const matched = needle
    ? repos.filter((repo) => repo.name.toLowerCase().includes(needle) || repo.description.toLowerCase().includes(needle))
    : [...repos];
  return matched.sort((x, y) =>
    sort === "name" ? x.name.localeCompare(y.name)
    : sort === "stars" ? repoStars(y) - repoStars(x) || y.updated_at - x.updated_at
    : y.updated_at - x.updated_at,
  );
}

export function popularRepos(repos: readonly Repo[], limit = 6): Repo[] {
  return [...repos]
    .sort((x, y) => repoStars(y) - repoStars(x) || y.updated_at - x.updated_at)
    .slice(0, limit);
}

function joinedLabel(timestamp: number): string {
  return new Date(timestamp).toLocaleDateString(undefined, { month: "long", year: "numeric" });
}

function RepoRow({ repo, showOwner }: { repo: Repo; showOwner: boolean }): ReactNode {
  const stars = repoStars(repo);
  const forks = repoForks(repo);
  return (
    <li className="profile-repo">
      <div className="profile-repo-main">
        <div className="profile-repo-title">
          <Link to={`/${repo.owner}/${repo.name}`} className="profile-repo-name">
            {showOwner ? `${repo.owner} / ` : ""}
            <strong>{repo.name}</strong>
          </Link>
          <span className="badge repo-visibility">{repo.visibility === "private" ? "Private" : "Public"}</span>
          {repo.archived ? <span className="badge">Archived</span> : null}
        </div>
        {repo.description ? <p className="profile-repo-description">{repo.description}</p> : null}
        <div className="profile-repo-meta">
          {stars ? (
            <Link to={`/${repo.owner}/${repo.name}/stargazers`} className="muted-link">
              <Icon name="star" /> {compactCount(stars)}
            </Link>
          ) : null}
          {forks ? (
            <Link to={`/${repo.owner}/${repo.name}/forks`} className="muted-link">
              <Icon name="fork" /> {compactCount(forks)}
            </Link>
          ) : null}
          {repo.openIssues ? <span><Icon name="issue" /> {repo.openIssues}</span> : null}
          <span>Updated {timeAgo(repo.updated_at)}</span>
        </div>
      </div>
    </li>
  );
}

function PinnedCard({ repo }: { repo: Repo }): ReactNode {
  return (
    <li className="pinned-card">
      <div className="pinned-card-head">
        <Icon name={repo.visibility === "private" ? "lock" : "repo"} />
        <Link to={`/${repo.owner}/${repo.name}`} className="profile-repo-name"><strong>{repo.name}</strong></Link>
        <span className="badge repo-visibility">{repo.visibility === "private" ? "Private" : "Public"}</span>
      </div>
      <p className="pinned-card-description">{repo.description || "No description"}</p>
      <div className="profile-repo-meta">
        <span><Icon name="star" /> {compactCount(repoStars(repo))}</span>
        <span><Icon name="fork" /> {compactCount(repoForks(repo))}</span>
      </div>
    </li>
  );
}

function ListSkeleton({ rows = 4 }: { rows?: number }): ReactNode {
  return (
    <ul className="profile-repo-list" aria-hidden="true">
      {Array.from({ length: rows }, (_, index) => (
        <li key={index} className="profile-repo">
          <div className="profile-repo-main">
            <span className="skeleton-text" style={{ width: `${30 + ((index * 17) % 30)}%`, height: 18 }} />
            <span className="skeleton-text" style={{ width: "60%", marginTop: 10 }} />
          </div>
        </li>
      ))}
    </ul>
  );
}

function RepoBrowser({ repos, loading, emptyTitle, emptyHint, showOwner }: {
  repos: Repo[] | undefined;
  loading: boolean;
  emptyTitle: string;
  emptyHint?: string;
  showOwner: boolean;
}): ReactNode {
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<RepoSort>("updated");
  const visible = useMemo(() => filterAndSortRepos(repos ?? [], query, sort), [repos, query, sort]);
  return (
    <>
      <div className="profile-toolbar">
        <input type="search" placeholder="Find a repository…" aria-label="Find a repository" value={query} onChange={(event) => setQuery(event.target.value)} />
        <label className="profile-sort">
          <span className="sr-only">Sort</span>
          <select value={sort} onChange={(event) => setSort(event.target.value as RepoSort)}>
            <option value="updated">Last updated</option>
            <option value="name">Name</option>
            <option value="stars">Stars</option>
          </select>
        </label>
      </div>
      {loading ? (
        <ListSkeleton />
      ) : visible.length === 0 ? (
        <EmptyState title={query ? `No repositories match \u201c${query}\u201d` : emptyTitle} {...(emptyHint && !query ? { hint: emptyHint } : {})} />
      ) : (
        <ul className="profile-repo-list">
          {visible.map((repo) => <RepoRow key={repo.id} repo={repo} showOwner={showOwner} />)}
        </ul>
      )}
    </>
  );
}

export function UserPage({ username }: { username: string }): ReactNode {
  const location = useLocation();
  const tab = profileTabFrom(location.split("?")[1] ?? "");
  const { user: me } = useSession();
  const profile = useAsync(() => api.user(username), [username]);
  const repos = useAsync(() => api.userRepos(username), [username]);
  const starred = useAsync(() => (tab === "stars" ? api.userStarred(username) : Promise.resolve(null)), [username, tab]);
  const isMe = me?.username.toLowerCase() === username.toLowerCase();

  if (profile.error) return <ErrorBanner message={profile.error} />;

  const data = profile.data;
  const tabLink = (id: ProfileTab, label: string, icon: "book" | "repo" | "star", count?: number): ReactNode => (
    <Link
      to={id === "overview" ? `/${username}` : `/${username}?tab=${id}`}
      className={tab === id ? "active" : ""}
      {...(tab === id ? { ariaCurrent: "page" as const } : {})}
    >
      <Icon name={icon} />
      <span>{label}</span>
      {count ? <span className="count">{compactCount(count)}</span> : null}
    </Link>
  );

  return (
    <div className="profile-page">
      <nav className="profile-tabs repo-tabs" aria-label="Profile">
        {tabLink("overview", "Overview", "book")}
        {tabLink("repositories", "Repositories", "repo", data?.repo_count)}
        {tabLink("stars", "Stars", "star", data?.star_count)}
      </nav>
      <div className="profile-layout">
        <aside className="profile-sidebar" aria-label="Profile details">
          {data ? <Avatar user={data} size="xl" /> : <span className="profile-avatar-skeleton skeleton-text" aria-hidden="true" />}
          <h1 className="profile-names">
            <span className="profile-display-name">{data?.display_name ?? "\u00a0"}</span>
            <span className="profile-username">{data?.username ?? username}</span>
          </h1>
          {isMe ? (
            <button type="button" className="btn-secondary profile-edit" onClick={() => navigate("/settings")}>
              Edit profile
            </button>
          ) : null}
          <ul className="profile-facts">
            {data?.is_admin ? <li><Icon name="gear" /> Instance administrator</li> : null}
            {data ? <li><Icon name="history" /> Joined {joinedLabel(data.created_at)}</li> : <li><span className="skeleton-text" style={{ width: 140 }} /></li>}
            {data ? (
              <li>
                <Icon name="star" />
                <Link to={`/${username}?tab=stars`} className="muted-link"><strong>{compactCount(data.star_count ?? 0)}</strong> starred</Link>
                <span aria-hidden="true">·</span>
                <Link to={`/${username}?tab=repositories`} className="muted-link"><strong>{compactCount(data.repo_count ?? 0)}</strong> repositories</Link>
              </li>
            ) : null}
          </ul>
        </aside>

        <section className="profile-main">
          {tab === "overview" ? (
            <>
              <h2 className="profile-section-title">{(repos.data?.items.length ?? 0) > 6 ? "Popular repositories" : "Repositories"}</h2>
              {repos.loading ? (
                <ul className="pinned-grid" aria-hidden="true">
                  {[0, 1, 2, 3].map((index) => <li key={index} className="pinned-card"><span className="skeleton-text" style={{ width: "50%" }} /></li>)}
                </ul>
              ) : (repos.data?.items.length ?? 0) === 0 ? (
                <EmptyState title={isMe ? "You don\u2019t have any repositories yet" : `${username} doesn\u2019t have any public repositories yet`} />
              ) : (
                <ul className="pinned-grid">
                  {popularRepos(repos.data?.items ?? []).map((repo) => <PinnedCard key={repo.id} repo={repo} />)}
                </ul>
              )}
              <ContributionGraph username={username} />
            </>
          ) : tab === "repositories" ? (
            <RepoBrowser repos={repos.data?.items} loading={repos.loading} emptyTitle="No repositories" showOwner={false} />
          ) : (
            <RepoBrowser
              repos={starred.data?.items}
              loading={starred.loading || !starred.data}
              emptyTitle={isMe ? "You haven\u2019t starred any repositories yet" : `${username} hasn\u2019t starred any repositories yet`}
              emptyHint="Starring a repository bookmarks it here and shows appreciation to its maintainers."
              showOwner
            />
          )}
        </section>
      </div>
    </div>
  );
}

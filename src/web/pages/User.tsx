import { useMemo, useState, type ReactNode } from "react";
import "./User.css";
import { api } from "../api.ts";
import { useSession } from "../App.tsx";
import { Avatar, EmptyState, ErrorBanner, Markdown, timeAgo, useAsync } from "../components.tsx";
import { joinRepoPath } from "../repo-path.ts";
import { Icon } from "../components/Icons.tsx";
import { compactCount } from "../components/RepoSocialActions.tsx";
import { ContributionGraph } from "../components/ContributionGraph.tsx";
import { Link, useLocation } from "../router.tsx";
import type { Repo, User } from "../types.ts";

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

function PinnedCard({ repo, showOwner = false }: { repo: Repo; showOwner?: boolean }): ReactNode {
  return (
    <li className="pinned-card">
      <div className="pinned-card-head">
        <Icon name={repo.visibility === "private" ? "lock" : "repo"} />
        <Link to={`/${repo.owner}/${repo.name}`} className="profile-repo-name">{showOwner ? `${repo.owner}/` : ""}<strong>{repo.name}</strong></Link>
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

function ProfileReadme({ username }: { username: string }): ReactNode {
  const readme = useAsync(() => api.readme(username, username).catch(() => null), [username]);
  if (!readme.data?.content) return null;
  const data = readme.data;
  const dir = data.path && data.path.includes("/") ? data.path.slice(0, data.path.lastIndexOf("/")) : "";
  return (
    <section className="profile-readme" aria-label="Profile README">
      <div className="profile-readme-head">
        <Link to={`/${username}/${username}`} className="muted-link">{username} / {(data.path ?? "README.md").split("/").pop()}</Link>
      </div>
      <div className="profile-readme-body">
        <Markdown source={data.content ?? ""} resolveImageUrl={(src) => api.rawUrl(username, username, { ...(data.ref ? { ref: data.ref } : {}), path: joinRepoPath(dir, src) })} />
      </div>
    </section>
  );
}

function PinsDialog({ repos, pinned, onClose, onSaved }: { repos: Repo[]; pinned: Repo[]; onClose: () => void; onSaved: () => void }): ReactNode {
  const [selected, setSelected] = useState<number[]>(pinned.map((repo) => repo.id));
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const options = useMemo(() => {
    const byId = new Map<number, Repo>();
    for (const repo of [...pinned, ...repos]) byId.set(repo.id, repo);
    const needle = query.trim().toLowerCase();
    return [...byId.values()].filter((repo) => !needle || repo.full_name.toLowerCase().includes(needle));
  }, [repos, pinned, query]);
  const remaining = 6 - selected.length;

  const save = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await api.setPins(selected);
      onSaved();
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save pins");
      setBusy(false);
    }
  };

  return (
    <div className="finder-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div className="pins-dialog" role="dialog" aria-modal="true" aria-labelledby="pins-title" onKeyDown={(event) => event.key === "Escape" && onClose()}>
        <header>
          <h2 id="pins-title">Edit pinned items</h2>
          <span className="spacer" />
          <button type="button" className="ghost icon-only" aria-label="Close" onClick={onClose}><Icon name="plus" className="rotate-45" /></button>
        </header>
        <div className="pins-filter">
          <p className="small muted" style={{ margin: "0 0 8px" }}>Select up to six public repositories you’d like to show to anyone.</p>
          <input type="search" autoFocus placeholder="Filter repositories" aria-label="Filter repositories" value={query} onChange={(event) => setQuery(event.target.value)} />
        </div>
        <ul className="pins-list">
          {options.map((repo) => {
            const checked = selected.includes(repo.id);
            return (
              <li key={repo.id}>
                <label>
                  <input
                    type="checkbox"
                    checked={checked}
                    disabled={!checked && remaining <= 0}
                    onChange={() => setSelected((value) => (checked ? value.filter((id) => id !== repo.id) : [...value, repo.id]))}
                  />
                  <Icon name={repo.visibility === "private" ? "lock" : "repo"} />
                  <span>{repo.full_name}</span>
                  <span className="spacer" />
                  <span className="small faint"><Icon name="star" /> {compactCount(repoStars(repo))}</span>
                </label>
              </li>
            );
          })}
        </ul>
        <ErrorBanner message={error} />
        <footer>
          <span className="small muted">{remaining} remaining</span>
          <span className="spacer" />
          <button type="button" onClick={onClose}>Cancel</button>
          <button type="button" className="primary" disabled={busy} onClick={() => void save()}>{busy ? "Saving…" : "Save pins"}</button>
        </footer>
      </div>
    </div>
  );
}

function ProfileEditForm({ user, onDone }: { user: User; onDone: (saved: boolean) => void }): ReactNode {
  const [form, setForm] = useState<{ display_name: string; bio: string; company: string; location: string; website: string }>({
    display_name: user.display_name,
    bio: user.bio ?? "",
    company: user.company ?? "",
    location: user.location ?? "",
    website: user.website ?? "",
  });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const field = (key: keyof typeof form, label: string, max: number) => (
    <label>
      {label}
      <input value={form[key]} maxLength={max} onChange={(event) => setForm({ ...form, [key]: event.target.value })} />
    </label>
  );
  return (
    <form
      className="profile-edit-form"
      onSubmit={async (event) => {
        event.preventDefault();
        setBusy(true);
        setError(null);
        try {
          await api.updateAccount(form);
          onDone(true);
        } catch (cause) {
          setError(cause instanceof Error ? cause.message : "Could not save your profile");
          setBusy(false);
        }
      }}
    >
      <ErrorBanner message={error} />
      {field("display_name", "Name", 64)}
      <label>
        Bio
        <textarea value={form.bio} maxLength={160} placeholder="Add a bio" onChange={(event) => setForm({ ...form, bio: event.target.value })} />
      </label>
      {field("company", "Company", 100)}
      {field("location", "Location", 100)}
      {field("website", "Website", 200)}
      <div className="row">
        <button type="submit" className="primary small" disabled={busy}>{busy ? "Saving…" : "Save"}</button>
        <button type="button" className="small" onClick={() => onDone(false)}>Cancel</button>
      </div>
    </form>
  );
}

export function UserPage({ username }: { username: string }): ReactNode {
  const location = useLocation();
  const tab = profileTabFrom(location.split("?")[1] ?? "");
  const { user: me } = useSession();
  const profile = useAsync(() => api.user(username), [username]);
  const repos = useAsync(() => api.userRepos(username), [username]);
  const pins = useAsync(() => api.userPins(username), [username]);
  const { refresh } = useSession();
  const [editing, setEditing] = useState(false);
  const [pinsOpen, setPinsOpen] = useState(false);
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
          {editing && data ? (
            <ProfileEditForm
              user={data}
              onDone={(saved) => {
                setEditing(false);
                if (saved) {
                  profile.reload();
                  refresh();
                }
              }}
            />
          ) : (
            <>
              {data?.bio ? <p className="profile-bio">{data.bio}</p> : null}
              {isMe ? (
                <button type="button" className="btn-secondary profile-edit" onClick={() => setEditing(true)}>
                  Edit profile
                </button>
              ) : null}
            </>
          )}
          <ul className="profile-facts">
            {data?.company ? <li><Icon name="org" /> {data.company}</li> : null}
            {data?.location ? <li><Icon name="location" /> {data.location}</li> : null}
            {data?.website ? (
              <li>
                <Icon name="link" />
                <a href={data.website} rel="nofollow noopener noreferrer me" target="_blank">{data.website.replace(/^https?:\/\//, "").replace(/\/$/, "")}</a>
              </li>
            ) : null}
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
              {data?.has_profile_readme ? <ProfileReadme username={username} /> : null}
              <div className="profile-section-head">
                <h2 className="profile-section-title">{(pins.data?.items.length ?? 0) > 0 ? "Pinned" : (repos.data?.items.length ?? 0) > 6 ? "Popular repositories" : "Repositories"}</h2>
                <span className="spacer" />
                {isMe ? <button type="button" className="ghost small muted-link" onClick={() => setPinsOpen(true)}>Customize your pins</button> : null}
              </div>
              {repos.loading || pins.loading ? (
                <ul className="pinned-grid" aria-hidden="true">
                  {[0, 1, 2, 3].map((index) => <li key={index} className="pinned-card"><span className="skeleton-text" style={{ width: "50%" }} /></li>)}
                </ul>
              ) : (repos.data?.items.length ?? 0) === 0 ? (
                <EmptyState title={isMe ? "You don\u2019t have any repositories yet" : `${username} doesn\u2019t have any public repositories yet`} />
              ) : (
                <ul className="pinned-grid">
                  {((pins.data?.items.length ?? 0) > 0 ? pins.data!.items : popularRepos(repos.data?.items ?? [])).map((repo) => <PinnedCard key={repo.id} repo={repo} showOwner={repo.owner.toLowerCase() !== username.toLowerCase()} />)}
                </ul>
              )}
              <ContributionGraph username={username} name={data?.display_name ?? username} />
              {pinsOpen ? <PinsDialog repos={repos.data?.items ?? []} pinned={pins.data?.items ?? []} onClose={() => setPinsOpen(false)} onSaved={pins.reload} /> : null}
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

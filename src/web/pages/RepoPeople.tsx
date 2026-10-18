import type { ReactNode } from "react";
import { api } from "../api.ts";
import { Avatar, EmptyState, ErrorBanner, timeAgo, useAsync } from "../components.tsx";
import { Icon, type IconName } from "../components/Icons.tsx";
import { Link } from "../router.tsx";
import type { RepoPerson } from "../types.ts";

export type PeopleKind = "stargazers" | "watchers" | "forks";

const TITLES: Record<PeopleKind, { title: string; icon: IconName; empty: string }> = {
  stargazers: { title: "Stargazers", icon: "star", empty: "Be the first to star this repository." },
  watchers: { title: "Watchers", icon: "eye", empty: "Nobody is watching all activity in this repository yet." },
  forks: { title: "Forks", icon: "fork", empty: "No one has forked this repository yet." },
};

function PersonGrid({ people, verb }: { people: RepoPerson[]; verb: string }): ReactNode {
  return (
    <ul className="people-grid">
      {people.map((person) => {
        const when = person.starred_at ?? person.since;
        return (
          <li key={person.username} className="people-card">
            <Avatar user={person} size="lg" />
            <div className="people-text">
              <Link to={`/${person.username}`} className="people-name">{person.display_name}</Link>
              <span className="small muted">@{person.username}</span>
              {when ? <span className="small faint">{verb} {timeAgo(when)}</span> : null}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

function SkeletonGrid(): ReactNode {
  return (
    <ul className="people-grid" aria-hidden="true">
      {[0, 1, 2, 3, 4, 5].map((index) => (
        <li key={index} className="people-card">
          <span className="skeleton-text" style={{ width: 48, height: 48, borderRadius: "50%" }} />
          <div className="people-text"><span className="skeleton-text" style={{ width: 120 }} /></div>
        </li>
      ))}
    </ul>
  );
}

export function RepoPeoplePage({ owner, repo, kind }: { owner: string; repo: string; kind: PeopleKind }): ReactNode {
  const meta = TITLES[kind];
  const people = useAsync<RepoPerson[]>(
    () =>
      kind === "stargazers" ? api.stargazers(owner, repo).then((r) => r.items)
      : kind === "watchers" ? api.watchers(owner, repo).then((r) => r.items)
      : Promise.resolve([]),
    [owner, repo, kind],
  );
  const forks = useAsync(() => (kind === "forks" ? api.forks(owner, repo) : Promise.resolve(null)), [owner, repo, kind]);
  const tabs: PeopleKind[] = ["stargazers", "watchers", "forks"];

  return (
    <div className="card people-page">
      <nav className="people-tabs" aria-label="Repository audience">
        {tabs.map((tab) => (
          <Link key={tab} to={`/${owner}/${repo}/${tab}`} className={tab === kind ? "active" : ""} {...(tab === kind ? { ariaCurrent: "page" as const } : {})}>
            <Icon name={TITLES[tab].icon} />
            {TITLES[tab].title}
          </Link>
        ))}
      </nav>
      <ErrorBanner message={people.error ?? forks.error} />
      {kind === "forks" ? (
        forks.loading ? <SkeletonGrid /> : (forks.data?.items.length ?? 0) === 0 ? (
          <EmptyState title="No forks yet" hint={meta.empty} />
        ) : (
          <ul className="fork-list">
            {forks.data?.items.map((fork) => (
              <li key={fork.id}>
                <Icon name="fork" />
                <Link to={`/${fork.owner}/${fork.name}`} className="people-name">{fork.owner}/{fork.name}</Link>
                <span className="spacer" />
                <span className="small faint">updated {timeAgo(fork.updated_at)}</span>
              </li>
            ))}
          </ul>
        )
      ) : people.loading ? (
        <SkeletonGrid />
      ) : (people.data?.length ?? 0) === 0 ? (
        <EmptyState title={`No ${meta.title.toLowerCase()} yet`} hint={meta.empty} />
      ) : (
        <PersonGrid people={people.data ?? []} verb={kind === "stargazers" ? "starred" : "watching since"} />
      )}
    </div>
  );
}

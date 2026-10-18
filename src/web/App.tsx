import { TopBar } from "./components/TopBar.tsx";
import { createContext, lazy, Suspense, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { Spinner } from "./components.tsx";
import { api } from "./api.ts";
import { Link, navigate, parseLocation, useLocation } from "./router.tsx";
import type { User } from "./types.ts";
import { HomePage } from "./pages/Home.tsx";
import { LoginPage } from "./pages/Auth.tsx";
import { KeyboardShortcuts } from "./components/KeyboardShortcuts.tsx";

const { RepoPage, RepoShell } = {
  RepoPage: lazy(() => import("./pages/Repo.tsx").then((m) => ({ default: m.RepoPage }))),
  RepoShell: lazy(() => import("./pages/Repo.tsx").then((m) => ({ default: m.RepoShell }))),
};
const { MilestoneListPage, MilestoneDetailPage } = {
  MilestoneListPage: lazy(() => import("./pages/Milestones.tsx").then((m) => ({ default: m.MilestoneListPage }))),
  MilestoneDetailPage: lazy(() => import("./pages/Milestones.tsx").then((m) => ({ default: m.MilestoneDetailPage }))),
};
const ConfigurationPage = lazy(() => import("./pages/Configuration.tsx").then((m) => ({ default: m.ConfigurationPage })));
const BackupsPage = lazy(() => import("./pages/Backups.tsx").then((m) => ({ default: m.BackupsPage })));
const ForkPage = lazy(() => import("./pages/ForkPage.tsx").then((m) => ({ default: m.ForkPage })));
const RepoPeoplePage = lazy(() => import("./pages/RepoPeople.tsx").then((m) => ({ default: m.RepoPeoplePage })));
const AdminPage = lazy(() => import("./pages/AdminPage.tsx").then((m) => ({ default: m.AdminPage })));
const NewPullPage = lazy(() => import("./components/ComparePrompt.tsx").then((m) => ({ default: m.NewPullPage })));
const { IssueListPage, IssueDetailPage } = {
  IssueListPage: lazy(() => import("./pages/Issues.tsx").then((m) => ({ default: m.IssueListPage }))),
  IssueDetailPage: lazy(() => import("./pages/Issues.tsx").then((m) => ({ default: m.IssueDetailPage }))),
};
const { PullListPage, PullDetailPage } = {
  PullListPage: lazy(() => import("./pages/Pulls.tsx").then((m) => ({ default: m.PullListPage }))),
  PullDetailPage: lazy(() => import("./pages/Pulls.tsx").then((m) => ({ default: m.PullDetailPage }))),
};
const CommitPage = lazy(() => import("./pages/Commit.tsx").then((m) => ({ default: m.CommitPage })));
const SearchPage = lazy(() => import("./pages/Search.tsx").then((m) => ({ default: m.SearchPage })));
const SettingsPage = lazy(() => import("./pages/Settings.tsx").then((m) => ({ default: m.SettingsPage })));
const UserPage = lazy(() => import("./pages/User.tsx").then((m) => ({ default: m.UserPage })));
const NotificationsPage = lazy(() => import("./pages/Notifications.tsx").then((m) => ({ default: m.NotificationsPage })));
const { OrgListPage, OrgPage } = {
  OrgListPage: lazy(() => import("./pages/Orgs.tsx").then((m) => ({ default: m.OrgListPage }))),
  OrgPage: lazy(() => import("./pages/Orgs.tsx").then((m) => ({ default: m.OrgPage }))),
};

interface Session {
  user: User | null;
  loading: boolean;
  refresh: () => void;
}

const SessionContext = createContext<Session>({ user: null, loading: true, refresh: () => {} });

export function useSession(): Session {
  return useContext(SessionContext);
}

const PREFETCHED_ROUTES = [
  () => import("./pages/Repo.tsx"),
  () => import("./pages/Issues.tsx"),
  () => import("./pages/Pulls.tsx"),
  () => import("./pages/Commit.tsx"),
  () => import("./pages/User.tsx"),
  () => import("./pages/Search.tsx"),
];

function prefetchRoutes(): void {
  const connection = (navigator as Navigator & { connection?: { saveData?: boolean } }).connection;
  if (connection?.saveData) return;
  const idle = window.requestIdleCallback ?? ((callback: () => void) => window.setTimeout(callback, 1200));
  idle(() => {
    for (const load of PREFETCHED_ROUTES) void load().catch(() => {});
  });
}

export function App(): ReactNode {
  useEffect(prefetchRoutes, []);
  const location = useLocation();
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [nonce, setNonce] = useState(0);
  const [unread, setUnread] = useState(0);

  useEffect(() => {
    let cancelled = false;
    api
      .me()
      .then((result) => {
        if (cancelled) return;
        setUser(result.user);
        if (!result.user) return;
        return api
          .unreadCount()
          .then((count) => {
            if (!cancelled) setUnread(count.unread);
          })
          .catch(() => undefined);
      })
      .catch(() => {
        if (!cancelled) setUser(null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [nonce]);

  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    api
      .unreadCount()
      .then((count) => {
        if (!cancelled) setUnread(count.unread);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [location, user]);

  const refresh = useCallback(() => setNonce((value) => value + 1), []);
  const logout = useCallback(async () => {
    await api.logout();
    setUser(null);
    setUnread(0);
    navigate("/");
  }, []);

  return (
    <SessionContext.Provider value={{ user, loading, refresh }}>
      <div className="layout">
        <a href="#main" className="skip-link">
          Skip to content
        </a>
        <TopBar user={user} onLogout={logout} location={location} unread={unread} />
        <main className="container" id="main" tabIndex={-1}>
          {loading ? (
            <div className="session-loading">
              <Spinner label="Checking session" />
            </div>
          ) : (
            <Suspense fallback={<PageSkeleton />}>
              <RouteView location={location} />
            </Suspense>
          )}
        </main>
        <KeyboardShortcuts />
        <footer className="site-footer">
          <div className="footer-inner">
            <span>GitGood — Git over the smart HTTP protocol</span>
            <span className="spacer" />
            <a href="/api/health">Status</a>
            <a href="/api/version">Version</a>
            <a href="/api/metrics">Metrics</a>
          </div>
        </footer>
      </div>
    </SessionContext.Provider>
  );
}

function RouteView({ location }: { location: string }): ReactNode {
  const { segments, search } = parseLocation(location);
  const [first, second, third, ...rest] = segments;

  if (segments.length === 0) return <HomePage />;
  if (first === "login") return <LoginPage />;
  if (first === "search") return <SearchPage query={search.get("q") ?? ""} />;
  if (first === "admin") return <AdminPage section={second} configuration={<ConfigurationPage />} backups={<BackupsPage />} />;
  if (first === "settings") return <SettingsPage />;
  if (first === "notifications") return <NotificationsPage />;
  if (first === "orgs") {
    return second ? <OrgPage name={second} /> : <OrgListPage />;
  }
  if (first === "new") return <HomePage focusCreate />;
  if (segments.length === 1 && first) return <UserPage username={first} />;

  if (segments.length >= 2 && first && second) {
    const owner = first;
    const repo = second;
    const section = third;
    const tail = rest.join("/");

    if (section === undefined) return <RepoPage owner={owner} repo={repo} tab="code" />;
    if (section === "tree") return <RepoPage owner={owner} repo={repo} tab="code" refName={tail} />;
    if (section === "blob") return <RepoPage owner={owner} repo={repo} tab="blob" refName={tail} />;
    if (section === "edit") {
      const [refPart, ...pathParts] = tail ? tail.split("/") : [];
      return (
        <RepoPage owner={owner} repo={repo} tab="edit" refName={refPart} filePath={pathParts.join("/")} />
      );
    }
    if (section === "new") return <RepoPage owner={owner} repo={repo} tab="new" refName={tail || undefined} />;
    if (section === "blame") return <RepoPage owner={owner} repo={repo} tab="blame" refName={tail} />;
    if (section === "commits") {
      const [refPart, ...pathParts] = tail ? tail.split("/") : [];
      if (refPart && pathParts.length > 0) {
        return (
          <RepoPage
            owner={owner}
            repo={repo}
            tab="commits"
            refName={refPart}
            filePath={pathParts.join("/")}
          />
        );
      }
      return <RepoPage owner={owner} repo={repo} tab="commits" refName={tail} />;
    }
    if (section === "commit" && tail) {
      return (
        <RepoShell owner={owner} repo={repo} activeTab="commits">
          <CommitPage owner={owner} repo={repo} sha={tail} />
        </RepoShell>
      );
    }
    if (section === "branches") return <RepoPage owner={owner} repo={repo} tab="branches" />;
    if (section === "issues") {
      const number = tail ? Number.parseInt(tail, 10) : undefined;
      return (
        <RepoShell owner={owner} repo={repo} activeTab="issues">
          {number && Number.isFinite(number) ? (
            <IssueDetailPage owner={owner} repo={repo} number={number} />
          ) : (
            <IssueListPage owner={owner} repo={repo} state={search.get("state") ?? "open"} />
          )}
        </RepoShell>
      );
    }
    if (section === "fork" && !tail) {
      return (
        <RepoShell owner={owner} repo={repo} activeTab="code">
          <ForkPage owner={owner} repo={repo} />
        </RepoShell>
      );
    }
    if (section === "stargazers" || section === "watchers" || section === "forks") {
      return (
        <RepoShell owner={owner} repo={repo} activeTab="code">
          <RepoPeoplePage owner={owner} repo={repo} kind={section} />
        </RepoShell>
      );
    }
    if (section === "milestones") {
      const number = tail ? Number.parseInt(tail, 10) : undefined;
      return (
        <RepoShell owner={owner} repo={repo} activeTab="milestones">
          {number && Number.isFinite(number) ? (
            <MilestoneDetailPage owner={owner} repo={repo} number={number} />
          ) : (
            <MilestoneListPage owner={owner} repo={repo} />
          )}
        </RepoShell>
      );
    }
    if (section === "pulls" && tail === "new") {
      return (
        <RepoShell owner={owner} repo={repo} activeTab="pulls">
          <NewPullPage owner={owner} repo={repo} head={search.get("head")} base={search.get("base")} />
        </RepoShell>
      );
    }
    if (section === "pulls") {
      const number = tail ? Number.parseInt(tail, 10) : undefined;
      return (
        <RepoShell owner={owner} repo={repo} activeTab="pulls">
          {number && Number.isFinite(number) ? (
            <PullDetailPage owner={owner} repo={repo} number={number} />
          ) : (
            <PullListPage owner={owner} repo={repo} state={search.get("state") ?? "open"} />
          )}
        </RepoShell>
      );
    }
    if (section === "settings") return <RepoPage owner={owner} repo={repo} tab="settings" />;
    if (section === "actions") return <RepoPage owner={owner} repo={repo} tab="actions" />;
    if (section === "releases") return <RepoPage owner={owner} repo={repo} tab="releases" />;
  }

  return (
    <div className="card">
      <h2>Not found</h2>
      <p className="muted">Nothing lives at this address.</p>
      <Link to="/">Back to repositories</Link>
    </div>
  );
}

function PageSkeleton(): ReactNode {
  return (
    <div aria-busy="true" aria-live="polite" className="page-skeleton">
      <span className="sr-only">Loading</span>
      <div className="card" aria-hidden="true">
        <span className="skeleton-text" style={{ width: 260, height: 20 }} />
        <div style={{ marginTop: 14 }}>
          <span className="skeleton-text" style={{ width: "55%" }} />
        </div>
      </div>
      <div className="card" aria-hidden="true">
        {[72, 64, 80, 58, 68].map((width, index) => (
          <div key={index} className="page-skeleton-row">
            <span className="skeleton-text" style={{ width: `${width}%` }} />
          </div>
        ))}
      </div>
    </div>
  );
}

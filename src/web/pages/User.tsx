import { type ReactNode } from "react";
import { api } from "../api.ts";
import { Avatar, EmptyState, ErrorBanner, Spinner, useAsync } from "../components.tsx";
import { RepoCard } from "./Home.tsx";
import { parseLocation, useLocation } from "../router.tsx";

export function UserPage({ username }: { username: string }): ReactNode {
  const profile = useAsync(() => api.user(username), [username]);
  const repos = useAsync(() => api.userRepos(username), [username]);
  useLocation();

  if (profile.loading) return <Spinner label="Loading profile" />;
  if (profile.error) return <ErrorBanner message={profile.error} />;
  if (!profile.data) return <EmptyState title="User not found" />;

  return (
    <>
      <div className="card">
        <div className="row">
          <Avatar user={profile.data} size="lg" />
          <div>
            <div style={{ fontSize: 18, fontWeight: 700 }}>{profile.data.display_name}</div>
            <div className="muted small">
              @{profile.data.username}
              {profile.data.is_admin ? " · administrator" : ""}
            </div>
          </div>
        </div>
      </div>
      <h3 style={{ marginTop: 20 }}>Repositories</h3>
      {repos.loading ? (
        <Spinner />
      ) : (repos.data?.items.length ?? 0) === 0 ? (
        <EmptyState title="No repositories" />
      ) : (
        <div className="grid">
          {repos.data?.items.map((repo) => <RepoCard key={repo.id} repo={repo} />)}
        </div>
      )}
    </>
  );
}

void parseLocation;

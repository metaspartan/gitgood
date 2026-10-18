import type { ReactNode } from "react";
import { api } from "../../api.ts";
import { ErrorBanner, Spinner, timeAgo, useAsync } from "../../components.tsx";
import { Link } from "../../router.tsx";

export function ForkList({ owner, repo }: { owner: string; repo: string }): ReactNode {
  const forks = useAsync(() => api.forks(owner, repo), [owner, repo]);
  const items = forks.data?.items ?? [];

  if (forks.loading) return <div className="card"><Spinner label="Loading forks" /></div>;
  if (forks.error) return <div className="card"><ErrorBanner message={forks.error} /></div>;
  if (items.length === 0) {
    return (
      <div className="card">
        <h3 style={{ marginTop: 0 }}>Forks</h3>
        <p className="faint small">No forks yet. Fork this repository to make a copy.</p>
      </div>
    );
  }
  return (
    <div className="card">
      <h3 style={{ marginTop: 0 }}>Forks</h3>
      <div className="filelist">
        {items.map((fork) => (
          <div className="entry" key={fork.id}>
            <div className="name">
              <Link to={`/${fork.owner}/${fork.name}`}>
                <strong>
                  {fork.owner}/{fork.name}
                </strong>
              </Link>
            </div>
            <div className="size faint small">{timeAgo(fork.updated_at)}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

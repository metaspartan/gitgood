import { useState, type ReactNode } from "react";
import { api, splitRepoFullName } from "../api.ts";
import {
  Avatar,
  Badge,
  EmptyState,
  ErrorBanner,
  Notice,
  Spinner,
  formatBytes,
  timeAgo,
  useAsync,
  plural,
} from "../components.tsx";
import { Link, navigate } from "../router.tsx";
import { useSession } from "../App.tsx";
import type { OrgMember, Repo } from "../types.ts";

const ROLE_RANK: Record<string, number> = { member: 0, admin: 1, owner: 2 };
const OWNER_RANK = 2;

function roleRank(role: string | null | undefined): number {
  if (!role) return 0;
  return ROLE_RANK[role] ?? 0;
}

function assignableRoles(rank: number): string[] {
  return rank >= OWNER_RANK ? ["member", "admin", "owner"] : ["member", "admin"];
}

function RepoRow({ repo }: { repo: Repo }): ReactNode {
  const stats = repo.stats;
  return (
    <div className="entry">
      <div className="entry-main">
        <div className="entry-title">
          <Link to={`/${repo.owner}/${repo.name}`}>
            <strong>{repo.name}</strong>
          </Link>
          {repo.visibility === "private" ? <Badge kind="private">private</Badge> : null}
          {repo.archived ? <Badge kind="closed">archived</Badge> : null}
        </div>
        {repo.description ? <div className="muted small">{repo.description}</div> : null}
      </div>
      <div className="size faint small">
        {stats ? (
          <>
            {stats.commits.toLocaleString()} commits · {formatBytes(stats.sizeBytes)}
            {repo.lfsBytes ? <> · {formatBytes(repo.lfsBytes)} LFS</> : null}
          </>
        ) : (
          timeAgo(repo.updated_at)
        )}
      </div>
    </div>
  );
}


function OrgRow({
  org,
  showRole,
}: {
  org: {
    name: string;
    display_name: string;
    description: string | null;
    avatar_hue: number;
    repo_count?: number;
    member_count?: number;
    viewer_role?: string | null;
  };
  showRole: boolean;
}): ReactNode {
  return (
    <div className="entry">
      <Avatar user={{ username: org.name, display_name: org.display_name, avatar_hue: org.avatar_hue }} />
      <div className="entry-main">
        <div className="entry-title">
          <Link to={`/orgs/${org.name}`}>
            <strong>{org.display_name}</strong>
          </Link>
          {showRole && org.viewer_role ? <Badge kind="open">{org.viewer_role}</Badge> : null}
        </div>
        <div className="muted small">{org.description || org.name}</div>
      </div>
      <div className="size faint small">
        {plural(org.repo_count ?? 0, "repo")}
        {org.member_count !== undefined ? <> · {plural(org.member_count, "member")}</> : null}
      </div>
    </div>
  );
}

export function OrgListPage(): ReactNode {
  const { user } = useSession();
  const mine = useAsync(() => (user ? api.myOrgs() : Promise.resolve({ items: [] })), [user?.id ?? 0]);
  const all = useAsync(() => api.orgs(), []);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);

  if (!user) {
    return (
      <div className="card">
        <h2>Organisations</h2>
        <p className="muted">
          <Link to="/login">Sign in</Link> to see your organisations.
        </p>
      </div>
    );
  }

  const create = async (): Promise<void> => {
    if (!name.trim()) return;
    setError(null);
    try {
      const org = await api.createOrg({ name: name.trim() });
      setName("");
      navigate(`/orgs/${org.name}`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not create the organisation");
    }
  };

  const myItems = mine.data?.items ?? [];
  const allItems = all.data?.items ?? [];

  return (
    <>
      <div className="card">
        <h2>Organisations</h2>
        <p className="muted small">
          An organisation owns repositories as a namespace. It shares one namespace with users,
          so its name cannot be a username.
        </p>
        <ErrorBanner message={error} />
        <form
          className="stack"
          onSubmit={(event) => {
            event.preventDefault();
            void create();
          }}
        >
          <label>
            New organisation
            <input
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="acme"
              required
              maxLength={39}
            />
          </label>
          <div className="row">
            <button type="submit" disabled={!name.trim()}>
              Create organisation
            </button>
          </div>
        </form>
      </div>

      <div className="card">
        <h3>Yours</h3>
        <ErrorBanner message={mine.error} />
        {mine.loading ? (
          <Spinner label="Loading your organisations" />
        ) : myItems.length === 0 ? (
          <EmptyState title="You are not a member of any organisation yet" />
        ) : (
          <div className="filelist">
            {myItems.map((org) => (
              <OrgRow key={org.id} org={org} showRole />
            ))}
          </div>
        )}
      </div>

      <div className="card">
        <h3>All organisations</h3>
        <ErrorBanner message={all.error} />
        {all.loading ? (
          <Spinner label="Loading" />
        ) : allItems.length === 0 ? (
          <EmptyState title="No organisations on this instance yet" />
        ) : (
          <div className="filelist">
            {allItems.map((org) => (
              <OrgRow key={org.id} org={org} showRole={false} />
            ))}
          </div>
        )}
      </div>
    </>
  );
}

export function OrgPage({ name }: { name: string }): ReactNode {
  const { user } = useSession();
  const org = useAsync(() => api.org(name), [name]);
  const repos = useAsync(() => api.orgRepos(name), [name]);
  const members = useAsync(() => api.orgMembers(name), [name]);
  const [username, setUsername] = useState("");
  const [role, setRole] = useState("member");
  const [error, setError] = useState<string | null>(null);

  if (org.loading) {
    return (
      <div className="card">
        <Spinner label="Loading organisation" />
      </div>
    );
  }
  if (org.error || !org.data) {
    return (
      <div className="card">
        <ErrorBanner message={org.error ?? "Organisation not found"} />
        <p className="muted">
          <Link to="/orgs">Back to organisations</Link>
        </p>
      </div>
    );
  }

  const data = org.data;
  const canAdminister = data.viewer_can_administer === true;
  const viewerRole = data.viewer_role ?? null;

  const addMember = async (): Promise<void> => {
    if (!username.trim()) return;
    setError(null);
    try {
      await api.addOrgMember(name, username.trim(), role);
      setUsername("");
      members.reload();
      org.reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not add that member");
    }
  };

  const changeRole = async (member: OrgMember, next: string): Promise<void> => {
    setError(null);
    try {
      await api.setOrgMemberRole(name, member.user.username, next);
      members.reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not change that role");
    }
  };

  const removeMember = async (member: OrgMember): Promise<void> => {
    setError(null);
    try {
      await api.removeOrgMember(name, member.user.username);
      members.reload();
      org.reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not remove that member");
    }
  };

  const memberItems = members.data?.items ?? [];
  const repoItems = repos.data?.items ?? [];
  const isSelf = (member: OrgMember): boolean => member.user.username === user?.username;

  return (
    <>
      <div className="card">
        <div className="org-head">
          <Avatar user={{ username: data.name, display_name: data.display_name, avatar_hue: data.avatar_hue }} size="lg" />
          <div className="org-head-who">
            <h2>{data.display_name}</h2>
            <div className="muted small mono">{data.name}</div>
            {data.description ? <p className="muted small">{data.description}</p> : null}
          </div>
          {viewerRole ? <Badge kind="open">you are {viewerRole}</Badge> : null}
        </div>
      </div>

      <div className="card">
        <div className="card-head">
          <h3>Repositories</h3>
          <span className="faint small">{repoItems.length}</span>
          <span className="spacer" />
          {viewerRole ? (
            <Link to={`/new?organization=${encodeURIComponent(data.name)}`} className="button-link small">
              New repository
            </Link>
          ) : null}
        </div>
        <ErrorBanner message={repos.error} />
        {repos.loading ? (
          <Spinner label="Loading repositories" />
        ) : repoItems.length === 0 ? (
          <EmptyState
            title="No repositories yet"
            hint={viewerRole ? "Create one above." : "Members see private repositories here."}
          />
        ) : (
          <div className="filelist">
            {repoItems.map((repo) => (
              <RepoRow key={repo.id} repo={repo} />
            ))}
          </div>
        )}
      </div>

      <div className="card">
        <div className="card-head">
          <h3>Members</h3>
          <span className="faint small">{memberItems.length}</span>
        </div>
        <ErrorBanner message={error ?? members.error} />
        {members.loading ? (
          <Spinner label="Loading members" />
        ) : (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>User</th>
                  <th>Role</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {memberItems.map((member) => {
                  const isOwner = member.role === "owner";
                  const ownerCount = memberItems.filter((entry) => entry.role === "owner").length;
                  const locked = isOwner && ownerCount <= 1;
                  return (
                    <tr key={member.user.id}>
                      <td>
                        <span className="member-row">
                          <Avatar user={member.user} />
                          <Link to={`/${member.user.username}`}>{member.user.username}</Link>
                          {isSelf(member) ? <span className="faint small">(you)</span> : null}
                        </span>
                      </td>
                      <td>
                        {canAdminister && !locked ? (
                          <select
                            value={member.role}
                            onChange={(event) => void changeRole(member, event.target.value)}
                            aria-label={`Role for ${member.user.username}`}
                          >
                            {["owner", "admin", "member"].map((option) => (
                              <option key={option} value={option}>
                                {option}
                              </option>
                            ))}
                          </select>
                        ) : (
                          <Badge kind={isOwner ? "merged" : "open"}>{member.role}</Badge>
                        )}
                      </td>
                      <td className="cell-right">
                        {isSelf(member) ? (
                          <button className="ghost small" onClick={() => void removeMember(member)}>
                            Leave
                          </button>
                        ) : canAdminister && !locked ? (
                          <button className="ghost small" onClick={() => void removeMember(member)}>
                            Remove
                          </button>
                        ) : null}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {canAdminister ? (
          <form
            className="member-add"
            onSubmit={(event) => {
              event.preventDefault();
              void addMember();
            }}
          >
            <label>
              Add member by username
              <input
                value={username}
                onChange={(event) => setUsername(event.target.value)}
                placeholder="octocat"
                required
              />
            </label>
            <label>
              Role
              <select value={role} onChange={(event) => setRole(event.target.value)}>
                {assignableRoles(roleRank(viewerRole)).map((option) => (
                  <option key={option} value={option}>
                    {option}
                  </option>
                ))}
              </select>
            </label>
            <button type="submit" disabled={!username.trim()}>
              Add
            </button>
          </form>
        ) : (
          <Notice>You need the admin role to manage members.</Notice>
        )}
      </div>
    </>
  );
}

export { splitRepoFullName };

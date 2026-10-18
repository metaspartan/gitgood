import { useState, type ReactNode } from "react";
import "./Admin.css";
import { request } from "../api.ts";
import { useSession } from "../App.tsx";
import { Avatar, EmptyState, ErrorBanner, formatBytes, timeAgo, useAsync } from "../components.tsx";
import { Icon, type IconName } from "../components/Icons.tsx";
import { Switch } from "../components/Switch.tsx";
import { Link } from "../router.tsx";

export type AdminSection = "overview" | "users" | "repositories" | "runners" | "settings" | "configuration" | "backups";

const NAV: { id: AdminSection; label: string; icon: IconName; to: string }[] = [
  { id: "overview", label: "Overview", icon: "pulse", to: "/admin" },
  { id: "users", label: "Users", icon: "eye", to: "/admin/users" },
  { id: "repositories", label: "Repositories", icon: "repo", to: "/admin/repositories" },
  { id: "runners", label: "Runners", icon: "play", to: "/admin/runners" },
  { id: "settings", label: "Settings", icon: "gear", to: "/admin/settings" },
  { id: "configuration", label: "Configuration", icon: "database", to: "/admin/configuration" },
  { id: "backups", label: "Backups", icon: "download", to: "/admin/backups" },
];

const json = (method: string, body?: unknown): RequestInit => ({
  method,
  ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
});

export function AdminLayout({ section, children }: { section: AdminSection; children: ReactNode }): ReactNode {
  const { user, loading } = useSession();
  if (!loading && !user?.is_admin) {
    return (
      <div className="card">
        <h2>Administrator access required</h2>
        <p className="muted">Sign in with an administrator account to open the admin area.</p>
      </div>
    );
  }
  return (
    <div className="admin-layout">
      <nav className="admin-nav" aria-label="Admin area">
        <div className="admin-nav-title">Admin area</div>
        {NAV.map((item) => (
          <Link key={item.id} to={item.to} className={section === item.id ? "active" : ""} {...(section === item.id ? { ariaCurrent: "page" as const } : {})}>
            <Icon name={item.icon} />
            <span>{item.label}</span>
          </Link>
        ))}
      </nav>
      <div className="admin-main" aria-busy={loading}>{loading ? null : children}</div>
    </div>
  );
}

interface Overview {
  users: { total: number; admins: number; blocked: number };
  repositories: { total: number; private: number; archived: number };
  organizations: number;
  issues: { open: number; total: number };
  pulls: { open: number; total: number };
  ci: { mode: string; notice: string; queued: number; running: number; runners: number; runners_online: number };
  lfs: { objects: number; bytes: number };
  system: { uptime_ms: number; rss_bytes: number; heap_bytes: number; bun: string; platform: string };
}

function duration(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return hours < 48 ? `${hours}h ${minutes % 60}m` : `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

function Stat({ label, value, sub, to }: { label: string; value: ReactNode; sub?: ReactNode; to?: string }): ReactNode {
  const body = (
    <>
      <div className="admin-stat-label">{label}</div>
      <div className="admin-stat-value">{value}</div>
      {sub ? <div className="admin-stat-sub">{sub}</div> : null}
    </>
  );
  return to ? <Link to={to} className="admin-stat">{body}</Link> : <div className="admin-stat">{body}</div>;
}

export function AdminOverview(): ReactNode {
  const state = useAsync(() => request<Overview>("/api/admin/overview"), []);
  const data = state.data;
  return (
    <>
      <h1 className="admin-title">Overview</h1>
      <ErrorBanner message={state.error} />
      <div className="admin-stats" aria-busy={state.loading}>
        <Stat label="Users" to="/admin/users" value={data?.users.total ?? "\u2013"} sub={data ? `${data.users.admins} ${data.users.admins === 1 ? "admin" : "admins"} · ${data.users.blocked} blocked` : "\u00a0"} />
        <Stat label="Repositories" to="/admin/repositories" value={data?.repositories.total ?? "\u2013"} sub={data ? `${data.repositories.private} private · ${data.repositories.archived} archived` : "\u00a0"} />
        <Stat label="Organizations" value={data?.organizations ?? "\u2013"} sub={"\u00a0"} />
        <Stat label="Open issues" value={data?.issues.open ?? "\u2013"} sub={data ? `${data.issues.total} total` : "\u00a0"} />
        <Stat label="Open pull requests" value={data?.pulls.open ?? "\u2013"} sub={data ? `${data.pulls.total} total` : "\u00a0"} />
        <Stat label="LFS storage" value={data ? formatBytes(data.lfs.bytes) : "\u2013"} sub={data ? `${data.lfs.objects.toLocaleString()} objects` : "\u00a0"} />
        <Stat label="Runners online" to="/admin/runners" value={data ? `${data.ci.runners_online} / ${data.ci.runners}` : "\u2013"} sub={data ? `${data.ci.queued} queued · ${data.ci.running} running` : "\u00a0"} />
        <Stat label="Server memory" value={data ? formatBytes(data.system.rss_bytes) : "\u2013"} sub={data ? `up ${duration(data.system.uptime_ms)} · Bun ${data.system.bun}` : "\u00a0"} />
      </div>
      {data ? (
        <div className="card admin-card">
          <h2 className="admin-card-title">Actions</h2>
          <p className="small muted" style={{ margin: 0 }}>
            Mode <code>{data.ci.mode}</code>. {data.ci.notice}
          </p>
        </div>
      ) : null}
    </>
  );
}

interface AdminUser {
  id: number;
  username: string;
  email: string;
  display_name: string;
  avatar_hue: number;
  is_admin: boolean;
  blocked: boolean;
  created_at: number;
  repo_count: number;
  last_active_at: number | null;
}

interface Page<T> {
  items: T[];
  total: number;
  page: number;
  per_page: number;
}

function Pager({ page, total, perPage, onPage }: { page: number; total: number; perPage: number; onPage: (page: number) => void }): ReactNode {
  const pages = Math.max(1, Math.ceil(total / perPage));
  if (pages <= 1) return null;
  return (
    <div className="admin-pager">
      <button type="button" className="btn-secondary" disabled={page <= 1} onClick={() => onPage(page - 1)}>Previous</button>
      <span className="small muted">Page {page} of {pages}</span>
      <button type="button" className="btn-secondary" disabled={page >= pages} onClick={() => onPage(page + 1)}>Next</button>
    </div>
  );
}

export function AdminUsers(): ReactNode {
  const { user: me } = useSession();
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<"all" | "admins" | "blocked">("all");
  const [page, setPage] = useState(1);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const list = useAsync(
    () => request<Page<AdminUser>>(`/api/admin/users?page=${page}&q=${encodeURIComponent(query)}${filter === "all" ? "" : `&filter=${filter}`}`),
    [page, query, filter],
  );

  const act = async (id: number, body: Record<string, unknown>, method = "PATCH"): Promise<void> => {
    setError(null);
    try {
      await request(`/api/admin/users/${id}`, json(method, method === "DELETE" ? undefined : body));
      list.reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "That did not work");
    }
  };

  return (
    <>
      <div className="admin-head">
        <h1 className="admin-title">Users</h1>
        <span className="spacer" />
        <button type="button" className="btn-primary" onClick={() => setCreating((v) => !v)}>
          <Icon name="plus" /> New user
        </button>
      </div>
      {creating ? <CreateUserForm onCreated={() => { setCreating(false); list.reload(); }} /> : null}
      <ErrorBanner message={error ?? list.error} />
      <div className="admin-toolbar">
        <input
          type="search"
          placeholder="Search by username, name or email"
          aria-label="Search users"
          value={query}
          onChange={(event) => { setQuery(event.target.value); setPage(1); }}
        />
        <div className="segmented" role="group" aria-label="Filter users">
          {(["all", "admins", "blocked"] as const).map((value) => (
            <button key={value} type="button" aria-pressed={filter === value} onClick={() => { setFilter(value); setPage(1); }}>
              {value === "all" ? "All" : value === "admins" ? "Admins" : "Blocked"}
            </button>
          ))}
        </div>
      </div>
      <div className="admin-table-wrap">
        <table className="admin-table">
          <thead>
            <tr><th>User</th><th>Role</th><th className="num">Repos</th><th>Joined</th><th>Last sign-in</th><th aria-label="Actions" /></tr>
          </thead>
          <tbody aria-busy={list.loading}>
            {(list.data?.items ?? []).map((row) => (
              <tr key={row.id} className={row.blocked ? "is-blocked" : ""}>
                <td>
                  <div className="admin-user">
                    <Avatar user={row} />
                    <div className="admin-user-text">
                      <Link to={`/${row.username}`} className="admin-user-name">{row.display_name}</Link>
                      <span className="small muted">@{row.username} · {row.email}</span>
                    </div>
                  </div>
                </td>
                <td>
                  {row.is_admin ? <span className="badge admin-badge">Admin</span> : <span className="small muted">Regular</span>}
                  {row.blocked ? <span className="badge closed" style={{ marginLeft: 6 }}>Blocked</span> : null}
                </td>
                <td className="num">{row.repo_count}</td>
                <td className="small muted">{timeAgo(row.created_at)}</td>
                <td className="small muted">{row.last_active_at ? timeAgo(row.last_active_at) : "Never"}</td>
                <td className="admin-actions">
                  {row.id === me?.id ? <span className="small faint">You</span> : (
                    <>
                      <button type="button" className="btn-secondary small" onClick={() => void act(row.id, { is_admin: !row.is_admin })}>{row.is_admin ? "Remove admin" : "Make admin"}</button>
                      <button type="button" className="btn-secondary small" onClick={() => void act(row.id, { blocked: !row.blocked })}>{row.blocked ? "Unblock" : "Block"}</button>
                      <button
                        type="button"
                        className="btn-secondary small danger-text"
                        onClick={() => { if (window.confirm(`Delete ${row.username}? This cannot be undone.`)) void act(row.id, {}, "DELETE"); }}
                      >
                        Delete
                      </button>
                    </>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {list.data && list.data.items.length === 0 ? <EmptyState title="No users match" /> : null}
      </div>
      {list.data ? <Pager page={page} total={list.data.total} perPage={list.data.per_page} onPage={setPage} /> : null}
    </>
  );
}

function CreateUserForm({ onCreated }: { onCreated: () => void }): ReactNode {
  const [form, setForm] = useState({ username: "", email: "", password: "", is_admin: false });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <form
      className="card admin-card admin-form"
      onSubmit={async (event) => {
        event.preventDefault();
        setBusy(true);
        setError(null);
        try {
          await request("/api/admin/users", json("POST", form));
          onCreated();
        } catch (cause) {
          setError(cause instanceof Error ? cause.message : "Could not create the user");
        } finally {
          setBusy(false);
        }
      }}
    >
      <ErrorBanner message={error} />
      <div className="admin-form-grid">
        <label>Username<input required value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} autoComplete="off" /></label>
        <label>Email<input required type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} autoComplete="off" /></label>
        <label>Initial password<input required type="password" minLength={8} value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} autoComplete="new-password" /></label>
      </div>
      <Switch checked={form.is_admin} onChange={(value) => setForm({ ...form, is_admin: value })} label="Administrator" />
      <div className="row"><button type="submit" className="btn-primary" disabled={busy}>{busy ? "Creating\u2026" : "Create user"}</button></div>
    </form>
  );
}

interface AdminRepo {
  id: number;
  full_name: string;
  visibility: string;
  archived: boolean;
  actions_enabled: boolean;
  updated_at: number;
  lfs_bytes: number;
}

export function AdminRepositories(): ReactNode {
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const list = useAsync(() => request<Page<AdminRepo>>(`/api/admin/repositories?page=${page}&q=${encodeURIComponent(query)}`), [page, query]);
  return (
    <>
      <h1 className="admin-title">Repositories</h1>
      <ErrorBanner message={list.error} />
      <div className="admin-toolbar">
        <input type="search" placeholder="Search by name or owner" aria-label="Search repositories" value={query} onChange={(e) => { setQuery(e.target.value); setPage(1); }} />
        <span className="small muted">{list.data ? `${list.data.total.toLocaleString()} repositories` : "\u00a0"}</span>
      </div>
      <div className="admin-table-wrap">
        <table className="admin-table">
          <thead><tr><th>Repository</th><th>Visibility</th><th>Actions</th><th className="num">LFS</th><th>Updated</th></tr></thead>
          <tbody aria-busy={list.loading}>
            {(list.data?.items ?? []).map((row) => (
              <tr key={row.id}>
                <td>
                  <Link to={`/${row.full_name}`} className="admin-user-name"><Icon name={row.visibility === "private" ? "lock" : "repo"} /> {row.full_name}</Link>
                  {row.archived ? <span className="badge" style={{ marginLeft: 6 }}>Archived</span> : null}
                </td>
                <td className="small">{row.visibility === "private" ? "Private" : "Public"}</td>
                <td className="small">{row.actions_enabled ? "Enabled" : <span className="muted">Disabled</span>}</td>
                <td className="num small">{row.lfs_bytes ? formatBytes(row.lfs_bytes) : "\u2013"}</td>
                <td className="small muted">{timeAgo(row.updated_at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {list.data && list.data.items.length === 0 ? <EmptyState title="No repositories match" /> : null}
      </div>
      {list.data ? <Pager page={page} total={list.data.total} perPage={list.data.per_page} onPage={setPage} /> : null}
    </>
  );
}

interface Runner {
  id: number;
  name: string;
  token_prefix: string;
  created_at: number;
  last_seen_at: number | null;
  last_ip: string | null;
  version: string | null;
  paused: boolean;
  online: boolean;
  active_jobs: number;
}

export function AdminRunners(): ReactNode {
  const list = useAsync(() => request<{ items: Runner[]; mode_uses_runners: boolean }>("/api/admin/runners"), []);
  const [name, setName] = useState("");
  const [token, setToken] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const origin = typeof window === "undefined" ? "" : window.location.origin;

  const act = async (path: string, init: RequestInit): Promise<void> => {
    setError(null);
    try {
      await request(path, init);
      list.reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "That did not work");
    }
  };

  return (
    <>
      <h1 className="admin-title">Runners</h1>
      <p className="muted admin-lede">
        Runners execute Actions jobs in disposable containers on a machine you choose, so repository code never runs inside the GitGood server.
      </p>
      {list.data && !list.data.mode_uses_runners ? (
        <div className="notice-banner">This server is not in runner mode. Set <code>GITGOOD_CI_MODE=runner</code> so jobs are queued for runners.</div>
      ) : null}
      <ErrorBanner message={error ?? list.error} />
      <form
        className="card admin-card admin-inline-form"
        onSubmit={async (event) => {
          event.preventDefault();
          setError(null);
          try {
            const created = await request<{ token: string }>("/api/admin/runners", json("POST", { name: name.trim() }));
            setToken(created.token);
            setName("");
            list.reload();
          } catch (cause) {
            setError(cause instanceof Error ? cause.message : "Could not register the runner");
          }
        }}
      >
        <label className="grow">Runner name<input required maxLength={80} value={name} onChange={(e) => setName(e.target.value)} placeholder="build-box-1" /></label>
        <button type="submit" className="btn-primary"><Icon name="plus" /> Register runner</button>
      </form>
      {token ? (
        <div className="card admin-card admin-token">
          <h2 className="admin-card-title">Start the runner</h2>
          <p className="small muted">Copy the token now. It is shown only once.</p>
          <p className="small">With Docker Compose, from the GitGood checkout:</p>
          <pre className="admin-code">{`GITGOOD_RUNNER_URL=${origin} \\
GITGOOD_RUNNER_TOKEN=${token} \\
docker compose --profile runner up -d runner`}</pre>
          <p className="small muted">Or without Docker for the runner itself: <code>{`bun runner/gitgood-runner.ts --url ${origin} --token ${token}`}</code></p>
          <button type="button" className="btn-secondary small" onClick={() => setToken(null)}>Done</button>
        </div>
      ) : null}
      <div className="admin-table-wrap">
        <table className="admin-table">
          <thead><tr><th>Runner</th><th>Status</th><th className="num">Jobs</th><th>Last contact</th><th>Version</th><th aria-label="Actions" /></tr></thead>
          <tbody aria-busy={list.loading}>
            {(list.data?.items ?? []).map((runner) => (
              <tr key={runner.id}>
                <td><strong>{runner.name}</strong><div className="small faint mono">{runner.token_prefix}…</div></td>
                <td>
                  <span className={`runner-dot ${runner.paused ? "is-paused" : runner.online ? "is-online" : "is-offline"}`} aria-hidden="true" />
                  {runner.paused ? "Paused" : runner.online ? "Online" : "Offline"}
                </td>
                <td className="num">{runner.active_jobs}</td>
                <td className="small muted">{runner.last_seen_at ? `${timeAgo(runner.last_seen_at)}${runner.last_ip ? ` from ${runner.last_ip}` : ""}` : "Never"}</td>
                <td className="small mono">{runner.version ?? "\u2013"}</td>
                <td className="admin-actions">
                  <button type="button" className="btn-secondary small" onClick={() => void act(`/api/admin/runners/${runner.id}`, json("PATCH", { paused: !runner.paused }))}>{runner.paused ? "Resume" : "Pause"}</button>
                  <button type="button" className="btn-secondary small danger-text" onClick={() => { if (window.confirm(`Remove ${runner.name}? Its token stops working immediately.`)) void act(`/api/admin/runners/${runner.id}`, json("DELETE")); }}>Remove</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {list.data && list.data.items.length === 0 ? <EmptyState title="No runners registered" hint="Register one above; queued jobs start as soon as it connects." /> : null}
      </div>
    </>
  );
}

interface Settings {
  allow_signup: boolean;
  allow_repo_creation: boolean;
  default_visibility: "public" | "private";
  actions_default_enabled: boolean;
}

export function AdminSettings(): ReactNode {
  const state = useAsync(() => request<Settings>("/api/admin/settings"), []);
  const [saved, setSaved] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const update = async (patch: Partial<Settings>): Promise<void> => {
    setError(null);
    try {
      await request("/api/admin/settings", json("PUT", patch));
      state.reload();
      setSaved("Saved");
      setTimeout(() => setSaved(null), 1500);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save");
    }
  };
  const s = state.data;
  return (
    <>
      <div className="admin-head">
        <h1 className="admin-title">Settings</h1>
        <span className="spacer" />
        <span className="small muted" role="status">{saved ?? ""}</span>
      </div>
      <ErrorBanner message={error ?? state.error} />
      <section className="card admin-card admin-settings" aria-busy={!s}>
        <h2 className="admin-card-title">Sign-up and access</h2>
        <Switch checked={s?.allow_signup ?? false} disabled={!s} onChange={(v) => void update({ allow_signup: v })} label="Allow new sign-ups" hint="When off, only administrators can create accounts (Admin → Users)." />
        <Switch checked={s?.allow_repo_creation ?? false} disabled={!s} onChange={(v) => void update({ allow_repo_creation: v })} label="Allow everyone to create repositories" hint="When off, only administrators can create repositories." />
        <label className="admin-select">
          Default visibility for new repositories
          <select value={s?.default_visibility ?? "public"} disabled={!s} onChange={(e) => void update({ default_visibility: e.target.value as Settings["default_visibility"] })}>
            <option value="public">Public</option>
            <option value="private">Private</option>
          </select>
        </label>
      </section>
      <section className="card admin-card admin-settings">
        <h2 className="admin-card-title">Actions</h2>
        <Switch checked={s?.actions_default_enabled ?? true} disabled={!s} onChange={(v) => void update({ actions_default_enabled: v })} label="Enable Actions for new repositories" hint="Owners can still turn Actions off per repository in its settings." />
        <p className="small muted" style={{ margin: 0 }}>Jobs run on registered <Link to="/admin/runners">runners</Link>.</p>
      </section>
    </>
  );
}

export function adminSectionFor(second: string | undefined): AdminSection | null {
  if (second === undefined || second === "") return "overview";
  return NAV.some((item) => item.id === second) ? (second as AdminSection) : null;
}

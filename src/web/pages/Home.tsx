import { RepositorySetup } from "../components/RepositorySetup.tsx";
import { useMemo, useState, type ReactNode } from "react";
import { api } from "../api.ts";
import { useSession } from "../App.tsx";
import { EmptyState, ErrorBanner, formatBytes, Spinner, timeAgo, useAsync } from "../components.tsx";
import { repoNameProblem, repoPathPreview } from "../repo-name.ts";
import { Link } from "../router.tsx";
import type { Repo } from "../types.ts";

export function RepoCard({ repo }: { repo: Repo }): ReactNode {
  const stats = repo.stats;
  return (
    <article className="repo-card">
      <div className="repo-card-head">
        <Link to={`/${repo.owner}/${repo.name}`} className="repo-name">
          <span className="repo-owner">{repo.owner}</span>
          <span className="repo-slash" aria-hidden="true">/</span>
          <span className="repo-leaf">{repo.name}</span>
        </Link>
        <span className="repo-badges">
          {repo.visibility === "private" ? <span className="badge private">Private</span> : null}
          {repo.archived ? <span className="badge">Archived</span> : null}
          {repo.lfs_enabled ? <span className="badge">LFS</span> : null}
        </span>
      </div>

      {repo.description ? (
        <p className="repo-description">{repo.description}</p>
      ) : (
        <p className="repo-description repo-description-empty">No description</p>
      )}

      <div className="repo-meta">
        {stats && stats.commits > 0 ? (
          <span className="repo-meta-item">
            <span className="dot" style={{ background: "var(--text-faint)" }} aria-hidden="true" />
            {stats.commits.toLocaleString()} commits
          </span>
        ) : null}
        {repo.openIssues ? (
          <span className="repo-meta-item">
            <span className="dot" style={{ background: "var(--success)" }} aria-hidden="true" />
            {repo.openIssues} open {repo.openIssues === 1 ? "issue" : "issues"}
          </span>
        ) : null}
        {repo.openPulls ? (
          <span className="repo-meta-item">
            <span className="dot" style={{ background: "var(--merged)" }} aria-hidden="true" />
            {repo.openPulls} open {repo.openPulls === 1 ? "pull request" : "pull requests"}
          </span>
        ) : null}
        {repo.lfsBytes ? (
          <span className="repo-meta-item" title={`${(repo.lfsObjects ?? 0).toLocaleString()} LFS objects`}>
            <span className="dot" style={{ background: "var(--accent)" }} aria-hidden="true" />
            {formatBytes(repo.lfsBytes)} LFS
          </span>
        ) : null}
        <span className="repo-meta-spacer" />
        <span className="repo-meta-item faint">Updated {timeAgo(repo.updated_at)}</span>
      </div>
    </article>
  );
}

export function HomePage({ focusCreate = false }: { focusCreate?: boolean }): ReactNode {
  const { user } = useSession();
  const [page, setPage] = useState(1);
  const perPage = 30;
  const { data, error, loading, reload } = useAsync(
    () => focusCreate ? Promise.resolve(null) : api.repos({ page, perPage }),
    [page, focusCreate],
  );

  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [visibility, setVisibility] = useState<"public" | "private">("public");
  const [owner, setOwner] = useState<string>("");
  const [defaultBranch, setDefaultBranch] = useState("");
  const [lfsEnabled, setLfsEnabled] = useState(true);
  const [advanced, setAdvanced] = useState(false);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [touched, setTouched] = useState(false);
  const [created, setCreated] = useState<Repo | null>(null);

  const orgs = useAsync(
    () => (user && focusCreate ? api.myOrgs() : Promise.resolve({ items: [] })),
    [user?.id ?? 0, focusCreate],
  );

  const ownerName = owner || user?.username || "";
  const problem = repoNameProblem(name);
  const trimmed = name.trim();
  const canSubmit = trimmed.length > 0 && problem === null && !creating && created === null;

  const orgItems = useMemo(() => orgs.data?.items ?? [], [orgs.data]);

  const origin = typeof window === "undefined" ? "" : window.location.origin;
  const previewPath = repoPathPreview(ownerName, name);
  const cloneUrl = `${origin}/${ownerName || "owner"}/${trimmed || "my-project"}.git`;

  const create = async (): Promise<void> => {
    if (!canSubmit) return;
    setTouched(true);
    setCreating(true);
    setCreateError(null);
    try {
      const repo = await api.createRepo({
        name: trimmed,
        ...(description.trim() ? { description: description.trim() } : {}),
        visibility,
        ...(owner ? { organization: owner } : {}),
        ...(defaultBranch.trim() ? { default_branch: defaultBranch.trim() } : {}),
        lfs_enabled: lfsEnabled,
      });
      setCreated(repo);
      setTouched(false);
      if (!focusCreate) reload();
    } catch (cause) {
      setCreateError(cause instanceof Error ? cause.message : "Could not create the repository");
    } finally {
      setCreating(false);
    }
  };

  return (
    <>
      {!focusCreate ? (
        <header className="home-heading">
          <div><p className="home-eyebrow">YOUR GIT WORKSPACE</p><h1>Repositories</h1><p className="muted">Browse code, collaborate, and ship your next release.</p></div>
          <Link to={user ? "/new" : "/login"} className="btn-primary home-create-action">{user ? "New repository" : "Sign in to create"}</Link>
        </header>
      ) : <header className="home-heading"><div><Link to="/">← Repositories</Link><h1>New repository</h1><p className="muted">Choose a home for your code. Connect your local project when you’re ready.</p></div></header>}

      <ErrorBanner message={error} />

      {focusCreate && created ? (
        <div className="card create-success" role="status">
          <div>
            <strong>Created {created.full_name}</strong>
            <div className="muted small">
              Push an existing repository, or{" "}
              <Link to={`/${created.owner}/${created.name}`}>open it and add a file</Link>.
            </div>
          </div>
          <Link to={`/${created.owner}/${created.name}`} className="btn-secondary small">
            Open repository
          </Link>
        </div>
      ) : null}

      {focusCreate ? <section className="card create-card" aria-labelledby="create-heading">
        <div className="repository-create-layout">
          <div className="create-main">
            <div className="card-head">
              <h2 id="create-heading">Repository details</h2>
              <p className="muted small card-sub">
                Set the owner, name, and who can access this repository.
              </p>
            </div>

            {user ? (
              <form
                className="create-form"
                onSubmit={(event) => {
                  event.preventDefault();
                  void create();
                }}
                noValidate
              >
                <ErrorBanner message={createError} />

                <div className="create-identity-fields">
                <div className="field">
                  <div className="field-head">
                    <label htmlFor="repo-owner">Owner</label>
                  </div>
                  <select
                    id="repo-owner"
                    name="repo-owner"
                    value={owner}
                    onChange={(event) => { setOwner(event.target.value); setCreated(null); }}
                  >
                    <option value="">{user.username}</option>
                    {orgItems.map((org) => (
                      <option key={org.id} value={org.name}>
                        {org.name}
                      </option>
                    ))}
                  </select>
                  {orgItems.length > 0 ? (
                    <p className="field-hint">
                      Organisation repositories live under the organisation's namespace.
                    </p>
                  ) : null}
                </div>

                <div className="field">
                  <div className="field-head">
                    <label htmlFor="repo-name">Name</label>
                    <span className="spacer" />
                    <span className="opt">required</span>
                  </div>
                  <input
                    id="repo-name"
                    name="repo-name"
                    value={name}
                    onChange={(event) => { setName(event.target.value); setCreated(null); }}
                    onBlur={() => setTouched(true)}
                    placeholder="my-project"
                    autoComplete="off"
                    spellCheck={false}
                    required
                    {...(focusCreate ? { autoFocus: true } : {})}
                    aria-invalid={touched && problem !== null}
                    aria-describedby="repo-name-help"
                  />
                  <p
                    id="repo-name-help"
                    className={touched && problem ? "field-hint field-error" : "field-hint path-preview"}
                    role={touched && problem ? "alert" : undefined}
                  >
                    {touched && problem ? (
                      problem
                    ) : (
                      <>
                        Will be created at <strong>{previewPath}</strong>
                      </>
                    )}
                  </p>
                </div>

                </div>
                <div className="field">
                  <div className="field-head">
                    <label htmlFor="repo-description">Description</label>
                    <span className="spacer" />
                    <span className="opt">optional</span>
                  </div>
                  <input
                    id="repo-description"
                    name="repo-description"
                    value={description}
                    onChange={(event) => setDescription(event.target.value)}
                    placeholder="What is this repository for?"
                    maxLength={2048}
                  />
                </div>

                <fieldset className="field visibility-field">
                  <div className="field-head">
                    <legend>Visibility</legend>
                  </div>
                  <div className="choice-row">
                    {(
                      [
                        { value: "public", label: "Public", hint: "Anyone can read and clone it." },
                        { value: "private", label: "Private", hint: "Only you and your collaborators." },
                      ] as const
                    ).map((option) => (
                      <label
                        key={option.value}
                        className={`choice${visibility === option.value ? " choice-on" : ""}`}
                      >
                        <input
                          type="radio"
                          name="repo-visibility"
                          value={option.value}
                          checked={visibility === option.value}
                          onChange={() => setVisibility(option.value)}
                        />
                        <span className="choice-body">
                          <span className="choice-label">{option.label}</span>
                          <span className="choice-hint">{option.hint}</span>
                        </span>
                      </label>
                    ))}
                  </div>
                </fieldset>

                <details
                  className="advanced"
                  open={advanced}
                  onToggle={(event) => setAdvanced((event.target as HTMLDetailsElement).open)}
                >
                  <summary>Advanced options</summary>
                  <div className="field">
                    <div className="field-head">
                      <label htmlFor="repo-branch">Default branch</label>
                    </div>
                    <input
                      id="repo-branch"
                      name="repo-branch"
                      value={defaultBranch}
                      onChange={(event) => { setDefaultBranch(event.target.value); setCreated(null); }}
                      placeholder="main"
                      autoComplete="off"
                      spellCheck={false}
                    />
                    <p className="field-hint">The branch a clone checks out. Defaults to main.</p>
                  </div>
                  <div className="field">
                    <div className="field-head">
                      <label htmlFor="repo-lfs">Large file storage</label>
                    </div>
                    <div className="row" style={{ gap: 8 }}>
                      <input
                        id="repo-lfs"
                        name="repo-lfs"
                        type="checkbox"
                        className="checkbox"
                        checked={lfsEnabled}
                        onChange={(event) => setLfsEnabled(event.target.checked)}
                      />
                      <label htmlFor="repo-lfs" className="inline-label">
                        Accept Git LFS objects
                      </label>
                    </div>
                    <p className="field-hint">
                      Large binaries are stored out of band, with a small pointer committed in their
                      place.
                    </p>
                  </div>
                </details>

                <div className="form-actions">
                  <button type="submit" className="primary" disabled={!canSubmit}>
                    {creating ? "Creating…" : created ? "Repository created" : "Create repository"}
                  </button>
                </div>
              </form>
            ) : (
              <p className="muted">
                <Link to="/login">Sign in</Link> to create repositories, open issues and push code.
              </p>
            )}
          </div>

          <RepositorySetup cloneUrl={created ? new URL(created.clone_url, origin).href : cloneUrl} branch={created?.default_branch ?? defaultBranch} ready={created !== null} />
        </div>
      </section> : null}

      {focusCreate ? null : (
      <>
      <div className="section-head">
        <h2>All repositories</h2>
        {data ? <span className="count-pill">{data.total}</span> : null}
        <span className="spacer" />

      </div>

      {loading ? (
        <Spinner label="Loading repositories" />
      ) : (data?.items.length ?? 0) === 0 ? (
        page > 1 ? (
          <EmptyState title="Nothing on this page" hint="Go back to the first page." />
        ) : (
          <EmptyState title="No repositories yet" hint="Use New repository to create a home for your code." />
        )
      ) : (
        <>
          <div className="repo-grid home-repo-list">
            {data?.items.map((repo) => (
              <RepoCard key={repo.id} repo={repo} />
            ))}
          </div>
          <Pager page={page} perPage={perPage} total={data?.total ?? 0} onChange={setPage} />
        </>
      )}
      </>
      )}
    </>
  );
}

function Pager({
  page,
  perPage,
  total,
  onChange,
}: {
  page: number;
  perPage: number;
  total: number;
  onChange: (next: number) => void;
}): ReactNode {
  const lastPage = Math.max(1, Math.ceil(total / perPage));
  if (lastPage <= 1) return null;

  const first = (page - 1) * perPage + 1;
  const last = Math.min(page * perPage, total);

  return (
    <nav className="pager" aria-label="Repository pages">
      <button
        className="ghost"
        disabled={page <= 1}
        onClick={() => onChange(page - 1)}
        aria-label="Previous page"
      >
        ← Newer
      </button>
      <span className="pager-status" aria-live="polite">
        {first}–{last} of {total}
      </span>
      <button
        className="ghost"
        disabled={page >= lastPage}
        onClick={() => onChange(page + 1)}
        aria-label="Next page"
      >
        Older →
      </button>
    </nav>
  );
}

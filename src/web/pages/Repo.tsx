import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import type { Branch, TreeEntry } from "../types.ts";
import { api } from "../api.ts";
import {
  Avatar,
  EmptyState,
  ErrorBanner,
  Markdown,
  Spinner,
  formatBytes,
  timeAgo,
  useAsync,
} from "../components.tsx";
import { ActionsPage } from "./Actions.tsx";
import { RepoSettings } from "./repo/RepoSettings.tsx";
import { CodeView } from "../components/CodeView.tsx";
import { ImageView } from "../components/ImageView.tsx";
import { CommitHistory, hueFromString } from "../components/CommitHistory.tsx";
import { MediaViewer } from "../components/MediaViewer.tsx";
import { ModelViewer } from "../components/ModelViewer.tsx";
import { highlightLines } from "../highlight.ts";
import { joinRepoPath } from "../repo-path.ts";
import { FileEditorPage } from "./Edit.tsx";
import { ReleasesPage } from "./Releases.tsx";
import { Link, navigate } from "../router.tsx";
import { ComparePrompt } from "../components/ComparePrompt.tsx";
import { TopicBadges } from "./repo/TopicsPanel.tsx";
import { Icon, type IconName } from "../components/Icons.tsx";
import { RepoSocialActions, useSocialCounts } from "../components/RepoSocialActions.tsx";
import { usePopover } from "../use-popover.ts";
import { FileFinder, useFinderShortcut } from "../components/FileFinder.tsx";
import type { Repo } from "../types.ts";


export type RepoTab = "code" | "blob" | "commits" | "branches" | "settings" | "blame" | "actions" | "releases" | "edit" | "new";

interface RepoPageProps {
  owner: string;
  repo: string;
  tab: RepoTab;
  refName?: string;
  filePath?: string;
}

function RepoHeader({
  owner,
  repo,
  tab,
  activeTab: activeTabOverride,
}: RepoPageProps & {
  activeTab?: string;
}): ReactNode {
  const detail = useAsync(() => api.repo(owner, repo), [owner, repo]);
  const activeTab = activeTabOverride ?? (tab === "blob" ? "code" : tab);

  const tabLink = (
    name: RepoTab | "issues" | "pulls" | "milestones",
    label: string,
    icon: IconName,
    count?: number,
  ): ReactNode => {
    const active = activeTab === name;
    return (
      <Link
        to={`/${owner}/${repo}${name === "code" ? "" : `/${name}`}`}
        className={active ? "active" : ""}
        {...(active ? { ariaCurrent: "page" } : {})}
      >
        <Icon name={icon} />
        <span>{label}</span>
        {count ? <span className="count">{count > 999 ? `${(count / 1000).toFixed(count > 9999 ? 0 : 1)}k` : count}</span> : null}
      </Link>
    );
  };

  const stats = detail.data?.stats;
  const isPrivate = detail.data?.visibility === "private";

  return (
    <div className="repo-band">
      <div className="repo-band-inner">
        {detail.error ? <ErrorBanner message={detail.error} /> : null}
        <div className="repo-header-top">
          <h1 className="repo-title">
            <Icon name={isPrivate ? "lock" : "repo"} className="repo-title-icon" />
            <Link to={`/${owner}`} className="repo-title-owner">
              {owner}
            </Link>
            <span className="repo-title-sep">/</span>
            <Link to={`/${owner}/${repo}`} className="repo-title-name">
              {repo}
            </Link>
          </h1>
          <span className="badge repo-visibility">{isPrivate ? "Private" : "Public"}</span>
          {detail.data?.archived ? <span className="badge archived">Archived</span> : null}
          <span className="spacer" />
          <RepoSocialActions owner={owner} repo={repo} />
        </div>
        <nav className="repo-tabs" aria-label="Repository">
          {tabLink("code", "Code", "code")}
          {tabLink("issues", "Issues", "issue", stats?.openIssues ?? detail.data?.openIssues)}
          {tabLink("pulls", "Pull requests", "pull", stats?.openPulls ?? detail.data?.openPulls)}
          {tabLink("actions", "Actions", "play")}
          {tabLink("commits", "Commits", "commit", stats?.commits)}
          {tabLink("branches", "Branches", "branch", stats?.branches)}
          {tabLink("releases", "Releases", "tag", stats?.tags)}
          {tabLink("milestones", "Milestones", "milestone")}
          {detail.data?.permissions?.write ? tabLink("settings", "Settings", "gear") : null}
        </nav>
      </div>
    </div>
  );
}

function LatestCommit({
  owner,
  repo,
  refName,
  path,
}: {
  owner: string;
  repo: string;
  refName: string;
  path: string;
}): ReactNode {
  const latest = useAsync(
    () => api.commits(owner, repo, { ref: refName, perPage: 1, ...(path ? { path } : {}) }),
    [owner, repo, refName, path],
  );
  const commit = latest.data?.items[0];
  if (latest.error || (!latest.loading && !commit)) return null;
  return (
    <div className="latest-commit" aria-busy={latest.loading}>
      {commit ? (
        <>
          <Avatar
            user={{
              username: commit.author.name,
              display_name: commit.author.name || commit.author.email,
              avatar_hue: hueFromString(commit.author.email || commit.author.name),
            }}
          />
          <strong className="latest-commit-author">{commit.author.name}</strong>
          <Link to={`/${owner}/${repo}/commit/${commit.sha}`} className="latest-commit-message" title={commit.message}>
            {commit.message}
          </Link>
          <span className="spacer" />
          <Link to={`/${owner}/${repo}/commit/${commit.sha}`} className="mono faint small" title={commit.sha}>
            {commit.short_sha}
          </Link>
          <span className="faint small" title={new Date(commit.authored_at).toLocaleString()}>
            {timeAgo(commit.authored_at)}
          </span>
          <Link
            to={path ? `/${owner}/${repo}/commits/${refName}/${path}` : `/${owner}/${repo}/commits/${refName}`}
            className="latest-commit-history small"
          >
            History
          </Link>
        </>
      ) : (
        <span className="skeleton-text" style={{ width: "45%" }} aria-hidden="true" />
      )}
    </div>
  );
}

function useRefAndPath(owner: string, repo: string, tail: string | undefined, defaultBranch: string): {
  ref: string;
  path: string;
} {
  const branches = useAsync(() => api.branches(owner, repo), [owner, repo]);
  return useMemo(() => {
    if (!tail) return { ref: defaultBranch, path: "" };
    const names = (branches.data?.items ?? []).map((branch) => branch.name);
    const candidates = [...names, defaultBranch].filter(Boolean).sort((a, b) => b.length - a.length);
    for (const candidate of candidates) {
      if (tail === candidate) return { ref: candidate, path: "" };
      if (tail.startsWith(`${candidate}/`)) {
        return { ref: candidate, path: tail.slice(candidate.length + 1) };
      }
    }
    const slash = tail.indexOf("/");
    if (slash === -1) return { ref: tail, path: "" };
    return { ref: tail.slice(0, slash), path: tail.slice(slash + 1) };
  }, [tail, branches.data, defaultBranch]);
}

function RefSelector({
  owner,
  repo,
  current,
  onSelect,
}: {
  owner: string;
  repo: string;
  current: string;
  onSelect: (ref: string) => void;
}): ReactNode {
  const branches = useAsync(() => api.branches(owner, repo), [owner, repo]);
  const tags = useAsync(() => api.tags(owner, repo), [owner, repo]);
  return (
    <select value={current} onChange={(event) => onSelect(event.target.value)} className="ref-selector" aria-label="Branch or tag">
      {(branches.data?.items ?? []).length > 0 ? (
        <optgroup label="Branches">
          {branches.data?.items.map((branch: Branch) => (
            <option key={branch.name} value={branch.name}>
              {branch.name}
            </option>
          ))}
        </optgroup>
      ) : null}
      {(tags.data?.items ?? []).length > 0 ? (
        <optgroup label="Tags">
          {tags.data?.items.map((tag) => (
            <option key={tag.name} value={tag.name}>
              {tag.name}
            </option>
          ))}
        </optgroup>
      ) : null}
    </select>
  );
}

function CodeBrowser({
  owner,
  repo,
  refName,
  defaultBranch,
  canWrite,
  detail,
}: {
  owner: string;
  repo: string;
  refName?: string;
  defaultBranch: string;
  canWrite: boolean;
  detail: Repo | null;
}): ReactNode {
  const { ref, path } = useRefAndPath(owner, repo, refName, defaultBranch);
  const tree = useAsync(() => api.tree(owner, repo, { ref, path }), [owner, repo, ref, path]);
  const readme = useAsync(() => (path ? Promise.resolve(null) : api.readme(owner, repo, ref)), [owner, repo, ref, path]);
  const [finderOpen, setFinderOpen] = useState(false);
  const openFinder = useCallback(() => setFinderOpen(true), []);
  useFinderShortcut(openFinder);

  const segments = path ? path.split("/") : [];
  const atRoot = !path;
  const parentPath = `/${owner}/${repo}/tree/${ref}${segments.length > 1 ? `/${segments.slice(0, -1).join("/")}` : ""}`;

  const main = (
    <div className="repo-code-main">
      <div className="repo-code-toolbar">
        <RefSelector owner={owner} repo={repo} current={ref} onSelect={(next) => navigate(`/${owner}/${repo}/tree/${next}`)} />
        {atRoot && detail?.stats ? (
          <span className="code-toolbar-counts">
            <Link to={`/${owner}/${repo}/branches`} className="muted-link">
              <Icon name="branch" />
              <strong>{detail.stats.branches.toLocaleString()}</strong> {detail.stats.branches === 1 ? "Branch" : "Branches"}
            </Link>
            <Link to={`/${owner}/${repo}/releases`} className="muted-link">
              <Icon name="tag" />
              <strong>{detail.stats.tags.toLocaleString()}</strong> {detail.stats.tags === 1 ? "Tag" : "Tags"}
            </Link>
          </span>
        ) : (
          <nav className="breadcrumbs" aria-label="Path">
            <Link to={`/${owner}/${repo}/tree/${ref}`} className="breadcrumb-root">
              {repo}
            </Link>
            {segments.map((segment, index) => (
              <span key={`${segment}-${index}`}>
                <span className="breadcrumb-sep">/</span>
                {index === segments.length - 1 ? (
                  <strong>{segment}</strong>
                ) : (
                  <Link to={`/${owner}/${repo}/tree/${ref}/${segments.slice(0, index + 1).join("/")}`}>{segment}</Link>
                )}
              </span>
            ))}
          </nav>
        )}
        <span className="spacer" />
        <button type="button" className="btn-secondary go-to-file" onClick={openFinder} title="Go to file (t)">
          <Icon name="search" />
          <span className="go-to-file-label">Go to file</span>
          <kbd>t</kbd>
        </button>
        {canWrite ? (
          <Link className="btn-secondary" to={`/${owner}/${repo}/new/${ref}${path ? `/${path}` : ""}`} title="Create a new file here">
            <Icon name="plus" />
            <span className="hide-sm">Add file</span>
          </Link>
        ) : null}
        <CloneMenu owner={owner} repo={repo} refName={ref} />
      </div>

      <div className="file-box">
        <LatestCommit owner={owner} repo={repo} refName={ref} path={path} />
        {tree.error ? <ErrorBanner message={tree.error} /> : null}
        {tree.loading ? (
          <div className="filelist code-filelist" aria-busy="true">
            {[60, 45, 70, 52, 38].map((width, index) => (
              <div className="entry" key={index}>
                <span className="skeleton-text" style={{ width: `${width}%` }} />
              </div>
            ))}
          </div>
        ) : (tree.data?.items.length ?? 0) === 0 ? (
          <EmptyState title="This repository is empty" hint={`Push to ${ref} to get started.`} />
        ) : (
          <div className="filelist code-filelist">
            {path ? (
              <div className="entry">
                <Icon name="folder" className="entry-icon is-dir" />
                <Link className="name" to={parentPath} aria-label="Parent directory">
                  ..
                </Link>
              </div>
            ) : null}
            {tree.data?.items.map((entry: TreeEntry) => (
              <div className="entry" key={entry.sha + entry.path}>
                <Icon name={entry.type === "tree" ? "folder" : "file"} className={`entry-icon${entry.type === "tree" ? " is-dir" : ""}`} />
                <Link
                  className="name"
                  to={entry.type === "tree" ? `/${owner}/${repo}/tree/${ref}/${entry.path}` : `/${owner}/${repo}/blob/${ref}/${entry.path}`}
                >
                  {entry.name}
                </Link>
                <span className="size">{entry.type === "blob" ? formatBytes(entry.size) : ""}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      {readme.data?.content ? (
        <section className="readme-box" aria-label="README">
          <header className="readme-head">
            <Icon name="book" />
            <span>{(readme.data.path ?? "README").split("/").pop()}</span>
            <span className="spacer" />
            <Link to={`/${owner}/${repo}/blob/${readme.data.ref ?? ref}/${readme.data.path ?? ""}`} className="small muted-link">
              View file
            </Link>
          </header>
          <div className="readme-body">
            <Markdown
              source={readme.data.content}
              resolveImageUrl={(src) => {
                const readmePath = readme.data?.path ?? "";
                const dir = readmePath.includes("/") ? readmePath.slice(0, readmePath.lastIndexOf("/")) : "";
                return api.rawUrl(owner, repo, { ref: readme.data?.ref ?? ref, path: joinRepoPath(dir, src) });
              }}
            />
          </div>
        </section>
      ) : null}
      {finderOpen ? <FileFinder owner={owner} repo={repo} refName={ref} onClose={() => setFinderOpen(false)} /> : null}
    </div>
  );

  if (!atRoot) return <div className="repo-code-layout is-single">{main}</div>;

  return (
    <div className="repo-code-layout">
      {main}
      <AboutSidebar owner={owner} repo={repo} refName={ref} detail={detail} />
    </div>
  );
}

function CloneMenu({ owner, repo, refName }: { owner: string; repo: string; refName: string }): ReactNode {
  const { open, setOpen, ref: rootRef } = usePopover<HTMLDivElement>();
  const [copied, setCopied] = useState(false);
  const cloneUrl = `${window.location.origin}/${owner}/${repo}.git`;

  return (
    <div className="clone-menu" ref={rootRef}>
      <button type="button" className="btn-primary clone-trigger" aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <Icon name="code" />
        <span>Code</span>
        <Icon name="chevron" />
      </button>
      {open ? (
        <div className="clone-panel" role="dialog" aria-label="Clone this repository">
          <div className="clone-panel-title">
            <Icon name="code" /> Clone
          </div>
          <label className="small faint" htmlFor="clone-url">HTTPS</label>
          <div className="clone-field">
            <input id="clone-url" readOnly value={cloneUrl} className="mono" onFocus={(event) => event.target.select()} />
            <button
              type="button"
              className="btn-secondary icon-only"
              aria-label={copied ? "Copied" : "Copy clone URL"}
              title={copied ? "Copied" : "Copy"}
              onClick={() => {
                void navigator.clipboard?.writeText(cloneUrl).then(() => {
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1500);
                });
              }}
            >
              <Icon name={copied ? "check" : "copy"} />
            </button>
          </div>
          <p className="small faint" style={{ margin: "6px 0 0" }}>
            Clone over HTTPS with a password or an access token. Git LFS works over the same URL.
          </p>
          <div className="clone-panel-actions">
            <a href={api.archiveUrl(owner, repo, { ref: refName, format: "zip" })}>
              <Icon name="download" /> Download ZIP
            </a>
            <a href={api.archiveUrl(owner, repo, { ref: refName, format: "tar.gz" })}>
              <Icon name="download" /> Download tar.gz
            </a>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function AboutSidebar({ owner, repo, refName, detail }: { owner: string; repo: string; refName: string; detail: Repo | null }): ReactNode {
  const topics = useAsync(() => api.topics(owner, repo), [owner, repo]);
  const languages = useAsync(() => api.languages(owner, repo, refName), [owner, repo, refName]);
  const stats = detail?.stats;
  const live = useSocialCounts(owner, repo);
  const stars = live?.stars ?? stats?.stars ?? 0;
  const forks = live?.forks ?? stats?.forks ?? 0;
  const watchers = live?.watchers ?? 0;
  const langs = languages.data?.items ?? [];

  return (
    <aside className="repo-sidebar" aria-label="About this repository">
      <section className="sidebar-section">
        <h2 className="sidebar-heading">About</h2>
        {detail ? (
          detail.description ? <p className="sidebar-description">{detail.description}</p> : <p className="sidebar-description faint">No description provided.</p>
        ) : (
          <span className="skeleton-text" style={{ width: "80%" }} />
        )}
        {topics.data && topics.data.topics.length > 0 ? <TopicBadges topics={topics.data.topics} /> : null}
        <ul className="sidebar-facts">
          {stats ? (
            <>
              <li><Icon name="history" /><Link to={`/${owner}/${repo}/commits`} className="muted-link"><strong>{stats.commits.toLocaleString()}</strong> {stats.commits === 1 ? "commit" : "commits"}</Link></li>
              <li><Icon name="star" /><Link to={`/${owner}/${repo}/stargazers`} className="muted-link"><strong>{stars.toLocaleString()}</strong> {stars === 1 ? "star" : "stars"}</Link></li>
              <li><Icon name="eye" /><Link to={`/${owner}/${repo}/watchers`} className="muted-link"><strong>{watchers.toLocaleString()}</strong> watching</Link></li>
              <li><Icon name="fork" /><Link to={`/${owner}/${repo}/forks`} className="muted-link"><strong>{forks.toLocaleString()}</strong> {forks === 1 ? "fork" : "forks"}</Link></li>
              <li title="Size of the git object database"><Icon name="database" /><strong>{formatBytes(stats.sizeBytes)}</strong> git storage</li>
              {stats.lfsBytes ? (
                <li title={`${(stats.lfsObjects ?? 0).toLocaleString()} stored LFS objects`}>
                  <Icon name="cube" /><strong>{formatBytes(stats.lfsBytes)}</strong> LFS ({(stats.lfsObjects ?? 0).toLocaleString()} objects)
                </li>
              ) : null}
            </>
          ) : (
            <li><span className="skeleton-text" style={{ width: "60%" }} /></li>
          )}
        </ul>
      </section>

      {langs.length > 0 ? (
        <section className="sidebar-section">
          <h2 className="sidebar-heading">Languages</h2>
          <div className="lang-bar" role="img" aria-label={langs.map((l) => `${l.name} ${l.percent}%`).join(", ")}>
            {langs.map((lang) => (
              <span key={lang.name} style={{ width: `${Math.max(lang.percent, 0.4)}%`, background: lang.color }} title={`${lang.name} ${lang.percent}%`} />
            ))}
          </div>
          <ul className="lang-list">
            {langs.map((lang) => (
              <li key={lang.name}>
                <span className="lang-dot" style={{ background: lang.color }} aria-hidden="true" />
                <strong>{lang.name}</strong>
                <span className="faint">{lang.percent.toFixed(1)}%</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </aside>
  );
}

function BlobViewer({
  owner,
  repo,
  refName,
  defaultBranch,
  canWrite,
}: {
  owner: string;
  repo: string;
  refName?: string;
  defaultBranch: string;
  canWrite: boolean;
}): ReactNode {
  const { ref, path } = useRefAndPath(owner, repo, refName, defaultBranch);
  const blob = useAsync(() => (path ? api.blob(owner, repo, { ref, path }) : Promise.resolve(null)), [
    owner,
    repo,
    ref,
    path,
  ]);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const isGltf = path.toLowerCase().endsWith(".gltf");
  const [showSource, setShowSource] = useState(false);

  const doDelete = async (): Promise<void> => {
    if (!path) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      await api.deleteContents(owner, repo, { path, branch: ref });
      navigate(`/${owner}/${repo}/tree/${ref}${parentPath ? `/${parentPath}` : ""}`);
    } catch (cause) {
      setDeleteError(cause instanceof Error ? cause.message : "Could not delete the file");
    } finally {
      setDeleting(false);
      setConfirmingDelete(false);
    }
  };
  const wrap = false;
  const segments = path ? path.split("/") : [];

  if (!path) return <EmptyState title="No file selected" />;

  const parentPath = segments.slice(0, -1).join("/");
  const rawHref = api.rawUrl(owner, repo, { ref, path });
  const downloadHref = api.rawUrl(owner, repo, { ref, path, download: true });

  return (
    <div className="card">
      <div className="row wrap file-toolbar">
        <Link to={`/${owner}/${repo}/tree/${ref}${parentPath ? `/${parentPath}` : ""}`} className="small">
          ← back to {parentPath || "root"}
        </Link>
        <span className="spacer" />
        <Link to={`/${owner}/${repo}/commits/${ref}/${path}`} className="small" title="History for this file">
          History
        </Link>
        <Link to={`/${owner}/${repo}/blame/${ref}/${path}`} className="small">
          Blame
        </Link>
        <a className="small" href={rawHref}>
          Raw
        </a>
        <a className="small" href={downloadHref}>
          Download
        </a>
        {canWrite ? (
          <>
            <Link className="small" to={`/${owner}/${repo}/edit/${ref}/${path}`} title="Edit this file in the browser">
              Edit
            </Link>
            {confirmingDelete ? (
              <>
                <button type="button" className="danger small" disabled={deleting} onClick={() => void doDelete()}>
                  {deleting ? "Deleting…" : "Confirm delete"}
                </button>
                <button type="button" className="ghost small" onClick={() => setConfirmingDelete(false)}>
                  Cancel
                </button>
              </>
            ) : (
              <button type="button" className="ghost small" onClick={() => setConfirmingDelete(true)}>
                Delete
              </button>
            )}
          </>
        ) : null}
      </div>
      <ErrorBanner message={deleteError} />

      {blob.error ? <ErrorBanner message={blob.error} /> : null}
      {blob.loading ? (
        <Spinner label="Loading file" />
      ) : blob.data?.kind === "image" ? (
        <ImageView
          src={rawHref}
          alt={path}
          sizeBytes={blob.data.size}
          path={path}
          downloadHref={downloadHref}
          mime={blob.data.mime}
        />
      ) : blob.data?.kind === "audio" || blob.data?.kind === "video" ? (
        <MediaViewer
          kind={blob.data.kind}
          src={rawHref}
          downloadHref={downloadHref}
          path={path}
          sizeBytes={blob.data.size}
          mime={blob.data.mime}
        />
      ) : blob.data?.kind === "model" ? (
        <ModelViewer
          src={rawHref}
          downloadHref={downloadHref}
          path={path}
          sizeBytes={blob.data.size}
          mime={blob.data.mime}
        />
      ) : blob.data?.kind === "text" && isGltf && !showSource ? (
        <>
          <PreviewToggle showSource={false} onChange={setShowSource} />
          <ModelViewer src={rawHref} downloadHref={downloadHref} path={path} sizeBytes={blob.data.size} mime="model/gltf+json" />
        </>
      ) : blob.data?.kind === "binary" ? (
        <EmptyState
          title="Binary file"
          hint={`${formatBytes(blob.data.size)} · ${blob.data.mime}. Download it to inspect, or use the raw link.`}
        />
      ) : blob.data?.content !== null && blob.data !== null ? (
        <>
          {isGltf ? <PreviewToggle showSource onChange={setShowSource} /> : null}
          <div className="row wrap small faint" style={{ marginBottom: 8 }}>
            <span className="spacer" />
            {blob.data.truncated ? (
              <span className="badge closed" title="The file is larger than the inline view limit">
                truncated
              </span>
            ) : null}
            <span>{formatBytes(blob.data.size)}</span>
          </div>
          <CodeView
            lineLinks
            code={blob.data.content}
            language={blob.data.language}
            wrapByDefault={wrap}
            initialLines={3000}
          />
        </>
      ) : null}
    </div>
  );
}

function PreviewToggle({ showSource, onChange }: { showSource: boolean; onChange: (source: boolean) => void }): ReactNode {
  return (
    <div className="segmented" role="group" aria-label="View mode" style={{ marginBottom: 10 }}>
      <button type="button" aria-pressed={!showSource} onClick={() => onChange(false)}>
        Preview
      </button>
      <button type="button" aria-pressed={showSource} onClick={() => onChange(true)}>
        Code
      </button>
    </div>
  );
}

function BlameView({
  owner,
  repo,
  refName,
  defaultBranch,
}: {
  owner: string;
  repo: string;
  refName?: string;
  defaultBranch: string;
}): ReactNode {
  const { ref, path } = useRefAndPath(owner, repo, refName, defaultBranch);
  const blame = useAsync(() => (path ? api.blame(owner, repo, { ref, path }) : Promise.resolve(null)), [
    owner,
    repo,
    ref,
    path,
  ]);

  const html = useMemo(() => {
    if (!blame.data) return null;
    return highlightLines(
      blame.data.lines.map((line) => line.text).join("\n"),
      blame.data.language ?? null,
    ).lines;
  }, [blame.data]);

  if (!path) return <EmptyState title="Pick a file to blame" hint="Open a file and choose Blame." />;
  if (blame.error) return <ErrorBanner message={blame.error} />;
  if (blame.loading) return <Spinner label="Computing blame" />;
  if (!blame.data) return null;

  const segments = path.split("/");

  return (
    <div className="card">
      <div className="row wrap" style={{ marginBottom: 12 }}>
        <span className="mono small truncate" title={path}>
          {segments.join(" / ")}
        </span>
        <span className="spacer" />
        <Link to={`/${owner}/${repo}/blob/${ref}/${path}`} className="small">
          View file
        </Link>
      </div>

      {blame.data.truncated ? (
        <div className="notice-banner small">
          Blame was truncated at {blame.data.lines.length.toLocaleString()} lines.
        </div>
      ) : null}

      <div className="code-scroll code-large" role="region" aria-label="Blame">
        <div className="blame-body">
          {blame.data.lines.map((line, index) => {
            const previous = blame.data?.lines[index - 1];
            const startsGroup = previous === undefined || previous.group !== line.group;
            return (
              <div className="blame-entry" key={line.line}>
                {startsGroup ? (
                  <div className="blame-group small">
                    <span className="mono">{line.short_sha}</span>
                    <span className="faint truncate">{line.author}</span>
                    <span className="faint">{timeAgo(line.authored_at)}</span>
                    <span className="spacer" />
                    <Link to={`/${owner}/${repo}/commit/${line.sha}`} className="small">
                      view
                    </Link>
                  </div>
                ) : null}
                <div className="code-line">
                  <span className="code-ln" aria-hidden="true">
                    {line.line}
                  </span>
                  <span className="code-lc" dangerouslySetInnerHTML={{ __html: html?.[index] ?? "" }} />
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function CommitList({
  owner,
  repo,
  refName,
  filePath,
  defaultBranch,
}: {
  owner: string;
  repo: string;
  refName?: string;
  filePath?: string;
  defaultBranch: string;
}): ReactNode {
  const ref = refName || defaultBranch;
  const [page, setPage] = useState(1);
  useEffect(() => { setPage(1); }, [owner, repo, ref, filePath]);
  const commits = useAsync(
    () => api.commits(owner, repo, { ref, ...(filePath ? { path: filePath } : {}), page }),
    [owner, repo, ref, filePath, page],
  );
  const items = commits.data?.items ?? [];
  const hasMore = commits.data?.has_more ?? false;
  return (
    <div className="card">
      <div className="row" style={{ marginBottom: 10 }}>
        <h3 style={{ margin: 0 }}>
          {filePath ? (
            <>
              History for <span className="mono">{filePath}</span>
            </>
          ) : (
            <>Commits on {ref}</>
          )}
        </h3>
        <span className="spacer" />
      </div>
      {commits.error ? <ErrorBanner message={commits.error} /> : null}
      {commits.loading && items.length === 0 ? (
        <Spinner />
      ) : items.length === 0 ? (
        <EmptyState title="No commits on this ref" />
      ) : (
        <div aria-busy={commits.loading} style={commits.loading ? { opacity: 0.55 } : undefined}>
          <CommitHistory owner={owner} repo={repo} commits={items} />
          {page > 1 || hasMore ? (
            <div className="row" style={{ marginTop: 12 }}>
              <button type="button" className="ghost small" disabled={page === 1 || commits.loading} onClick={() => setPage((p) => Math.max(1, p - 1))}>
                Newer
              </button>
              <span className="faint small" role="status">Page {page}</span>
              <button type="button" className="ghost small" disabled={!hasMore || commits.loading} onClick={() => setPage((p) => p + 1)}>
                Older commits
              </button>
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}

function BranchList({ owner, repo }: { owner: string; repo: string }): ReactNode {
  const branches = useAsync(() => api.branches(owner, repo), [owner, repo]);
  const tags = useAsync(() => api.tags(owner, repo), [owner, repo]);
  return (
    <div className="card">
      <h3>Branches</h3>
      {branches.error ? <ErrorBanner message={branches.error} /> : null}
      {branches.loading ? (
        <Spinner />
      ) : (
        <table className="list">
          <tbody>
            {(branches.data?.items ?? []).map((branch) => (
              <tr key={branch.name}>
                <td>
                  <Link to={`/${owner}/${repo}/tree/${branch.name}`}>{branch.name}</Link>
                  {branch.name === branches.data?.default_branch ? (
                    <span className="badge" style={{ marginLeft: 8 }}>
                      default
                    </span>
                  ) : null}
                </td>
                <td className="mono small faint">{branch.sha.slice(0, 10)}</td>
                <td className="small faint" style={{ textAlign: "right" }}>
                  {timeAgo(branch.updated_at)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <h3 style={{ marginTop: 22 }}>Tags</h3>
      {(tags.data?.items ?? []).length === 0 ? (
        <p className="faint small">No tags.</p>
      ) : (
        <table className="list">
          <tbody>
            {tags.data?.items.map((tag) => (
              <tr key={tag.name}>
                <td>
                  <Link to={`/${owner}/${repo}/tree/${tag.name}`}>{tag.name}</Link>
                </td>
                <td className="mono small faint">{tag.sha.slice(0, 10)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}






export function RepoShell({ owner, repo, activeTab, children }: {
  owner: string;
  repo: string;
  activeTab: "issues" | "pulls" | "milestones" | "commits" | "code";
  children: ReactNode;
}): ReactNode {
  return (
    <>
      <RepoHeader owner={owner} repo={repo} tab="code" activeTab={activeTab} />
      {children}
    </>
  );
}

export function RepoPage(props: RepoPageProps): ReactNode {
  const { owner, repo, tab, refName, filePath } = props;
  const detail = useAsync(() => api.repo(owner, repo), [owner, repo]);
  const defaultBranch = detail.data?.default_branch ?? "main";

  return (
    <>
      <RepoHeader {...props} />
      <ComparePrompt owner={owner} repo={repo} currentRef={refName ?? defaultBranch} defaultBranch={defaultBranch} />
      {tab === "code" ? (
        <CodeBrowser owner={owner} repo={repo} refName={refName} defaultBranch={defaultBranch} canWrite={detail.data?.permissions?.write === true} detail={detail.data ?? null} />
      ) : tab === "blob" ? (
        <BlobViewer owner={owner} repo={repo} refName={refName} defaultBranch={defaultBranch} canWrite={detail.data?.permissions?.write === true} />
      ) : tab === "edit" || tab === "new" ? (
        <FileEditorPage
          owner={owner}
          repo={repo}
          mode={tab === "edit" ? "edit" : "create"}
          branch={refName ?? defaultBranch}
          filePath={filePath}
        />
      ) : tab === "blame" ? (
        <BlameView owner={owner} repo={repo} refName={refName} defaultBranch={defaultBranch} />
      ) : tab === "commits" ? (
        <CommitList
          owner={owner}
          repo={repo}
          refName={refName}
          filePath={filePath}
          defaultBranch={defaultBranch}
        />
      ) : tab === "branches" ? (
        <BranchList owner={owner} repo={repo} />
      ) : tab === "actions" ? (
        <ActionsPage owner={owner} repo={repo} />
      ) : tab === "releases" ? (
        <ReleasesPage owner={owner} repo={repo} canWrite={detail.data?.permissions?.write === true} />
      ) : (
        <RepoSettings owner={owner} repo={repo} />
      )}
    </>
  );
}

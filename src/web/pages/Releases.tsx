import { useState, type ReactNode } from "react";
import { api } from "../api.ts";
import { ErrorBanner, Markdown, Notice, Spinner, formatBytes, timeAgo, useAsync } from "../components.tsx";
import type { Release } from "../types.ts";

export function ReleasesPage({
  owner,
  repo,
  canWrite,
}: {
  owner: string;
  repo: string;
  canWrite: boolean;
}): ReactNode {
  const releases = useAsync(() => api.releases(owner, repo), [owner, repo]);
  const [showForm, setShowForm] = useState(false);
  const items = releases.data?.items ?? [];

  return (
    <>
      {canWrite ? (
        <div className="row" style={{ marginBottom: 14 }}>
          <span className="spacer" />
          <button type="button" className="primary" onClick={() => setShowForm((value) => !value)}>
            {showForm ? "Close form" : "Draft a new release"}
          </button>
        </div>
      ) : null}

      {showForm && canWrite ? (
        <ReleaseForm
          owner={owner}
          repo={repo}
          onDone={() => {
            setShowForm(false);
            releases.reload();
          }}
        />
      ) : null}

      <ErrorBanner message={releases.error} />
      {releases.loading ? (
        <Spinner label="Loading releases" />
      ) : items.length === 0 ? (
        <div className="card">
          <div className="empty">
            <p style={{ margin: "0 0 6px" }}>No releases yet</p>
            <p className="small faint" style={{ margin: 0 }}>
              {canWrite
                ? "Cut one from a tag - or let the form create the tag for you."
                : "Releases published here will appear with their notes and assets."}
            </p>
          </div>
        </div>
      ) : (
        items.map((release) => (
          <ReleaseCard key={release.id} owner={owner} repo={repo} release={release} canWrite={canWrite} onChanged={() => releases.reload()} />
        ))
      )}
    </>
  );
}

function ReleaseCard({
  owner,
  repo,
  release,
  canWrite,
  onChanged,
}: {
  owner: string;
  repo: string;
  release: Release;
  canWrite: boolean;
  onChanged: () => void;
}): ReactNode {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const destroy = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await api.deleteRelease(owner, repo, release.id);
      onChanged();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not delete the release");
    } finally {
      setBusy(false);
      setConfirming(false);
    }
  };

  return (
    <div className="card release">
      <div className="release-head">
        <span className="release-tag">{release.tag_name}</span>
        {release.name ? <strong>{release.name}</strong> : null}
        {release.prerelease ? <span className="badge">pre-release</span> : null}
        {release.draft ? <span className="badge private">draft</span> : null}
        <span className="spacer" />
        <span className="faint small">{timeAgo(release.created_at)}</span>
        {canWrite ? (
          confirming ? (
            <>
              <button type="button" className="danger small" disabled={busy} onClick={() => void destroy()}>
                {busy ? "Deleting…" : "Confirm delete"}
              </button>
              <button type="button" className="ghost small" onClick={() => setConfirming(false)}>
                Cancel
              </button>
            </>
          ) : (
            <button type="button" className="ghost small" onClick={() => setConfirming(true)}>
              Delete
            </button>
          )
        ) : null}
      </div>
      <ErrorBanner message={error} />
      <div className="small faint release-byline">
        by @{release.author}
      </div>
      {release.body ? (
        <div className="release-body">
          <Markdown source={release.body} />
        </div>
      ) : null}
      {release.assets.length > 0 ? (
        <div className="release-assets">
          {release.assets.map((asset) => (
            <div className="asset-row" key={asset.id}>
              <a href={api.releaseAssetUrl(owner, repo, release.id, asset.id)} download>
                {asset.name}
              </a>
              <span className="faint small">
                {formatBytes(asset.size)} · {asset.downloads} download{asset.downloads === 1 ? "" : "s"}
              </span>
              <span className="spacer" />
              <a className="small" href={api.releaseAssetUrl(owner, repo, release.id, asset.id)} download>
                Download
              </a>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function ReleaseForm({ owner, repo, onDone }: { owner: string; repo: string; onDone: () => void }): ReactNode {
  const [tagName, setTagName] = useState("");
  const [name, setName] = useState("");
  const [body, setBody] = useState("");
  const [prerelease, setPrerelease] = useState(false);
  const [asset, setAsset] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (): Promise<void> => {
    setError(null);
    setBusy(true);
    try {
      const release = await api.createRelease(owner, repo, {
        tag_name: tagName.trim(),
        name: name.trim(),
        body,
        prerelease,
      });
      if (asset) {
        await api.uploadReleaseAsset(owner, repo, release.id, asset);
      }
      onDone();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not publish the release");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card release-form">
      <h3>Draft a new release</h3>
      <ErrorBanner message={error} />
      <Notice>
        The tag is created for you at the default branch if it does not exist yet. An existing tag is never moved.
      </Notice>
      <div className="release-form-row">
        <label>
          Tag name
          <input
            value={tagName}
            onChange={(event) => setTagName(event.target.value)}
            placeholder="v1.0.0"
            aria-label="Tag name"
          />
        </label>
        <label>
          Release title
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="First stable build"
            aria-label="Release title"
          />
        </label>
      </div>
      <label>
        Notes
        <textarea
          value={body}
          onChange={(event) => setBody(event.target.value)}
          placeholder="What changed, and why it matters. Markdown works."
          aria-label="Release notes"
        />
      </label>
      <label>
        Attach an asset (optional)
        <input
          type="file"
          onChange={(event) => setAsset(event.target.files?.[0] ?? null)}
          aria-label="Release asset"
        />
      </label>
      <label className="check-row">
        <input type="checkbox" checked={prerelease} onChange={(event) => setPrerelease(event.target.checked)} />
        This is a pre-release
      </label>
      <div className="row">
        <button type="button" className="primary" disabled={busy || !tagName.trim()} onClick={() => void submit()}>
          {busy ? "Publishing…" : "Publish release"}
        </button>
      </div>
    </div>
  );
}

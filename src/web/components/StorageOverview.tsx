import { formatBytes } from "../components.tsx";

export interface StorageCategoryView {
  bytes: number;
  files: number;
}

export interface StorageFilesystemView {
  id: string;
  totalBytes: number;
  availableBytes: number;
  additive: boolean;
}

export interface StorageOverviewData {
  status: "scanning" | "current" | "stale" | "error";
  sampledAt: number | null;
  scanning: boolean;
  stale: boolean;
  error: string | null;
  repositories: StorageCategoryView | null;
  lfs: StorageCategoryView | null;
  releaseAssets: StorageCategoryView | null;
  database: StorageCategoryView | null;
  trackedBytes: number | null;
  trackedFiles: number | null;
  truncated: boolean;
  filesystems: StorageFilesystemView[];
  filesystemsAdditive: boolean;
  quota: null;
  readiness: null;
  labels: {
    quota: string;
    readiness: string;
    measurement: string;
  };
}

const categories: Array<[keyof Pick<StorageOverviewData, "repositories" | "lfs" | "releaseAssets" | "database">, string, string]> = [
  ["repositories", "Repositories", "Git repository files"],
  ["lfs", "Git LFS", "LFS object files"],
  ["releaseAssets", "Release assets", "Release download files"],
  ["database", "SQLite", "Main database, WAL, and SHM"],
];

function categoryText(category: StorageCategoryView | null): string {
  if (!category) return "Not sampled yet";
  return `${formatBytes(category.bytes)} · ${category.files.toLocaleString()} files`;
}

export function StorageOverview({ data }: { data: StorageOverviewData | null }) {
  const status = data?.status ?? "scanning";
  const label = status === "scanning" ? "Sampling storage" : status === "stale" ? "Showing last complete sample" : status === "error" ? "Sample unavailable" : "Sample current";
  return (
    <section className="storage-overview card" aria-label="Storage overview">
      <style>{`
        .storage-overview { display: grid; gap: 16px; }
        .storage-overview-head, .storage-overview-total { display: flex; justify-content: space-between; gap: 12px; align-items: baseline; }
        .storage-overview-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 12px; margin: 0; }
        .storage-overview-grid div, .storage-filesystem { padding: 12px; background: var(--bg-inset); border-radius: 10px; }
        .storage-overview dt { color: var(--text-dim); font-size: 12px; }
        .storage-overview dd { margin: 4px 0 0; font-variant-numeric: tabular-nums; }
        .storage-note { margin: 0; }
      `}</style>
      <div className="storage-overview-head">
        <div>
          <h2>Storage</h2>
          <p className="muted small">{data?.labels.measurement ?? "Logical usage is sampled in the background."}</p>
        </div>
        <span className={`badge storage-status-${status}`}>{label}</span>
      </div>
      {!data || (status === "scanning" && data.trackedBytes === null) ? <p className="muted">Waiting for the first background sample. This page does not scan disk on every refresh.</p> : null}
      {data?.error ? <p className="error-banner" role="alert">{data.stale ? "Latest sample failed. The previous sample is still shown." : data.error}</p> : null}
      {data && data.trackedBytes !== null ? (
        <>
          <div className="storage-overview-total">
            <strong>{data.truncated ? "At least " : ""}{formatBytes(data.trackedBytes)}</strong>
            <span className="muted small">{(data.trackedFiles ?? 0).toLocaleString()} tracked files{data.truncated ? " · sample reached its scan limit" : ""}</span>
          </div>
          <dl className="storage-overview-grid">
            {categories.map(([key, name, detail]) => (
              <div key={key}>
                <dt>{name}</dt>
                <dd>{categoryText(data[key])}</dd>
                <p className="faint small">{detail}</p>
              </div>
            ))}
          </dl>
          <div>
            <h3>Filesystems</h3>
            <p className="muted small">{data.filesystemsAdditive ? "Configured locations share one filesystem, so its free space is shown once." : "Locations are not additive. Totals are not summed across filesystems."}</p>
            {data.filesystems.map((filesystem, index) => (
              <div className="storage-filesystem" key={`${filesystem.id}-${index}`}>
                <strong>{filesystem.additive ? "Shared filesystem" : `Distinct filesystem ${index + 1}`}</strong>
                <p>{filesystem.totalBytes > 0 ? `${formatBytes(filesystem.availableBytes)} available of ${formatBytes(filesystem.totalBytes)}` : "Capacity unavailable"}</p>
                {filesystem.totalBytes > 0 ? <progress aria-label="Filesystem capacity used or reserved" max={filesystem.totalBytes} value={Math.max(0, filesystem.totalBytes - filesystem.availableBytes)} style={{ width: "100%", height: 8, accentColor: "var(--accent)" }} /> : null}
              </div>
            ))}
          </div>
          <p className="storage-note small faint">Sampled {data.sampledAt ? new Date(data.sampledAt).toLocaleString() : "not yet"}. Shared-disk usage includes other services and reserved space. Repository totals exclude backups and filesystem overhead. Samples are not atomic.</p>
        </>
      ) : null}
    </section>
  );
}

import { useEffect, useState, type ReactNode } from "react";
import { renderMarkdown } from "./markdown.tsx";
import "./components/Markdown.css";
import type { User } from "./types.ts";

export function identiconCells(seed: string): boolean[] {
  let hash = 0x811c9dc5;
  for (const char of seed.toLowerCase()) {
    hash ^= char.codePointAt(0)!;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  const cells: boolean[] = [];
  for (let row = 0; row < 5; row += 1) {
    for (let col = 0; col < 5; col += 1) {
      const mirrored = col < 3 ? col : 4 - col;
      cells.push(((hash >>> (row * 3 + mirrored)) & 1) === 1);
    }
  }
  if (!cells.some(Boolean)) cells[12] = true;
  return cells;
}

const identiconCache = new Map<string, ReactNode>();

function Identicon({ username, hue }: { username: string; hue: number }): ReactNode {
  const key = `${username.toLowerCase()}:${hue}`;
  const cached = identiconCache.get(key);
  if (cached) return cached;
  const cells = identiconCells(username);
  const svg = (
    <svg viewBox="-0.6 -0.6 6.2 6.2" shapeRendering="crispEdges" aria-hidden="true" focusable="false">
      {cells.map((on, index) => (on ? <rect key={index} x={index % 5} y={Math.floor(index / 5)} width="1.02" height="1.02" fill={`hsl(${hue} 52% 54%)`} /> : null))}
    </svg>
  );
  if (identiconCache.size > 500) identiconCache.clear();
  identiconCache.set(key, svg);
  return svg;
}

export function Avatar({ user, size = "sm" }: { user: Pick<User, "username" | "display_name" | "avatar_hue">; size?: "sm" | "lg" | "xl" }): ReactNode {
  return (
    <span className={`avatar identicon${size === "sm" ? "" : ` ${size}`}`} title={user.username} aria-hidden="true">
      <Identicon username={user.username} hue={user.avatar_hue} />
    </span>
  );
}

export function Spinner({ label }: { label?: string }): ReactNode {
  return (
    <div className="row" role="status" aria-live="polite">
      <span className="spinner" />
      <span className="muted small">{label ?? "Loading"}</span>
    </div>
  );
}

export function EmptyState({ title, hint }: { title: string; hint?: string }): ReactNode {
  return (
    <div className="empty">
      <div style={{ fontWeight: 600, color: "var(--text)" }}>{title}</div>
      {hint ? <div className="small">{hint}</div> : null}
    </div>
  );
}

export function ErrorBanner({ message }: { message: string | null }): ReactNode {
  if (!message) return null;
  return (
    <div className="error-banner" role="alert">
      {message}
    </div>
  );
}

export function Notice({ children }: { children: ReactNode }): ReactNode {
  return <div className="notice-banner">{children}</div>;
}

export function Badge({ kind, children }: { kind: string; children: ReactNode }): ReactNode {
  return <span className={`badge ${kind}`}>{children}</span>;
}

export function timeAgo(timestamp: number): string {
  if (!timestamp) return "—";
  const seconds = Math.max(1, Math.floor((Date.now() - timestamp) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.floor(months / 12)}y ago`;
}

export { formatBytes } from "../lib/format.ts";

export function plural(count: number, one: string, many = `${one}s`): string {
  return `${count.toLocaleString()} ${count === 1 ? one : many}`;
}

export function followHeadingLink(event: { target: EventTarget | null; preventDefault: () => void }): void {
  const anchor = (event.target as HTMLElement | null)?.closest?.("a");
  const href = anchor?.getAttribute("href");
  if (!href || !href.startsWith("#") || href.length < 2) return;
  let slug = href.slice(1);
  try {
    slug = decodeURIComponent(slug);
  } catch {
    return;
  }
  const target = document.getElementById(`user-content-${slug}`) ?? document.getElementById(slug);
  if (!target) return;
  event.preventDefault();
  target.scrollIntoView({ block: "start", behavior: "instant" });
  history.replaceState(history.state, "", `${location.pathname}${location.search}#${encodeURIComponent(slug)}`);
}

export function Markdown({
  source,
  resolveImageUrl,
  resolveReference,
}: {
  source: string;
  resolveImageUrl?: (src: string) => string | null;
  resolveReference?: (raw: string) => string | null;
}): ReactNode {
  return (
    <div className="markdown markdown-body" onClick={followHeadingLink}>
      {renderMarkdown(source, {
        resolveImageUrl,
        resolveReference,
        referenceMode: resolveReference !== undefined,
      })}
    </div>
  );
}

export function useAsync<T>(loader: () => Promise<T>, deps: readonly unknown[]): {
  data: T | null;
  error: string | null;
  loading: boolean;
  reload: () => void;
} {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    loader()
      .then((result) => {
        if (!cancelled) {
          setData(result);
          setError(null);
        }
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : "Request failed");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, nonce]);

  return { data, error, loading, reload: () => setNonce((value) => value + 1) };
}

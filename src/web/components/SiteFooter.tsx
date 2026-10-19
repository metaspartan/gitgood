import { useEffect, useState, type ReactNode } from "react";
import { useSession } from "../App.tsx";
import { Link } from "../router.tsx";

export const SHORTCUTS_EVENT = "gitgood:shortcuts";
let versionPromise: Promise<string | null> | null = null;

function loadVersion(): Promise<string | null> {
  versionPromise ??= fetch("/api/version", { headers: { accept: "application/json" } })
    .then((response) => (response.ok ? response.json() : null))
    .then((body: { version?: string } | null) => (typeof body?.version === "string" ? body.version : null))
    .catch(() => null);
  return versionPromise;
}

export function SiteFooter(): ReactNode {
  const { user } = useSession();
  const [version, setVersion] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    void loadVersion().then((value) => alive && setVersion(value));
    return () => {
      alive = false;
    };
  }, []);

  return (
    <footer className="site-footer">
      <div className="footer-inner">
        <div className="footer-brand">
          <svg viewBox="0 0 28 28" aria-hidden="true" className="footer-mark"><path d="M8 7v14m12-14v3c0 5-12 3-12 8" fill="none" stroke="currentColor" strokeWidth="2" /><circle cx="8" cy="6" r="3" /><circle cx="8" cy="22" r="3" /><circle cx="20" cy="6" r="3" /></svg>
          <span>© {new Date().getFullYear()} GitGood</span>
        </div>
        <nav className="footer-links" aria-label="Footer">
          <Link to="/">Repositories</Link>
          <Link to="/orgs">Organisations</Link>
          {user ? <Link to="/settings">Settings</Link> : <Link to="/login">Sign in</Link>}
          <button type="button" className="footer-link-button" onClick={() => window.dispatchEvent(new Event(SHORTCUTS_EVENT))}>Keyboard shortcuts</button>
          <a href="/api/health">Status</a>
          {user?.is_admin ? <Link to="/admin">Admin</Link> : null}
          {user?.is_admin ? <a href="/api/metrics">Metrics</a> : null}
          <a href="https://github.com/metaspartan/gitgood" target="_blank" rel="noopener noreferrer">Source</a>
        </nav>
        <div className="footer-version" title="GitGood version">{version ? `v${version}` : "\u00a0"}</div>
      </div>
    </footer>
  );
}

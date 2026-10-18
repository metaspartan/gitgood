import { Icon } from "./Icon.tsx";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { Avatar } from "../components.tsx";
import { Link, navigate } from "../router.tsx";
import type { User } from "../types.ts";
import "./TopBar.css";

type Panel = "navigation" | "account" | null;

export function TopBar({ user, onLogout, location, unread }: {
  user: User | null;
  onLogout: () => void;
  location: string;
  unread: number;
}): ReactNode {
  const [query, setQuery] = useState("");
  const [panel, setPanel] = useState<Panel>(null);
  const root = useRef<HTMLElement>(null);
  const menuButton = useRef<HTMLButtonElement>(null);
  const accountButton = useRef<HTMLButtonElement>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const navigationId = useId();
  const accountId = useId();
  const close = () => setPanel(null);
  const links = [
    { to: "/", label: "Repositories", active: location === "/" },
    { to: "/orgs", label: "Organisations", active: /^\/orgs(?:\/|$)/.test(location) },
  ];

  useEffect(close, [location, user?.id]);
  useEffect(() => {
    const media = window.matchMedia("(max-width: 900px)");
    const resize = () => setPanel(null);
    media.addEventListener("change", resize);
    return () => media.removeEventListener("change", resize);
  }, []);
  useEffect(() => {
    const shortcut = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (event.key !== "/" || event.ctrlKey || event.metaKey || event.altKey || target?.isContentEditable || target?.closest("input,textarea,select")) return;
      event.preventDefault();
      setPanel(null);
      searchInput.current?.focus();
    };
    document.addEventListener("keydown", shortcut);
    return () => document.removeEventListener("keydown", shortcut);
  }, []);
  useEffect(() => {
    if (!panel) return;
    const dismiss = (event: PointerEvent) => {
      const target = event.target as Node;
      const trigger = panel === "account" ? accountButton.current : menuButton.current;
      const content = document.getElementById(panel === "account" ? accountId : navigationId);
      if (!content?.contains(target) && !trigger?.contains(target)) setPanel(null);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setPanel(null);
      (panel === "account" ? accountButton : menuButton).current?.focus();
    };
    document.addEventListener("pointerdown", dismiss);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", dismiss);
      document.removeEventListener("keydown", escape);
    };
  }, [panel, accountId, navigationId]);

  const navigation = () => links.map(link => (
    <Link key={link.to} to={link.to} className="header-nav-link" onClick={close}
      {...(link.active ? { ariaCurrent: "page" as const } : {})}>
      <Icon name={link.to === "/" ? "repository" : "people"} />
      {link.label}
    </Link>
  ));

  return (
    <header className="site-header" ref={root} onBlur={event => {
      if (!event.currentTarget.contains(event.relatedTarget as Node | null)) close();
    }}>
      <div className="site-header-inner">
        <Link to="/" className="header-brand" onClick={close} ariaLabel="GitGood home">
          <svg viewBox="0 0 28 28" aria-hidden="true" className="header-mark"><path d="M8 7v14m12-14v3c0 5-12 3-12 8" fill="none" stroke="currentColor" strokeWidth="2" /><circle cx="8" cy="6" r="3" /><circle cx="8" cy="22" r="3" /><circle cx="20" cy="6" r="3" /></svg>
          <span>GitGood</span>
        </Link>
        <nav className="header-desktop-nav" aria-label="Primary">{navigation()}</nav>
        <form className="header-search" role="search" aria-label="Repository search" onSubmit={event => {
          event.preventDefault();
          if (!query.trim()) return;
          close();
          searchInput.current?.blur();
          navigate(`/search?q=${encodeURIComponent(query.trim())}`);
        }}>
          <svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="8" cy="8" r="5.5" /><path d="m12 12 5 5" /></svg>
          <input ref={searchInput} type="search" aria-label="Search" placeholder="Search repositories and issues" value={query} onChange={e => setQuery(e.target.value)} onFocus={close} />
          <kbd aria-hidden="true">/</kbd>
        </form>
        <div className="header-actions">
          {user ? <Link to="/notifications" className="header-notifications" onClick={close} ariaLabel={unread > 0 ? `Notifications, ${unread} unread` : "Notifications"} {...(/^\/notifications(?:\/|$)/.test(location) ? { ariaCurrent: "page" as const } : {})}>
            <Icon name="bell" />
            {unread > 0 ? <span className="header-count" aria-hidden="true">{unread > 99 ? "99+" : unread}</span> : null}
            <span className="header-tooltip" aria-hidden="true">Notifications</span>
          </Link> : null}
          {user ? <div className="header-account">
            <button ref={accountButton} type="button" className="header-account-trigger" aria-expanded={panel === "account"} aria-controls={accountId} aria-label={`Account menu for ${user.username}`} onClick={() => setPanel(panel === "account" ? null : "account")}
              onKeyDown={event => {
                if (event.key === "ArrowDown") { event.preventDefault(); setPanel("account"); requestAnimationFrame(() => root.current?.querySelector<HTMLElement>(".header-account-panel a")?.focus()); }
              }}>
              <Avatar user={user} /><span className="header-username">{user.username}</span><Icon name="chevron" className="header-chevron" />
            </button>
            {panel === "account" ? <div id={accountId} className="header-account-panel" role="region" aria-label="Account">
              <div className="header-identity"><strong>{user.display_name}</strong><span>@{user.username}</span></div>
              <Link to={`/${user.username}`} onClick={close}><Icon name="user" />Your profile</Link>
              <Link to="/settings" onClick={close}><Icon name="settings" />Account settings</Link>
              {user.is_admin ? <><div className="header-menu-label">Administration</div><Link to="/admin" onClick={close}><Icon name="storage" />Admin area</Link><Link to="/admin/users" onClick={close}><Icon name="storage" />Users</Link><Link to="/admin/runners" onClick={close}><Icon name="backup" />Runners</Link></> : null}
              <div className="header-menu-separator" />
              <button type="button" onClick={() => { close(); onLogout(); }}><Icon name="logout" />Sign out</button>
            </div> : null}
          </div> : <Link to="/login" className="header-signin" onClick={close}>Sign in</Link>}
          <button ref={menuButton} type="button" className="header-mobile-toggle" aria-label={panel === "navigation" ? "Close navigation" : "Open navigation"} aria-expanded={panel === "navigation"} aria-controls={navigationId} onClick={() => setPanel(panel === "navigation" ? null : "navigation")}>
            <svg viewBox="0 0 20 20" aria-hidden="true"><path d={panel === "navigation" ? "m5 5 10 10M15 5 5 15" : "M3 5h14M3 10h14M3 15h14"} /></svg>
          </button>
        </div>
        {panel === "navigation" ? <nav id={navigationId} className="header-mobile-nav" aria-label="Primary">{navigation()}</nav> : null}
      </div>
    </header>
  );
}

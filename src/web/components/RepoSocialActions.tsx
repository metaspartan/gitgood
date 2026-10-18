import { useEffect, useState, type ReactNode } from "react";
import { api } from "../api.ts";
import { useSession } from "../App.tsx";
import { useAsync } from "../components.tsx";
import { Link, navigate } from "../router.tsx";
import type { SocialState, WatchLevel } from "../types.ts";
import { usePopover } from "../use-popover.ts";
import { Icon } from "./Icons.tsx";

const WATCH_OPTIONS: { level: WatchLevel; label: string; hint: string }[] = [
  { level: "participating", label: "Participating and @mentions", hint: "Only receive notifications when participating or @mentioned." },
  { level: "all", label: "All Activity", hint: "Notified of all pushes, issues and pull requests." },
  { level: "ignore", label: "Ignore", hint: "Never be notified, not even when @mentioned." },
];

export const SOCIAL_EVENT = "gitgood:social";

export interface SocialEventDetail {
  key: string;
  state: SocialState;
}

const lastSocial = new Map<string, SocialState>();

export function useSocialCounts(owner: string, repo: string): SocialState | null {
  const [state, setState] = useState<SocialState | null>(() => lastSocial.get(`${owner}/${repo}`) ?? null);
  useEffect(() => {
    setState(lastSocial.get(`${owner}/${repo}`) ?? null);
    const onChange = (event: Event): void => {
      const detail = (event as CustomEvent<SocialEventDetail>).detail;
      if (detail.key === `${owner}/${repo}`) setState(detail.state);
    };
    window.addEventListener(SOCIAL_EVENT, onChange);
    return () => window.removeEventListener(SOCIAL_EVENT, onChange);
  }, [owner, repo]);
  return state;
}

export function compactCount(value: number): string {
  if (value < 1000) return String(value);
  if (value < 10_000) return `${(value / 1000).toFixed(1).replace(/\.0$/, "")}k`;
  if (value < 1_000_000) return `${Math.round(value / 1000)}k`;
  return `${(value / 1_000_000).toFixed(1).replace(/\.0$/, "")}m`;
}

export function applyStar(state: SocialState, starring: boolean): SocialState {
  if (state.starring === starring) return state;
  return { ...state, starring, stars: Math.max(0, state.stars + (starring ? 1 : -1)) };
}

export function applyWatchLevel(state: SocialState, level: WatchLevel): SocialState {
  const was = state.watch_level ?? (state.watching ? "all" : "participating");
  const delta = (level === "all" ? 1 : 0) - (was === "all" ? 1 : 0);
  return { ...state, watch_level: level, watching: level === "all", watchers: Math.max(0, (state.watchers ?? 0) + delta) };
}

function watchLabel(level: WatchLevel): string {
  return level === "all" ? "Unwatch" : level === "ignore" ? "Stop ignoring" : "Watch";
}

export function RepoSocialActions({ owner, repo }: { owner: string; repo: string }): ReactNode {
  const { user } = useSession();
  const social = useAsync(() => api.social(owner, repo), [owner, repo]);
  const parent = useAsync(() => api.forkParent(owner, repo), [owner, repo]);
  const [state, setState] = useState<SocialState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [forking, setForking] = useState(false);
  const watchMenu = usePopover<HTMLDivElement>();

  useEffect(() => {
    if (social.data) setState(social.data);
  }, [social.data]);

  useEffect(() => {
    if (!state) return;
    lastSocial.set(`${owner}/${repo}`, state);
    if (lastSocial.size > 20) lastSocial.delete(lastSocial.keys().next().value as string);
    window.dispatchEvent(new CustomEvent<SocialEventDetail>(SOCIAL_EVENT, { detail: { key: `${owner}/${repo}`, state } }));
  }, [state, owner, repo]);

  const current = state ?? social.data;
  const level: WatchLevel = current?.watch_level ?? (current?.watching ? "all" : "participating");

  const requireUser = (): boolean => {
    if (user) return true;
    navigate(`/login?next=${encodeURIComponent(`/${owner}/${repo}`)}`);
    return false;
  };

  const optimistic = async (next: SocialState, send: () => Promise<SocialState | { starred: boolean; stars: number }>): Promise<void> => {
    const previous = current;
    setState(next);
    setError(null);
    try {
      const result = await send();
      if ("starred" in result) setState((value) => (value ? { ...value, starring: result.starred, stars: result.stars } : value));
      else setState(result);
    } catch (cause) {
      setState(previous ?? null);
      setError(cause instanceof Error ? cause.message : "That did not work");
    }
  };

  const toggleStar = (): void => {
    if (!requireUser() || !current) return;
    const starring = !current.starring;
    void optimistic(applyStar(current, starring), () => (starring ? api.star(owner, repo) : api.unstar(owner, repo)));
  };

  const chooseWatch = (next: WatchLevel): void => {
    watchMenu.setOpen(false);
    if (!requireUser() || !current || next === level) return;
    void optimistic(applyWatchLevel(current, next), () => api.setWatchLevel(owner, repo, next));
  };

  const fork = async (): Promise<void> => {
    if (!requireUser()) return;
    setForking(true);
    setError(null);
    try {
      const created = await api.fork(owner, repo);
      navigate(`/${created.owner}/${created.name}`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not fork this repository");
      setForking(false);
    }
  };

  const loading = !current;

  return (
    <div className="repo-actions">
      {parent.data?.parent ? (
        <span className="faint small repo-fork-of">
          forked from <Link to={`/${parent.data.parent.owner}/${parent.data.parent.name}`}>{parent.data.parent.full_name}</Link>
        </span>
      ) : null}
      {error ? <span className="danger small" role="alert">{error}</span> : null}

      <div className="btn-group watch-group" ref={watchMenu.ref}>
        <button
          type="button"
          className={`repo-action${level !== "participating" ? " is-on" : ""}`}
          aria-haspopup="menu"
          aria-expanded={watchMenu.open}
          disabled={loading}
          onClick={() => (user ? watchMenu.setOpen((value) => !value) : requireUser())}
          title={WATCH_OPTIONS.find((option) => option.level === level)?.hint}
        >
          <Icon name={level === "ignore" ? "bellSlash" : "eye"} />
          <span>{watchLabel(level)}</span>
          <span className="repo-action-count">{compactCount(current?.watchers ?? 0)}</span>
          <Icon name="chevron" className="repo-action-caret" />
        </button>
        {watchMenu.open ? (
          <div className="action-menu" role="menu" aria-label="Notification settings">
            <div className="action-menu-title">Notifications</div>
            {WATCH_OPTIONS.map((option) => (
              <button
                key={option.level}
                type="button"
                role="menuitemradio"
                aria-checked={option.level === level}
                className="action-menu-item"
                onClick={() => chooseWatch(option.level)}
              >
                <span className="action-menu-check" aria-hidden="true">{option.level === level ? <Icon name="check" /> : null}</span>
                <span className="action-menu-text">
                  <strong>{option.label}</strong>
                  <span>{option.hint}</span>
                </span>
              </button>
            ))}
            <Link to={`/${owner}/${repo}/watchers`} className="action-menu-footer" onClick={() => watchMenu.setOpen(false)}>
              See all watchers
            </Link>
          </div>
        ) : null}
      </div>

      <div className="btn-group">
        <button type="button" className="repo-action" disabled={forking || loading} onClick={() => void fork()} title="Fork your own copy of this repository">
          <Icon name="fork" />
          <span>{forking ? "Forking\u2026" : "Fork"}</span>
        </button>
        <Link to={`/${owner}/${repo}/forks`} className="repo-action repo-action-counter" ariaLabel={`${current?.forks ?? 0} forks`}>
          {compactCount(current?.forks ?? 0)}
        </Link>
      </div>

      <div className="btn-group">
        <button
          type="button"
          className={`repo-action${current?.starring ? " is-starred" : ""}`}
          aria-pressed={current?.starring ?? false}
          disabled={loading}
          onClick={toggleStar}
          title={current?.starring ? "Unstar this repository" : "Star this repository"}
        >
          <Icon name="star" className={current?.starring ? "is-filled" : ""} />
          <span>{current?.starring ? "Starred" : "Star"}</span>
        </button>
        <Link to={`/${owner}/${repo}/stargazers`} className="repo-action repo-action-counter" ariaLabel={`${current?.stars ?? 0} stargazers`}>
          {compactCount(current?.stars ?? 0)}
        </Link>
      </div>
    </div>
  );
}

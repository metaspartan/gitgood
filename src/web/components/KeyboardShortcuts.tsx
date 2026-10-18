import { Fragment, useEffect, useRef, useState, type ReactNode } from "react";
import { navigate, useLocation } from "../router.tsx";

const RESERVED = new Set(["admin", "login", "new", "notifications", "orgs", "search", "settings", "signup", "explore"]);

export function repoFromPath(path: string): { owner: string; repo: string } | null {
  const [owner, repo] = path.split("?")[0]!.split("/").filter(Boolean);
  if (!owner || !repo || RESERVED.has(owner)) return null;
  return { owner, repo: repo.replace(/\.git$/, "") };
}

export interface ShortcutTarget {
  keys: string;
  label: string;
  to: (repo: { owner: string; repo: string } | null) => string | null;
}

export const GO_SHORTCUTS: ShortcutTarget[] = [
  { keys: "g d", label: "Go to dashboard", to: () => "/" },
  { keys: "g n", label: "Go to notifications", to: () => "/notifications" },
  { keys: "g c", label: "Go to Code", to: (r) => (r ? `/${r.owner}/${r.repo}` : null) },
  { keys: "g i", label: "Go to Issues", to: (r) => (r ? `/${r.owner}/${r.repo}/issues` : null) },
  { keys: "g p", label: "Go to Pull requests", to: (r) => (r ? `/${r.owner}/${r.repo}/pulls` : null) },
  { keys: "g a", label: "Go to Actions", to: (r) => (r ? `/${r.owner}/${r.repo}/actions` : null) },
  { keys: "g m", label: "Go to Milestones", to: (r) => (r ? `/${r.owner}/${r.repo}/milestones` : null) },
  { keys: "g r", label: "Go to Releases", to: (r) => (r ? `/${r.owner}/${r.repo}/releases` : null) },
];

export function resolveSequence(first: string, second: string, path: string): string | null {
  const target = GO_SHORTCUTS.find((shortcut) => shortcut.keys === `${first} ${second}`);
  return target ? target.to(repoFromPath(path)) : null;
}

function isTyping(target: EventTarget | null): boolean {
  const element = target as HTMLElement | null;
  return !!element && (element.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(element.tagName));
}

function Keys({ value }: { value: string }): ReactNode {
  return <>{value.split(" ").map((key, index) => <kbd key={`${key}-${index}`}>{key}</kbd>)}</>;
}

export function KeyboardShortcuts(): ReactNode {
  const location = useLocation();
  const [helpOpen, setHelpOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const pendingRef = useRef(false);
  const pendingTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const locationRef = useRef(location);
  locationRef.current = location;

  useEffect(() => {
    const setWaiting = (value: boolean): void => {
      if (pendingTimer.current) clearTimeout(pendingTimer.current);
      pendingTimer.current = value ? setTimeout(() => setWaiting(false), 1500) : null;
      pendingRef.current = value;
      setPending(value);
    };
    const onKey = (event: KeyboardEvent): void => {
      if (event.ctrlKey || event.metaKey || event.altKey || isTyping(event.target)) return;
      if (event.key === "Escape") {
        setHelpOpen(false);
        setWaiting(false);
        return;
      }
      if (pendingRef.current) {
        setWaiting(false);
        const to = resolveSequence("g", event.key, locationRef.current);
        if (to) {
          event.preventDefault();
          navigate(to);
        }
        return;
      }
      if (event.key === "?") {
        event.preventDefault();
        setHelpOpen((open) => !open);
      } else if (event.key === "g") {
        event.preventDefault();
        setWaiting(true);
      } else if (event.key === "s") {
        const search = document.querySelector<HTMLInputElement>(".header-search input, header input[type='search']");
        if (search) {
          event.preventDefault();
          search.focus();
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      if (pendingTimer.current) clearTimeout(pendingTimer.current);
    };
  }, []);

  const inRepo = repoFromPath(location) !== null;
  const rows = (items: ShortcutTarget[]) =>
    items.map((shortcut) => (
      <Fragment key={shortcut.keys}>
        <dt><Keys value={shortcut.keys} /></dt>
        <dd>{shortcut.label}</dd>
      </Fragment>
    ));

  return (
    <>
      {pending ? <div className="shortcut-pending" role="status"><kbd>g</kbd> then…</div> : null}
      {helpOpen ? (
        <div className="finder-backdrop" onMouseDown={(event) => event.target === event.currentTarget && setHelpOpen(false)}>
          <div className="shortcut-dialog" role="dialog" aria-modal="true" aria-label="Keyboard shortcuts">
            <h2>Keyboard shortcuts</h2>
            <div className="shortcut-groups">
              <section>
                <h3>Site-wide</h3>
                <dl>
                  <dt><kbd>s</kbd><kbd>/</kbd></dt><dd>Focus search</dd>
                  <dt><kbd>?</kbd></dt><dd>Show this help</dd>
                  <dt><kbd>Esc</kbd></dt><dd>Close dialogs and menus</dd>
                  {rows(GO_SHORTCUTS.slice(0, 2))}
                </dl>
              </section>
              <section>
                <h3>{inRepo ? "This repository" : "Inside a repository"}</h3>
                <dl>
                  {rows(GO_SHORTCUTS.slice(2))}
                  <dt><kbd>t</kbd></dt><dd>Go to file</dd>
                </dl>
              </section>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}

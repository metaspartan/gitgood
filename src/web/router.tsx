import { useEffect, useState, type CSSProperties, type MouseEvent, type ReactNode } from "react";

const listeners = new Set<() => void>();

export function navigate(to: string, options: { replace?: boolean } = {}): void {
  if (options.replace) window.history.replaceState(null, "", to);
  else window.history.pushState(null, "", to);
  for (const listener of listeners) listener();
  window.scrollTo({ top: 0 });
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useLocation(): string {
  const [location, setLocation] = useState(`${window.location.pathname}${window.location.search}`);
  useEffect(() => {
    const update = () => setLocation(`${window.location.pathname}${window.location.search}`);
    const unsubscribe = subscribe(update);
    window.addEventListener("popstate", update);
    return () => {
      unsubscribe();
      window.removeEventListener("popstate", update);
    };
  }, []);
  return location;
}

export function Link({
  to,
  children,
  className,
  onClick,
  title,
  style,
  ariaCurrent,
  ariaLabel,
  role,
}: {
  to: string;
  children: ReactNode;
  className?: string;
  onClick?: () => void;
  title?: string;
  style?: CSSProperties;
  ariaCurrent?: "page" | "step" | "location" | "date" | "time" | "true" | "false";
  ariaLabel?: string;
  role?: "menuitem";
}): ReactNode {
  const handleClick = (event: MouseEvent<HTMLAnchorElement>): void => {
    if (event.defaultPrevented || event.button !== 0) return;
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    if (to.startsWith("http")) return;
    event.preventDefault();
    navigate(to);
    onClick?.();
  };
  return (
    <a
      href={to}
      className={className}
      onClick={handleClick}
      title={title}
      style={style}
      {...(ariaCurrent ? { "aria-current": ariaCurrent } : {})}
      {...(ariaLabel ? { "aria-label": ariaLabel } : {})}
      {...(role ? { role } : {})}
    >
      {children}
    </a>
  );
}

export interface ParsedLocation {
  pathname: string;
  search: URLSearchParams;
  segments: string[];
}

export function parseLocation(location: string): ParsedLocation {
  const [pathname = "/", query = ""] = location.split("?");
  return {
    pathname,
    search: new URLSearchParams(query),
    segments: pathname.split("/").filter(Boolean).map(decodeURIComponent),
  };
}

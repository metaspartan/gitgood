import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { Link } from "../router.tsx";

export interface MenuItem {
  label: string;
  to?: string;
  href?: string;
  onSelect?: () => void;
  title?: string;
  disabled?: boolean;
  disabledReason?: string;
}

export interface MenuSeparator {
  separator: true;
}

export type MenuEntry = MenuItem | MenuSeparator;

function isSeparator(entry: MenuEntry): entry is MenuSeparator {
  return "separator" in entry;
}

interface PanelPlacement {
  top: number;
  left: number;
}

export function OverflowMenu({
  label,
  entries,
  align = "right",
  children,
}: {
  label: string;
  entries: readonly MenuEntry[];
  align?: "left" | "right";
  children?: ReactNode;
}): ReactNode {
  const [open, setOpen] = useState(false);
  const [placement, setPlacement] = useState<PanelPlacement | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const menuId = useId();

  const close = useCallback((returnFocus = false) => {
    setOpen(false);
    if (returnFocus) triggerRef.current?.focus();
  }, []);

  useLayoutEffect(() => {
    if (!open) {
      setPlacement(null);
      return;
    }
    const place = (): void => {
      const trigger = triggerRef.current;
      const panel = panelRef.current;
      if (!trigger || !panel) return;
      const anchor = trigger.getBoundingClientRect();
      const height = panel.offsetHeight;
      const width = panel.offsetWidth;
      const gap = 4;
      const viewportPad = 8;
      const below = anchor.bottom + gap;
      const fitsBelow = below + height + viewportPad <= window.innerHeight;
      const top = fitsBelow ? below : Math.max(viewportPad, anchor.top - gap - height);
      const left =
        align === "right"
          ? Math.max(viewportPad, Math.min(anchor.right - width, window.innerWidth - width - viewportPad))
          : Math.max(viewportPad, Math.min(anchor.left, window.innerWidth - width - viewportPad));
      setPlacement({ top, left });
    };
    place();
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    return () => {
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
    };
  }, [open, align, entries.length]);

  useEffect(() => {
    if (!open) return;

    const onPointerDown = (event: MouseEvent): void => {
      const target = event.target as Node | null;
      if (!target) return;
      if (triggerRef.current?.contains(target)) return;
      if (panelRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onKeyDown = (event: globalThis.KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      close(true);
    };

    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown, true);
    };
  }, [open, close]);

  const onPanelKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    const items = Array.from(
      panelRef.current?.querySelectorAll<HTMLElement>("[role='menuitem']:not([aria-disabled='true'])") ?? [],
    );
    if (items.length === 0) return;
    const current = items.indexOf(document.activeElement as HTMLElement);
    const delta = event.key === "ArrowDown" ? 1 : -1;
    const next = current === -1 ? (delta === 1 ? 0 : items.length - 1) : (current + delta + items.length) % items.length;
    items[next]?.focus();
  };

  const trigger = (
    <button
      ref={triggerRef}
      type="button"
      className="ghost small overflow-trigger"
      aria-haspopup="menu"
      aria-expanded={open}
      aria-controls={open ? menuId : undefined}
      aria-label={label}
      title={label}
      onClick={() => setOpen((value) => !value)}
      onKeyDown={(event) => {
        if (event.key !== "ArrowDown") return;
        event.preventDefault();
        setOpen(true);
        requestAnimationFrame(() => {
          panelRef.current?.querySelector<HTMLElement>("[role='menuitem']:not([aria-disabled='true'])")?.focus();
        });
      }}
    >
      {children ?? <span aria-hidden="true">⋯</span>}
    </button>
  );

  return (
    <span className="overflow-root">
      {trigger}
      {open && typeof document !== "undefined"
        ? createPortal(
      <div
        ref={panelRef}
        id={menuId}
        role="menu"
        aria-label={label}
        className={`overflow-panel overflow-panel-${align}`}
        style={{
          top: `${placement?.top ?? 0}px`,
          left: `${placement?.left ?? 0}px`,
          visibility: placement ? "visible" : "hidden",
        }}
        onKeyDown={onPanelKeyDown}
        onClick={(event) => {
          if ((event.target as HTMLElement).closest("[role='menuitem']")) setOpen(false);
        }}
      >
        {entries.map((entry, index) =>
          isSeparator(entry) ? (
            <div key={`sep-${index}`} className="overflow-sep" role="separator" />
          ) : (
            <MenuEntryItem key={entry.label} entry={entry} onChosen={() => setOpen(false)} />
          ),
        )}
      </div>,
            document.body,
          )
        : null}
    </span>
  );
}

function MenuEntryItem({ entry, onChosen }: { entry: MenuItem; onChosen: () => void }): ReactNode {
  const className = "overflow-item";
  const reason = entry.disabled ? entry.disabledReason ?? "Unavailable" : undefined;

  if (entry.disabled) {
    return (
      <button type="button" role="menuitem" className={className} aria-disabled="true" disabled title={reason}>
        {entry.label}
      </button>
    );
  }

  if (entry.to !== undefined) {
    return (
      <Link to={entry.to} role="menuitem" className={className} onClick={onChosen} title={entry.title}>
        {entry.label}
      </Link>
    );
  }

  if (entry.href !== undefined) {
    return (
      <a href={entry.href} role="menuitem" className={className} onClick={onChosen} title={entry.title}>
        {entry.label}
      </a>
    );
  }

  return (
    <button type="button" role="menuitem" className={className} onClick={onChosen} title={entry.title}>
      {entry.label}
    </button>
  );
}

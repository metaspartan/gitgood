import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { escapeHtml } from "../escape.ts";
import { HIGHLIGHT_LIMITS, highlightLines } from "../highlight.ts";
import { lineSelectionHash, parseLineSelection, type LineSelection } from "../line-selection.ts";
import { Switch } from "./Switch.tsx";

export const MAX_RENDERED_LINES = 5000;

const VIRTUALIZE_MIN = 1000;
const OVERSCAN = 150;
const DEFAULT_ROW_HEIGHT = 20;

export interface CodeViewProps {
  code: string;
  language: string | null;
  startLine?: number;
  initialLines?: number;
  wrapByDefault?: boolean;
  showHighlightNotice?: boolean;
  className?: string;
  lineLinks?: boolean;
}

export function CodeView({
  code,
  language,
  startLine = 1,
  initialLines = MAX_RENDERED_LINES,
  wrapByDefault = false,
  showHighlightNotice = true,
  className,
  lineLinks = false,
}: CodeViewProps): ReactNode {
  const [expanded, setExpanded] = useState(false);
  const [wrap, setWrap] = useState(wrapByDefault);

  const highlighted = useMemo(() => highlightLines(code, language), [code, language]);

  const total = highlighted.lines.length;
  const root = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const anchor = useRef<number | null>(null);
  const rowHeightRef = useRef(DEFAULT_ROW_HEIGHT);
  const rafRef = useRef<number | null>(null);
  const [visibleIndex, setVisibleIndex] = useState(0);
  const [selection, setSelection] = useState<LineSelection | null>(null);
  const [copyStatus, setCopyStatus] = useState("");

  const virtualizing = !wrap && total > VIRTUALIZE_MIN;

  useEffect(() => {
    if (!lineLinks) return;
    const update = () => {
      const next = parseLineSelection(window.location.hash, startLine, total);
      setSelection(next);
      anchor.current = next?.start ?? null;
      setCopyStatus("");
    };
    update();
    window.addEventListener("hashchange", update);
    window.addEventListener("popstate", update);
    return () => {
      window.removeEventListener("hashchange", update);
      window.removeEventListener("popstate", update);
    };
  }, [code, startLine, total, lineLinks]);

  useEffect(() => {
    if (!selection) return;
    if (virtualizing) {
      const el = scrollRef.current;
      if (!el) return;
      const rh = rowHeightRef.current;
      const idx = selection.start - startLine;
      el.scrollTop = Math.max(0, idx * rh - el.clientHeight / 2);
    } else {
      root.current?.querySelector(`#L${selection.start}`)?.scrollIntoView({ block: "center" });
    }
  }, [selection, virtualizing, startLine]);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    const first = el?.querySelector<HTMLElement>(".code-line");
    if (first) rowHeightRef.current = first.offsetHeight || DEFAULT_ROW_HEIGHT;
  }, [virtualizing, wrap]);

  useEffect(() => {
    if (!virtualizing) return;
    const el = scrollRef.current;
    if (!el) return;
    const compute = () => {
      const rh = rowHeightRef.current;
      setVisibleIndex(Math.max(0, Math.floor(el.scrollTop / rh)));
    };
    const onScroll = () => {
      if (rafRef.current === null) {
        rafRef.current = requestAnimationFrame(() => {
          rafRef.current = null;
        });
      }
      compute();
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    compute();
    return () => {
      el.removeEventListener("scroll", onScroll);
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    };
  }, [virtualizing, total]);

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(window.location.href);
      setCopyStatus("Link copied");
    } catch {
      setCopyStatus("Copy the link from your address bar");
    }
  };
  const renderLimit = expanded ? total : Math.min(initialLines, MAX_RENDERED_LINES);
  const selectedOutside = selection !== null && selection.end >= startLine + renderLimit;
  const visibleStart = selectedOutside ? Math.max(0, selection.start - startLine - 20) : 0;
  const visibleEnd = Math.min(total, visibleStart + renderLimit);
  const truncatedByViewer = !virtualizing && total > renderLimit;

  let windowStart = visibleStart;
  let windowEnd = visibleEnd;
  let topPad = 0;
  let bottomPad = 0;
  if (virtualizing) {
    const rh = rowHeightRef.current;
    const viewportRows = Math.max(1, Math.ceil((scrollRef.current?.clientHeight ?? 0) / rh));
    windowStart = Math.max(0, visibleIndex - OVERSCAN);
    windowEnd = Math.min(total, visibleIndex + viewportRows + OVERSCAN);
    topPad = windowStart * rh;
    bottomPad = (total - windowEnd) * rh;
  }

  const wrapClass = wrap ? " code-wrap" : "";
  const largeClass = total > 400 ? " code-large" : "";

  return (
    <div ref={root} className={`codeview${className ? ` ${className}` : ""}`}>
      <div className="code-toolbar">
        <span className="faint small">
          {total.toLocaleString()} {total === 1 ? "line" : "lines"}
          {highlighted.language ? ` · ${highlighted.language}` : ""}
        </span>
        <span className="spacer" />
        {lineLinks && selection ? (
          <>
            <span className="small code-selection-label">{lineSelectionHash(selection).slice(1)}</span>
            <button type="button" className="ghost small" onClick={() => void copyLink()}>Copy line link</button>
          </>
        ) : null}
        <Switch
          className="switch-inline"
          label="Wrap lines"
          checked={wrap}
          onChange={setWrap}
        />
      </div>

      {lineLinks ? <div className="code-link-hint small faint">Select a line number to link to it. Shift-click another to select a range.<span role="status">{copyStatus ? ` ${copyStatus}.` : ""}</span></div> : null}
      {showHighlightNotice && !highlighted.highlighted && language ? (
        <div className="code-notice small faint">
          {code.length > HIGHLIGHT_LIMITS.maxBytes || total > HIGHLIGHT_LIMITS.maxLines
            ? `Highlighting skipped for this file (over the ${HIGHLIGHT_LIMITS.maxLines.toLocaleString()}-line / ${(HIGHLIGHT_LIMITS.maxBytes / 1024).toFixed(0)} KiB limit) — showing plain text with line numbers.`
            : "Syntax highlighting is not supported for this file type — showing plain text with line numbers."}
        </div>
      ) : null}

      <div ref={scrollRef} className={`code-scroll${wrapClass}${largeClass}`} role="region" aria-label="File contents" tabIndex={0}>
        <div className="code-body">
          {virtualizing && topPad > 0 ? <div className="code-spacer" style={{ height: topPad }} aria-hidden="true" /> : null}
          {highlighted.lines.slice(windowStart, windowEnd).map((html, index) => {
            const lineNo = startLine + windowStart + index;
            const isSelected = selection !== null && lineNo >= selection.start && lineNo <= selection.end;
            return (
              <div
                className={`code-line${isSelected ? " is-selected" : ""}`}
                id={lineLinks ? `L${lineNo}` : undefined}
                key={windowStart + index}
              >
                {lineLinks ? (
                  <a
                    className="code-ln"
                    href={`#L${lineNo}`}
                    aria-label={`Link to line ${lineNo}`}
                    onClick={(event) => {
                      if (event.metaKey || event.ctrlKey || event.altKey || event.button !== 0) return;
                      event.preventDefault();
                      const line = lineNo;
                      const first = event.shiftKey ? anchor.current ?? line : line;
                      if (!event.shiftKey) anchor.current = line;
                      const next = { start: Math.min(first, line), end: Math.max(first, line) };
                      window.history.pushState(null, "", lineSelectionHash(next));
                      setSelection(next);
                      setCopyStatus("");
                    }}
                  >{lineNo}</a>
                ) : (
                  <span className="code-ln" aria-hidden="true">{lineNo}</span>
                )}
                <span className="code-lc" dangerouslySetInnerHTML={{ __html: html }} />
              </div>
            );
          })}
          {virtualizing && bottomPad > 0 ? <div className="code-spacer" style={{ height: bottomPad }} aria-hidden="true" /> : null}
        </div>
      </div>

      {truncatedByViewer ? (
        <div className="row" style={{ marginTop: 10 }}>
          <button onClick={() => setExpanded(true)}>
            Show all {total.toLocaleString()} lines
          </button>
          <span className="faint small">
            Lines {(visibleStart + 1).toLocaleString()}–{visibleEnd.toLocaleString()} of {total.toLocaleString()} shown — rendering the rest adds
            DOM nodes and may take a moment on a very large file.
          </span>
        </div>
      ) : null}
      {virtualizing ? (
        <p className="faint small" style={{ marginTop: 8 }}>
          Showing a window around your scroll position for responsiveness; use the line numbers to copy ranges.
        </p>
      ) : null}
    </div>
  );
}

export function plainLines(code: string): string[] {
  return code.split("\n").map((line) => escapeHtml(line));
}

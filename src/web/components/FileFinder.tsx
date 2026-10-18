import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { request } from "../api.ts";
import { navigate } from "../router.tsx";
import { Icon } from "./Icons.tsx";

interface FileList {
  sha: string | null;
  total: number;
  truncated: boolean;
  paths: string[];
}

const RESULT_LIMIT = 50;

export function fuzzyScore(path: string, query: string): { score: number; positions: number[] } | null {
  if (!query) return { score: 0, positions: [] };
  const lowerPath = path.toLowerCase();
  const lowerQuery = query.toLowerCase().replace(/\s+/g, "");
  const nameStart = path.lastIndexOf("/") + 1;
  const positions: number[] = [];
  let score = 0;
  let from = 0;
  let previous = -2;
  for (const char of lowerQuery) {
    const index = lowerPath.indexOf(char, from);
    if (index === -1) return null;
    positions.push(index);
    let gain = 1;
    if (index === previous + 1) gain += 5;
    const before = index === 0 ? "/" : lowerPath[index - 1]!;
    if (before === "/" || before === "-" || before === "_" || before === ".") gain += 4;
    if (index >= nameStart) gain += 2;
    score += gain;
    previous = index;
    from = index + 1;
  }
  return { score: score - path.length * 0.01, positions };
}

export function rankPaths(paths: readonly string[], query: string, limit = RESULT_LIMIT): { path: string; positions: number[] }[] {
  if (!query.trim()) return paths.slice(0, limit).map((path) => ({ path, positions: [] }));
  const scored: { path: string; positions: number[]; score: number }[] = [];
  for (const path of paths) {
    const match = fuzzyScore(path, query);
    if (match) scored.push({ path, ...match });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit);
}

function Highlighted({ path, positions }: { path: string; positions: number[] }): ReactNode {
  if (positions.length === 0) return path;
  const marks = new Set(positions);
  const out: ReactNode[] = [];
  let run = "";
  let inMark = false;
  for (let i = 0; i < path.length; i += 1) {
    const marked = marks.has(i);
    if (marked !== inMark && run) {
      out.push(inMark ? <mark key={i}>{run}</mark> : run);
      run = "";
    }
    inMark = marked;
    run += path[i];
  }
  if (run) out.push(inMark ? <mark key="end">{run}</mark> : run);
  return out;
}

export function FileFinder({
  owner,
  repo,
  refName,
  onClose,
}: {
  owner: string;
  repo: string;
  refName: string;
  onClose: () => void;
}): ReactNode {
  const [list, setList] = useState<FileList | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    const controller = new AbortController();
    request<FileList>(`/api/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/files?ref=${encodeURIComponent(refName)}`, {
      signal: controller.signal,
    })
      .then(setList)
      .catch((cause) => {
        if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "Could not load files");
      });
    return () => controller.abort();
  }, [owner, repo, refName]);

  const results = useMemo(() => (list ? rankPaths(list.paths, query) : []), [list, query]);
  useEffect(() => setActive(0), [query]);
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const open = (path: string): void => {
    onClose();
    navigate(`/${owner}/${repo}/blob/${refName}/${path}`);
  };

  return (
    <div className="finder-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div className="finder" role="dialog" aria-modal="true" aria-label="Go to file">
        <div className="finder-input">
          <Icon name="search" />
          <input
            ref={inputRef}
            value={query}
            placeholder="Go to file"
            aria-label="File name"
            aria-controls="finder-results"
            aria-activedescendant={results[active] ? `finder-${active}` : undefined}
            role="combobox"
            aria-expanded="true"
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") onClose();
              else if (event.key === "ArrowDown") {
                event.preventDefault();
                setActive((value) => Math.min(value + 1, Math.max(results.length - 1, 0)));
              } else if (event.key === "ArrowUp") {
                event.preventDefault();
                setActive((value) => Math.max(value - 1, 0));
              } else if (event.key === "Enter" && results[active]) {
                event.preventDefault();
                open(results[active]!.path);
              }
            }}
          />
          <kbd>Esc</kbd>
        </div>
        <ul className="finder-results" id="finder-results" role="listbox" ref={listRef}>
          {error ? <li className="finder-empty">{error}</li> : null}
          {!list && !error ? <li className="finder-empty">Loading files…</li> : null}
          {list && results.length === 0 ? <li className="finder-empty">No files match “{query}”.</li> : null}
          {results.map((result, index) => (
            <li
              key={result.path}
              id={`finder-${index}`}
              data-index={index}
              role="option"
              aria-selected={index === active}
              className={index === active ? "is-active" : ""}
              onMouseEnter={() => setActive(index)}
              onMouseDown={(event) => {
                event.preventDefault();
                open(result.path);
              }}
            >
              <Icon name="file" />
              <span className="finder-path mono">
                <Highlighted path={result.path} positions={result.positions} />
              </span>
            </li>
          ))}
        </ul>
        {list ? (
          <div className="finder-footer small faint">
            {list.total.toLocaleString()} files{list.truncated ? ` · searching the first ${list.paths.length.toLocaleString()}` : ""}
            <span className="spacer" />
            <span><kbd>↑</kbd> <kbd>↓</kbd> to move · <kbd>Enter</kbd> to open</span>
          </div>
        ) : null}
      </div>
    </div>
  );
}

export function useFinderShortcut(onOpen: () => void): void {
  useEffect(() => {
    const handler = (event: KeyboardEvent): void => {
      if (event.key !== "t" || event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))) return;
      event.preventDefault();
      onOpen();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onOpen]);
}

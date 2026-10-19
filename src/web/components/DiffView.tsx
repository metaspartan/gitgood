import { useMemo, useState, type ReactNode } from "react";
import { escapeHtml } from "../escape.ts";
import { highlightLines } from "../highlight.ts";
import { DIFF_FILE_INDEX_THRESHOLD, initialCollapsedFiles } from "../diff-utils.ts";
import { DIFF_FILE_RENDER_WINDOW, diffHunkWindow } from "../diff-view-window.ts";
import { expandBatch, EXPAND_BATCH_SIZE } from "../diff-expand.ts";
import { OverflowMenu, type MenuEntry } from "./OverflowMenu.tsx";
import { ImageDiff, imageDiffSides, isLfsPointerDiff, isPreviewableImage } from "./ImageDiff.tsx";
import { isPreviewableModel, ModelDiff } from "./ModelDiff.tsx";
import { api } from "../api.ts";
import { Link } from "../router.tsx";
import type { DiffFile, DiffLine, DiffResult } from "../types.ts";

const MAX_HIGHLIGHT_LINES = 1500;

interface PreparedFile {
  file: DiffFile;
  highlighted: string[][];
}

function prepareFile(file: DiffFile): PreparedFile {
  const changedCount = file.hunks.reduce((sum, hunk) => sum + hunk.lines.length, 0);
  const canHighlight = file.language !== null && changedCount <= MAX_HIGHLIGHT_LINES;

  if (!canHighlight) {
    return {
      file,
      highlighted: file.hunks.map((hunk) => hunk.lines.map((line) => escapeHtml(line.text))),
    };
  }

  const flat: string[] = [];
  for (const hunk of file.hunks) {
    for (const line of hunk.lines) flat.push(line.text);
  }
  const all = highlightLines(flat.join("\n"), file.language);
  const byIndex = all.lines;

  const highlighted: string[][] = [];
  let cursor = 0;
  for (const hunk of file.hunks) {
    const row: string[] = [];
    for (let i = 0; i < hunk.lines.length; i++) {
      row.push(byIndex[cursor + i] ?? "");
    }
    cursor += hunk.lines.length;
    highlighted.push(row);
  }
  return { file, highlighted };
}

function LineRow({ line, html }: { line: DiffLine; html: string }): ReactNode {
  return (
    <div className={`diff-line diff-${line.kind}`}>
      <span className="diff-num" aria-hidden="true">
        {line.old_line ?? ""}
      </span>
      <span className="diff-num" aria-hidden="true">
        {line.new_line ?? ""}
      </span>
      <span className="diff-sign" aria-hidden="true">
        {line.kind === "add" ? "+" : line.kind === "del" ? "-" : " "}
      </span>
      <span className="diff-text" dangerouslySetInnerHTML={{ __html: html }} />
    </div>
  );
}

export interface DiffContext {
  owner: string;
  repo: string;
  ref: string;
  baseRef?: string | null;
}

const STATUS_LABEL: Record<DiffFile["status"], string> = {
  added: "added",
  modified: "modified",
  deleted: "deleted",
  renamed: "renamed",
};

export function fileMenuEntries(file: DiffFile, context: DiffContext): MenuEntry[] {
  const { owner, repo, ref } = context;
  const path = file.path;
  const exists = file.status !== "deleted";
  const gone = "This file does not exist at this commit.";

  return [
    {
      label: "View file",
      to: `/${owner}/${repo}/blob/${ref}/${path}`,
      title: `Open ${path} at ${ref.slice(0, 8)}`,
      disabled: !exists,
      disabledReason: gone,
    },
    {
      label: "Blame",
      to: `/${owner}/${repo}/blame/${ref}/${path}`,
      title: "See who last touched each line",
      disabled: !exists,
      disabledReason: gone,
    },
    { separator: true },
    { label: "History", to: `/${owner}/${repo}/commits/${ref}/${path}`, title: `Commits touching ${path}` },
    {
      label: "Raw",
      href: api.rawUrl(owner, repo, { ref, path }),
      title: "Open the file contents as served",
      disabled: !exists,
      disabledReason: gone,
    },
  ];
}

function FileMenu({ file, context }: { file: DiffFile; context: DiffContext }): ReactNode {
  return <OverflowMenu label={`Actions for ${file.path}`} entries={fileMenuEntries(file, context)} />;
}

export function DiffView({
  diff,
  emptyLabel = "No changes",
  context,
}: {
  diff: DiffResult;
  emptyLabel?: string;
  context?: DiffContext;
}): ReactNode {
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() =>
    initialCollapsedFiles(
      diff.files,
      (file) => context !== undefined && (isPreviewableImage(file.path) || isPreviewableModel(file.path)),
    ),
  );
  const [focusPath, setFocusPath] = useState<string | null>(null);
  const [windowPages, setWindowPages] = useState<Record<string, number>>({});
  const large = diff.files.length > DIFF_FILE_INDEX_THRESHOLD && collapsed.size === diff.files.length;
  const prepared = useMemo(
    () => diff.files.map((file) => (collapsed.has(file.path) ? { file, highlighted: [] as string[][] } : prepareFile(file))),
    [diff, collapsed],
  );

  if (diff.files.length === 0) {
    return <p className="faint small">{emptyLabel}</p>;
  }

  const [indexFilter, setIndexFilter] = useState("");
  const hasIndex = diff.files.length > DIFF_FILE_INDEX_THRESHOLD;

  const expandPath = (path: string, focus: boolean): void => {
    setCollapsed((current) => {
      const next = new Set(current);
      next.delete(path);
      return next;
    });
    if (focus) setFocusPath(path);
  };

  const expandWindow = (path: string): void => {
    setWindowPages((current) => ({ ...current, [path]: (current[path] ?? 0) + 1 }));
  };

  const toggle = (path: string): void => {
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  return (
    <div className={`diff${hasIndex ? " has-index" : ""}`}>
      <div className="row wrap diff-summary">
        <span className="small diff-summary-text">
          Showing <strong>{diff.files.length.toLocaleString()} changed {diff.files.length === 1 ? "file" : "files"}</strong> with{" "}
          <span className="stat-add">{diff.additions.toLocaleString()} {diff.additions === 1 ? "addition" : "additions"}</span> and{" "}
          <span className="stat-del">{diff.deletions.toLocaleString()} {diff.deletions === 1 ? "deletion" : "deletions"}</span>
        </span>
        <span className="spacer" />
        {large ? (
          <button
            className="ghost small"
            onClick={() => setCollapsed((current) => expandBatch(current, diff.files, EXPAND_BATCH_SIZE))}
            disabled={collapsed.size === 0}
          >
            Expand {Math.min(EXPAND_BATCH_SIZE, collapsed.size)} more files
          </button>
        ) : (
          <button
            className="ghost small"
            onClick={() => setCollapsed(new Set())}
            disabled={collapsed.size === 0}
          >
            Expand all
          </button>
        )}
        <button
          className="ghost small"
          onClick={() => setCollapsed(new Set(diff.files.map((file) => file.path)))}
          disabled={collapsed.size === diff.files.length}
        >
          Collapse all
        </button>
      </div>

      {hasIndex ? (
        <nav className="diff-file-index" aria-label="Changed files">
          <input
            type="search"
            className="diff-index-filter"
            placeholder="Filter files…"
            aria-label="Filter changed files"
            value={indexFilter}
            onChange={(event) => setIndexFilter(event.target.value)}
          />
          <ol>
            {prepared
              .filter(({ file }) => !indexFilter.trim() || file.path.toLowerCase().includes(indexFilter.trim().toLowerCase()))
              .map(({ file }) => {
                const slash = file.path.lastIndexOf("/");
                return (
                  <li key={file.path}>
                    <button
                      type="button"
                      className={`diff-index-link${focusPath === file.path ? " is-current" : ""}`}
                      onClick={() => expandPath(file.path, true)}
                      title={file.path}
                      aria-current={focusPath === file.path ? "true" : undefined}
                    >
                      <span className={`diff-index-status diff-status-${file.status}`} aria-label={STATUS_LABEL[file.status]}>{STATUS_LABEL[file.status].slice(0, 1).toUpperCase()}</span>
                      <span className="diff-index-path">
                        <span className="diff-index-name">{file.path.slice(slash + 1)}</span>
                        {slash > 0 ? <span className="diff-index-dir">{file.path.slice(0, slash)}</span> : null}
                      </span>
                      {file.binary ? null : (
                        <span className="diff-index-stats small">
                          <span className="stat-add">+{file.additions}</span> <span className="stat-del">−{file.deletions}</span>
                        </span>
                      )}
                    </button>
                  </li>
                );
              })}
          </ol>
        </nav>
      ) : null}

      <div className="diff-main">
      {diff.truncated ? (
        <div className="notice-banner small">
          This diff was truncated by the server's size budget. Open the file locally for the complete
          change.
        </div>
      ) : null}

      {prepared.map(({ file, highlighted }, fileIndex) => {
        const isCollapsed = collapsed.has(file.path);
        const isFocused = focusPath === file.path;
        const win = file.hunks.length > 0
          ? diffHunkWindow(file, false, DIFF_FILE_RENDER_WINDOW * ((windowPages[file.path] ?? 0) + 1))
          : null;
        const windowed = win !== null && win.windowed;
        const bodyId = `diff-body-${fileIndex}`;
        const lfsPointer = isLfsPointerDiff(file);
        const richImage =
          context && isPreviewableImage(file.path) ? (
            <ImageDiff
              owner={context.owner}
              repo={context.repo}
              sides={imageDiffSides(file, context.ref, context.baseRef ?? null)}
            />
          ) : context && isPreviewableModel(file.path) ? (
            <ModelDiff
              owner={context.owner}
              repo={context.repo}
              sides={imageDiffSides(file, context.ref, context.baseRef ?? null)}
            />
          ) : null;
        const pathLabel =
          file.old_path && file.status === "renamed" ? `${file.old_path} → ${file.path}` : file.path;
        const toggleLabel = `${isCollapsed ? "Expand" : "Collapse"} ${file.path}`;

        return (
          <div className={`diff-file${isFocused ? " diff-file-focused" : ""}`} key={file.path}>
            <div className="diff-file-head">
              {context ? (
                <>
                  <button
                    type="button"
                    className="diff-file-toggle"
                    onClick={() => toggle(file.path)}
                    aria-expanded={!isCollapsed}
                    aria-controls={bodyId}
                    aria-label={toggleLabel}
                    title={toggleLabel}
                  >
                    <span className="diff-caret" aria-hidden="true">
                      {isCollapsed ? "▸" : "▾"}
                    </span>
                  </button>
                  <Link className="mono diff-path diff-path-link" to={`/${context.owner}/${context.repo}/blob/${context.ref}/${file.path}`} title={pathLabel}>
                    {pathLabel}
                  </Link>
                </>
              ) : (
                <button
                  type="button"
                  className="diff-file-toggle"
                  onClick={() => toggle(file.path)}
                  aria-expanded={!isCollapsed}
                  aria-controls={bodyId}
                >
                  <span className="diff-caret" aria-hidden="true">
                    {isCollapsed ? "▸" : "▾"}
                  </span>
                  <span className="mono diff-path" title={file.path}>
                    {pathLabel}
                  </span>
                </button>
              )}
              <span className="spacer" />
              {lfsPointer ? (
                <span className="badge diff-lfs-badge" title="This file is stored with Git LFS; the preview shows the stored content">
                  LFS
                </span>
              ) : null}
              <span className={`badge diff-status-${file.status}`}>{STATUS_LABEL[file.status]}</span>
              {file.binary ? (
                <span className="faint small">binary</span>
              ) : (
                <>
                  <span className="stat-add small">+{file.additions}</span>
                  <span className="stat-del small">−{file.deletions}</span>
                </>
              )}
              {context ? <FileMenu file={file} context={context} /> : null}
            </div>

            {isCollapsed ? null : file.omitted === "binary" ? (
              richImage ? (
                <div id={bodyId} className="diff-body diff-body-rich">
                  {richImage}
                </div>
              ) : (
                <div id={bodyId} className="diff-body faint small" style={{ padding: "10px 14px" }}>
                  Binary file — not shown. Use the raw download to inspect it.
                </div>
              )
            ) : file.omitted === "too_large" ? (
              <div id={bodyId} className="diff-body faint small" style={{ padding: "10px 14px" }}>
                Diff for this file exceeded the per-file limit and was omitted.
              </div>
            ) : file.hunks.length === 0 ? (
              <div id={bodyId} className="diff-body faint small" style={{ padding: "10px 14px" }}>
                No textual changes (mode or metadata only).
              </div>
            ) : (
              <div id={bodyId} className="diff-body">
                {richImage}
                {(() => {
                  const renderHunks = win
                    ? win.render
                    : file.hunks.map((hunk, sourceIndex) => ({ hunk, sourceIndex, lineLimit: null }));
                  return renderHunks.map(({ hunk, sourceIndex, lineLimit }) => {
                    const lineCount = lineLimit === null ? hunk.lines.length : Math.min(lineLimit, hunk.lines.length);
                    const lines = hunk.lines.slice(0, lineCount);
                    return (
                      <div className="diff-hunk" key={`${hunk.header}-${sourceIndex}`}>
                        <div className="diff-hunk-head mono">{hunk.header}</div>
                        {(highlighted[sourceIndex] ?? []).slice(0, lineCount).map((html, lineIndex) => {
                          const line = lines[lineIndex]!;
                          return <LineRow key={`${sourceIndex}-${lineIndex}`} line={line} html={html} />;
                        })}
                      </div>
                    );
                  });
                })()}
                {windowed ? (
                  <button type="button" className="ghost small diff-expand" onClick={() => expandWindow(file.path)}>
                    Show more lines ({win!.hiddenLines.toLocaleString()} hidden)
                  </button>
                ) : null}
              </div>
            )}
          </div>
        );
      })}
      </div>
    </div>
  );
}

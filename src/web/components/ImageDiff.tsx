import { useState, type ReactNode } from "react";
import { api } from "../api.ts";
import type { DiffFile } from "../types.ts";

const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp", "avif", "bmp", "ico", "svg"]);

export function isPreviewableImage(path: string): boolean {
  const dot = path.lastIndexOf(".");
  if (dot === -1 || dot === path.length - 1) return false;
  return IMAGE_EXTENSIONS.has(path.slice(dot + 1).toLowerCase());
}

export function isLfsPointerDiff(file: DiffFile): boolean {
  if (file.hunks.length === 0) return false;
  let sawOid = false;
  for (const hunk of file.hunks) {
    for (const line of hunk.lines) {
      const text = line.text.trim();
      if (text === "") continue;
      if (text.startsWith("oid sha256:")) {
        sawOid = true;
        continue;
      }
      if (text.startsWith("version https://git-lfs.github.com/spec/") || text.startsWith("size ")) continue;
      return false;
    }
  }
  return sawOid;
}

export interface ImageDiffSides {
  before: { ref: string; path: string } | null;
  after: { ref: string; path: string } | null;
}

export function imageDiffSides(file: DiffFile, ref: string, baseRef: string | null): ImageDiffSides {
  const before =
    file.status === "added" || !baseRef ? null : { ref: baseRef, path: file.old_path ?? file.path };
  const after = file.status === "deleted" ? null : { ref, path: file.path };
  return { before, after };
}

function Pane({
  label,
  tone,
  src,
}: {
  label: string;
  tone: "before" | "after";
  src: string;
}): ReactNode {
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  const [failed, setFailed] = useState(false);
  return (
    <figure className={`image-diff-pane image-diff-${tone}`}>
      <figcaption>
        <span className="image-diff-label">{label}</span>
        {size ? <span className="faint">{`${size.w} \u00d7 ${size.h}`}</span> : null}
      </figcaption>
      <div className="image-diff-frame">
        {failed ? (
          <span className="faint small">Could not load this image.</span>
        ) : (
          <img
            src={src}
            alt={`${label} version`}
            loading="lazy"
            decoding="async"
            onLoad={(event) => setSize({ w: event.currentTarget.naturalWidth, h: event.currentTarget.naturalHeight })}
            onError={() => setFailed(true)}
          />
        )}
      </div>
    </figure>
  );
}

export function ImageDiff({
  owner,
  repo,
  sides,
}: {
  owner: string;
  repo: string;
  sides: ImageDiffSides;
}): ReactNode {
  const [mode, setMode] = useState<"side" | "onion">("side");
  const [mix, setMix] = useState(50);
  const beforeSrc = sides.before ? api.rawUrl(owner, repo, sides.before) : null;
  const afterSrc = sides.after ? api.rawUrl(owner, repo, sides.after) : null;
  const canOnion = beforeSrc !== null && afterSrc !== null;

  return (
    <div className="image-diff">
      {canOnion ? (
        <div className="image-diff-modes" role="group" aria-label="Image comparison mode">
          <button type="button" className="ghost small" aria-pressed={mode === "side"} onClick={() => setMode("side")}>
            2-up
          </button>
          <button type="button" className="ghost small" aria-pressed={mode === "onion"} onClick={() => setMode("onion")}>
            Onion skin
          </button>
        </div>
      ) : null}
      {mode === "onion" && canOnion ? (
        <div className="image-diff-onion">
          <div className="image-diff-frame image-diff-stack">
            <img src={beforeSrc!} alt="Before version" decoding="async" />
            <img src={afterSrc!} alt="After version" decoding="async" style={{ opacity: mix / 100 }} />
          </div>
          <label className="image-diff-slider small">
            <span>Before</span>
            <input
              type="range"
              min={0}
              max={100}
              value={mix}
              onChange={(event) => setMix(Number(event.target.value))}
              aria-label="Blend between before and after"
            />
            <span>After</span>
          </label>
        </div>
      ) : (
        <div className="image-diff-panes">
          {beforeSrc ? <Pane label="Before" tone="before" src={beforeSrc} /> : null}
          {afterSrc ? <Pane label={beforeSrc ? "After" : "Added"} tone="after" src={afterSrc} /> : null}
          {!beforeSrc && !afterSrc ? <span className="faint small">No image on either side of this change.</span> : null}
        </div>
      )}
    </div>
  );
}

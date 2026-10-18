import { useEffect, useState, type ReactNode } from "react";
import { Switch } from "./Switch.tsx";
import { formatBytes } from "../../lib/format.ts";

export interface ImageViewProps {
  src: string;
  alt: string;
  sizeBytes: number;
  path: string;
  downloadHref: string;
  mime: string;
}

export function ImageView({
  src,
  alt,
  sizeBytes,
  path,
  downloadHref,
  mime,
}: ImageViewProps): ReactNode {
  const [dimensions, setDimensions] = useState<{ width: number; height: number } | null>(null);
  const [failed, setFailed] = useState(false);
  const [checkerboard, setCheckerboard] = useState(true);
  const [actualSize, setActualSize] = useState(false);

  useEffect(() => {
    setDimensions(null);
    setFailed(false);
    setActualSize(false);
  }, [src]);

  return (
    <div className="imageview">
      <div className="code-toolbar">
        <span className="faint small mono truncate" title={path}>
          {path}
        </span>
        {dimensions ? (
          <span className="faint small">
            {dimensions.width}×{dimensions.height}
          </span>
        ) : null}
        <span className="faint small">{mime}</span>
        <span className="faint small">{formatBytes(sizeBytes)}</span>
        <span className="spacer" />
        <Switch
          className="switch-inline"
          label="Checkerboard"
          hint="Shows transparency"
          checked={checkerboard}
          onChange={setCheckerboard}
        />
        <Switch
          className="switch-inline"
          label="Actual size"
          hint="Off fits to the pane"
          checked={actualSize}
          onChange={setActualSize}
        />
        <a className="small" href={downloadHref}>
          Download
        </a>
      </div>

      {failed ? (
        <div className="empty">
          <div style={{ fontWeight: 600, color: "var(--text)" }}>This image could not be displayed</div>
          <div className="small">
            The browser does not support the format, or the file is corrupt.{" "}
            <a href={src} target="_blank" rel="noreferrer">
              Open it directly
            </a>
            .
          </div>
        </div>
      ) : (
        <div
          className={`image-stage${checkerboard ? " checker" : ""}${actualSize ? " actual" : ""}`}
        >
          <img
            src={src}
            alt={alt}
            loading="lazy"
            decoding="async"
            onLoad={(event) => {
              const element = event.currentTarget;
              setDimensions({ width: element.naturalWidth, height: element.naturalHeight });
            }}
            onError={() => setFailed(true)}
          />
        </div>
      )}
    </div>
  );
}

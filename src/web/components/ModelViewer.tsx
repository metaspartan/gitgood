import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { formatBytes } from "../components.tsx";
import { MediaViewer, useBoundedFetch } from "./MediaViewer.tsx";
import type { ModelFormat, ModelStats, ModelViewerHandle } from "./model3d.ts";
import { joinRepoPath } from "../repo-path.ts";

const MAX_MODEL_BYTES = 192 * 1024 * 1024;

let rendererModule: Promise<typeof import("./model3d.ts")> | null = null;
function loadRenderer(): Promise<typeof import("./model3d.ts")> {
  rendererModule ??= import("./model3d.ts");
  return rendererModule;
}

export function resolveModelUri(filePath: string, uri: string): string {
  let decoded = uri;
  try {
    decoded = decodeURIComponent(uri);
  } catch {
    decoded = uri;
  }
  const base = decoded.startsWith("/") || !filePath.includes("/") ? "" : filePath.slice(0, filePath.lastIndexOf("/"));
  return joinRepoPath(base, decoded);
}

function siblingRawUrl(src: string, filePath: string, uri: string): string {
  const url = new URL(src, window.location.origin);
  url.searchParams.set("path", resolveModelUri(filePath, uri));
  url.searchParams.delete("download");
  return `${url.pathname}?${url.searchParams.toString()}`;
}

function formatDimension(value: number): string {
  if (!Number.isFinite(value)) return "0";
  if (value === 0) return "0";
  const abs = Math.abs(value);
  return abs >= 100 ? value.toFixed(0) : abs >= 1 ? value.toFixed(2) : value.toPrecision(3);
}

export function ModelViewer({
  src,
  downloadHref,
  path,
  sizeBytes,
  mime,
  compact = false,
}: {
  src: string;
  downloadHref?: string;
  path: string;
  sizeBytes?: number;
  mime?: string;
  compact?: boolean;
}): ReactNode {
  const { bytes, error: fetchError } = useBoundedFetch(src, MAX_MODEL_BYTES);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const frameRef = useRef<HTMLDivElement | null>(null);
  const handleRef = useRef<ModelViewerHandle | null>(null);
  const [stats, setStats] = useState<ModelStats | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [phase, setPhase] = useState<"loading" | "rendering" | "ready">("loading");
  const [wireframe, setWireframe] = useState(false);
  const [autoRotate, setAutoRotate] = useState(false);
  const [ground, setGround] = useState(true);
  const [animation, setAnimation] = useState<number | null>(null);
  const [glMissing, setGlMissing] = useState(false);

  useEffect(() => {
    if (!bytes || !stageRef.current) return;
    let cancelled = false;
    const stage = stageRef.current;
    setPhase("rendering");
    setError(null);
    void (async () => {
      try {
        const mod = await loadRenderer();
        const format: ModelFormat | null = mod.modelFormatFor(path);
        if (!format) throw new Error("This file type has no 3D preview.");
        if (!mod.webglAvailable()) {
          if (!cancelled) setGlMissing(true);
          return;
        }
        const handle = await mod.mountModel(stage, bytes, format, {
          resolveUri: (uri) => siblingRawUrl(src, path, uri),
        });
        if (cancelled) {
          handle.dispose();
          return;
        }
        handleRef.current = handle;
        setStats(handle.stats);
        setPhase("ready");
        if (handle.stats.animations.length > 0) {
          handle.playAnimation(0);
          setAnimation(0);
        }
      } catch (cause) {
        if (!cancelled) setError(cause instanceof Error ? cause.message : "This model could not be rendered.");
      }
    })();
    return () => {
      cancelled = true;
      handleRef.current?.dispose();
      handleRef.current = null;
    };
  }, [bytes, path, src]);

  const toggle = useCallback((setter: (v: boolean) => void, apply: (h: ModelViewerHandle, v: boolean) => void, value: boolean) => {
    setter(value);
    if (handleRef.current) apply(handleRef.current, value);
  }, []);

  const snapshot = (): void => {
    const data = handleRef.current?.snapshot();
    if (!data) return;
    const link = document.createElement("a");
    link.href = data;
    link.download = `${path.split("/").pop()?.replace(/\.[^.]+$/, "") ?? "model"}.png`;
    link.click();
  };

  const fullscreen = (): void => {
    const el = frameRef.current;
    if (!el) return;
    if (document.fullscreenElement) void document.exitFullscreen();
    else void el.requestFullscreen?.();
  };

  const status = fetchError ?? error;
  const loadingLabel = !bytes && !fetchError ? `Downloading model${sizeBytes ? ` (${formatBytes(sizeBytes)})` : ""}…` : phase === "rendering" ? "Preparing preview…" : null;

  return (
    <div className={`media-viewer model-viewer${compact ? " is-compact" : ""}`} ref={frameRef}>
      <div className="model-stage" ref={stageRef}>
        {status ? <div className="model-overlay model-error">{status}</div> : null}
        {glMissing ? (
          <div className="model-overlay model-error">This browser cannot render 3D previews (WebGL is unavailable). Download the file to inspect it.</div>
        ) : null}
        {!status && !glMissing && loadingLabel ? (
          <div className="model-overlay" role="status">
            <span className="model-spinner" aria-hidden="true" />
            <span>{loadingLabel}</span>
          </div>
        ) : null}
        {phase === "ready" ? (
          <div className="model-toolbar" role="toolbar" aria-label="3D view controls">
            <button type="button" className="model-tool" aria-pressed={autoRotate} title="Auto-rotate" onClick={() => toggle(setAutoRotate, (h, v) => h.setAutoRotate(v), !autoRotate)}>
              Rotate
            </button>
            <button type="button" className="model-tool" aria-pressed={wireframe} title="Wireframe" onClick={() => toggle(setWireframe, (h, v) => h.setWireframe(v), !wireframe)}>
              Wireframe
            </button>
            <button type="button" className="model-tool" aria-pressed={ground} title="Ground grid and shadow" onClick={() => toggle(setGround, (h, v) => h.setGround(v), !ground)}>
              Grid
            </button>
            <button type="button" className="model-tool" title="Reset camera" onClick={() => handleRef.current?.resetView()}>
              Reset
            </button>
            {!compact ? (
              <>
                <button type="button" className="model-tool" title="Save a PNG of this view" onClick={snapshot}>
                  Snapshot
                </button>
                <button type="button" className="model-tool" title="Fullscreen" onClick={fullscreen}>
                  Fullscreen
                </button>
              </>
            ) : null}
            {stats && stats.animations.length > 0 ? (
              <select
                className="model-tool model-animation"
                aria-label="Animation"
                value={animation === null ? "" : String(animation)}
                onChange={(event) => {
                  const next = event.target.value === "" ? null : Number(event.target.value);
                  setAnimation(next);
                  handleRef.current?.playAnimation(next);
                }}
              >
                <option value="">No animation</option>
                {stats.animations.map((name, index) => (
                  <option key={`${name}-${index}`} value={index}>
                    {name}
                  </option>
                ))}
              </select>
            ) : null}
          </div>
        ) : null}
        {phase === "ready" && !compact ? <span className="model-hint" aria-hidden="true">Drag to orbit · right-drag to pan · scroll to zoom</span> : null}
      </div>
      {stats && !compact ? (
        <dl className="model-stats">
          <div><dt>Triangles</dt><dd>{stats.triangles.toLocaleString()}</dd></div>
          <div><dt>Vertices</dt><dd>{stats.vertices.toLocaleString()}</dd></div>
          <div><dt>Meshes</dt><dd>{stats.meshes.toLocaleString()}</dd></div>
          <div><dt>Materials</dt><dd>{stats.materials.toLocaleString()}</dd></div>
          <div><dt>Textures</dt><dd>{stats.textures.toLocaleString()}</dd></div>
          {stats.animations.length ? <div><dt>Animations</dt><dd>{stats.animations.length}</dd></div> : null}
          <div style={{ flexGrow: 2, flexBasis: 180 }}><dt>Dimensions</dt><dd className="mono">{stats.size.map(formatDimension).join(" × ")}</dd></div>
          {stats.extensions.length ? (
            <div className="model-stats-wide"><dt>Extensions</dt><dd className="mono">{stats.extensions.join(", ")}</dd></div>
          ) : null}
        </dl>
      ) : null}
      {!compact ? (
        <div className="row small faint model-meta">
          <span className="mono">{path}</span>
          {mime ? <span>{mime}</span> : null}
          {sizeBytes !== undefined ? <span>{formatBytes(sizeBytes)}</span> : null}
          <span className="spacer" />
          {downloadHref ? (
            <a className="small" href={downloadHref}>
              Download
            </a>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export { MediaViewer };

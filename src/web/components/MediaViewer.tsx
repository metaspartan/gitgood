import { readBoundedResponse } from "../bounded-response.ts";
import { useEffect, useState, type ReactNode } from "react";
import { formatBytes } from "../components.tsx";
import { Switch } from "./Switch.tsx";

export interface MediaViewerProps {
  kind: "image" | "audio" | "video";
  src: string;
  downloadHref: string;
  path: string;
  sizeBytes: number;
  mime: string;
}

export function MediaViewer(props: MediaViewerProps): ReactNode {
  const { kind, src, downloadHref, path, sizeBytes, mime } = props;
  return (
    <div className="media-viewer">
      <div className="media-stage">
        {kind === "audio" ? <AudioStage src={src} /> : null}
        {kind === "video" ? <VideoStage src={src} path={path} /> : null}
      </div>
      <div className="row small faint" style={{ marginTop: 10, flexWrap: "wrap" }}>
        <span>{path}</span>
        <span>{mime}</span>
        <span>{formatBytes(sizeBytes)}</span>
        <span className="spacer" />
        <a className="small" href={downloadHref}>
          Download
        </a>
      </div>
    </div>
  );
}

function AudioStage({ src }: { src: string }): ReactNode {
  const [loop, setLoop] = useState(false);
  return (
    <>
      <audio src={src} controls loop={loop} preload="metadata" className="media-audio" />
      <div className="row small" style={{ marginTop: 8 }}>
        <Switch label="Loop" checked={loop} onChange={(next: boolean) => setLoop(next)} />
      </div>
    </>
  );
}

function VideoStage({ src, path }: { src: string; path: string }): ReactNode {
  return <video src={src} controls preload="metadata" className="media-video" aria-label={`Video ${path}`} />;
}

export function useBoundedFetch(src: string, maxBytes: number): {
  bytes: Uint8Array | null;
  error: string | null;
} {
  const [state, setState] = useState<{ bytes: Uint8Array | null; error: string | null }>({ bytes: null, error: null });
  useEffect(() => {
    const controller = new AbortController();
    setState({ bytes: null, error: null });
    void (async () => {
      try {
        const response = await fetch(src, { signal: controller.signal });
        const bytes = await readBoundedResponse(response, maxBytes, controller.signal);
        if (!controller.signal.aborted) setState({ bytes, error: null });
      } catch (cause) {
        if (!controller.signal.aborted) setState({ bytes: null, error: cause instanceof Error ? cause.message : "Could not load the file" });
      }
    })();
    return () => controller.abort();
  }, [src, maxBytes]);
  return state;
}

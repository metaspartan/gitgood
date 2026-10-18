import { useState, type ReactNode } from "react";
import { api } from "../api.ts";
import type { ImageDiffSides } from "./ImageDiff.tsx";
import { ModelViewer } from "./ModelViewer.tsx";

const MODEL_EXTENSIONS = new Set(["glb", "gltf", "obj", "ply", "stl", "3mf"]);

export function isPreviewableModel(path: string): boolean {
  const dot = path.lastIndexOf(".");
  return dot !== -1 && MODEL_EXTENSIONS.has(path.slice(dot + 1).toLowerCase());
}

export function ModelDiff({ owner, repo, sides }: { owner: string; repo: string; sides: ImageDiffSides }): ReactNode {
  const [loaded, setLoaded] = useState(false);
  if (!sides.before && !sides.after) return null;

  if (!loaded) {
    return (
      <div className="model-diff">
        <div className="model-diff-load">
          <span>{sides.before && sides.after ? "3D model changed." : sides.after ? "3D model added." : "3D model removed."}</span>
          <button type="button" className="small" onClick={() => setLoaded(true)}>
            {sides.before && sides.after ? "Compare in 3D" : "Preview in 3D"}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="model-diff">
      <div className="model-diff-panes">
        {sides.before ? (
          <figure className="model-diff-pane model-diff-before">
            <figcaption>Before</figcaption>
            <ModelViewer compact src={api.rawUrl(owner, repo, sides.before)} path={sides.before.path} />
          </figure>
        ) : null}
        {sides.after ? (
          <figure className="model-diff-pane model-diff-after">
            <figcaption>{sides.before ? "After" : "Added"}</figcaption>
            <ModelViewer compact src={api.rawUrl(owner, repo, sides.after)} path={sides.after.path} />
          </figure>
        ) : null}
      </div>
    </div>
  );
}

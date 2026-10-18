import { useEffect, useState, type ReactNode } from "react";
import { api } from "../api.ts";
import { ErrorBanner, Markdown, Notice, Spinner, formatBytes, useAsync } from "../components.tsx";
import { joinRepoPath } from "../repo-path.ts";
import { navigate } from "../router.tsx";

const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;

export function FileEditorPage({
  owner,
  repo,
  mode,
  branch,
  filePath,
}: {
  owner: string;
  repo: string;
  mode: "create" | "edit";
  branch: string;
  filePath?: string;
}): ReactNode {
  const detail = useAsync(() => api.repo(owner, repo), [owner, repo]);
  const existing = useAsync(
    () =>
      mode === "edit" && filePath
        ? api.blob(owner, repo, { ref: branch, path: filePath })
        : Promise.resolve(null),
    [owner, repo, branch, filePath, mode],
  );

  const [path, setPath] = useState(mode === "edit" ? (filePath ?? "") : "");
  const [content, setContent] = useState("");
  const [binary, setBinary] = useState<{ base64: string; bytes: number; objectUrl: string | null } | null>(null);
  const [message, setMessage] = useState("");
  const [preview, setPreview] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (mode === "edit" && existing.data?.content !== null && existing.data?.content !== undefined) {
      setContent(existing.data.content);
    }
  }, [mode, existing.data]);

  const effectiveBranch = branch || detail.data?.default_branch || "main";
  const canSave =
    !saving && path.trim().length > 0 && (mode === "create" ? binary !== null || content.length >= 0 : true);
  const isMarkdown = /\.md$/i.test(path.trim());

  const pickFile = async (file: File): Promise<void> => {
    setError(null);
    if (file.size > MAX_UPLOAD_BYTES) {
      setError(`Files up to ${formatBytes(MAX_UPLOAD_BYTES)} can be uploaded here; larger files belong in git`);
      return;
    }
    const bytes = new Uint8Array(await file.arrayBuffer());
    const hasNul = bytes.includes(0);
    let text: string | null = null;
    if (!hasNul) {
      try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } catch {
        text = null;
      }
    }
    if (text !== null) {
      setBinary(null);
      setContent(text);
    } else {
      let binary = "";
      for (let i = 0; i < bytes.length; i += 0x8000) {
        binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      }
      setBinary({ base64: btoa(binary), bytes: bytes.length, objectUrl: URL.createObjectURL(file) });
      setContent("");
    }
    if (!path.trim()) setPath(file.name);
    if (!message.trim()) setMessage(`Add ${file.name}`);
  };

  const save = async (): Promise<void> => {
    setError(null);
    setSaving(true);
    try {
      const trimmedPath = path.trim().replace(/^\/+/, "");
      await api.saveContents(owner, repo, {
        path: trimmedPath,
        branch: effectiveBranch,
        content: binary ? binary.base64 : content,
        encoding: binary ? "base64" : "utf8",
        message: message.trim() || `${binary ? "Add" : existing.data ? "Update" : "Add"} ${trimmedPath}`,
      });
      navigate(`/${owner}/${repo}/blob/${effectiveBranch}/${trimmedPath}`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save the file");
    } finally {
      setSaving(false);
    }
  };

  if (mode === "edit" && existing.error) {
    return (
      <div className="card">
        <h2>Edit file</h2>
        <ErrorBanner message={existing.error} />
      </div>
    );
  }

  return (
    <div className="card">
      <h2>{mode === "create" ? "New file" : "Edit file"}</h2>
      <p className="muted small">
        Committing to <code>{effectiveBranch}</code> as a normal git commit - webhooks fire and CI runs, exactly like
        a push.
      </p>
      <ErrorBanner message={error ?? (mode === "edit" ? existing.error : null)} />
      {mode === "edit" && existing.loading ? <Spinner label="Loading file" /> : null}

      {mode === "create" ? (
        <>
          <label>
            File path
            <input
              value={path}
              onChange={(event) => setPath(event.target.value)}
              placeholder="docs/screenshot.png"
              aria-label="File path"
            />
          </label>
          <label>
            Upload a file (optional)
            <input type="file" onChange={(event) => void pickFile(event.target.files?.[0] as File)} />
          </label>
          {binary ? (
            <Notice>
              {binary.objectUrl ? (
                <img
                  src={binary.objectUrl}
                  alt="Upload preview"
                  style={{ maxWidth: 240, maxHeight: 180, display: "block", marginBottom: 8 }}
                />
              ) : null}
              Will be committed as binary ({formatBytes(binary.bytes)}); the blob viewer will preview it if it is an
              image.{" "}
              <button type="button" className="linklike" onClick={() => setBinary(null)}>
                Discard and edit as text instead
              </button>
            </Notice>
          ) : null}
        </>
      ) : null}

      {binary === null ? (
        <>
          <div className="row" style={{ marginBottom: 8 }}>
            <span className="spacer" />
            {isMarkdown ? (
              <button type="button" className="ghost small" onClick={() => setPreview((value) => !value)}>
                {preview ? "Back to editing" : "Preview"}
              </button>
            ) : null}
          </div>
          {preview && isMarkdown ? (
            <div className="markdown" style={{ border: "1px solid var(--border)", borderRadius: 8, padding: 16 }}>
              <Markdown
                source={content}
                resolveImageUrl={(src) => {
                  const dir = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
                  const target = joinRepoPath(dir, src);
                  return api.rawUrl(owner, repo, { ref: effectiveBranch, path: target });
                }}
              />
            </div>
          ) : (
            <textarea
              value={content}
              onChange={(event) => setContent(event.target.value)}
              spellCheck={false}
              aria-label="File contents"
              style={{ width: "100%", minHeight: "50vh", fontFamily: "var(--mono)", fontSize: 13 }}
            />
          )}
        </>
      ) : null}

      <label style={{ display: "block", marginTop: 12 }}>
        Commit message
        <input
          value={message}
          onChange={(event) => setMessage(event.target.value)}
          placeholder={`${mode === "create" ? "Add" : "Update"} ${path || "file"}`}
          aria-label="Commit message"
        />
      </label>
      <div className="row" style={{ marginTop: 12 }}>
        <button type="button" className="primary" disabled={!canSave} onClick={() => void save()}>
          {saving ? "Committing…" : "Commit changes"}
        </button>
        <button
          type="button"
          className="ghost"
          onClick={() => navigate(filePath ? `/${owner}/${repo}/blob/${branch}/${filePath}` : `/${owner}/${repo}`)}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

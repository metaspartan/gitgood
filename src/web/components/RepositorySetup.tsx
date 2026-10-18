import { useEffect, useState } from "react";
import { pushInstructions } from "../repository-setup.ts";
import "./RepositorySetup.css";

export function RepositorySetup({ cloneUrl, branch, ready = false }: { cloneUrl: string; branch: string; ready?: boolean }) {
  const [copied, setCopied] = useState<"url" | "commands" | null>(null);
  const [error, setError] = useState("");
  const commands = pushInstructions(cloneUrl, branch);
  useEffect(() => { setCopied(null); setError(""); }, [cloneUrl, branch]);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(null), 2200);
    return () => clearTimeout(timer);
  }, [copied]);
  const copy = async (kind: "url" | "commands") => {
    try {
      await navigator.clipboard.writeText(kind === "url" ? cloneUrl : commands);
      setCopied(kind); setError("");
    } catch { setError("Clipboard unavailable. Select and copy the text below."); }
  };
  return <aside className="repository-setup" aria-label="Repository setup guide">
    <section className="setup-panel">
      <div className="setup-panel-heading"><h3>Clone URL</h3><span className="setup-caption">{ready ? "Ready to use" : "Preview"}</span></div>
      <p>{ready ? "Use this address to clone your repository." : "Your repository address, ready once you create it."}</p>
      <code className="setup-code setup-url">{cloneUrl}</code>
      <button type="button" className="ghost small" onClick={() => void copy("url")}>{copied === "url" ? "Copied" : "Copy URL"}</button>
    </section>
    <section className="setup-panel setup-push">
      <div className="setup-panel-heading"><h3>Push existing code</h3><button type="button" className="ghost small" onClick={() => void copy("commands")}>{copied === "commands" ? "Copied" : "Copy commands"}</button></div>
      <pre className="setup-code">{commands}</pre>
      <p className="setup-caption">For Git Bash, macOS or Linux. Already have an origin? Use <code>git remote set-url origin</code> instead.</p>
    </section>
    <section className="setup-panel">
      <h3>Built in</h3>
      <ul><li>Issues & pull requests</li><li>Git LFS for large binaries</li><li>Search across indexed code</li><li>Releases & downloadable assets</li></ul>
    </section>
    <span className="setup-feedback" role="status">{error || (copied ? (copied === "url" ? "Clone URL copied." : "Push commands copied.") : "")}</span>
  </aside>;
}

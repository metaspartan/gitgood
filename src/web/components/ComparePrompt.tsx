import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import { api } from "../api.ts";
import { Link } from "../router.tsx";
import { useSession } from "../App.tsx";
import { ErrorBanner, Spinner } from "../components.tsx";

export function branchFromTail(tail: string, branches: readonly string[]): string | null {
  const sorted = [...branches].sort((a, b) => b.length - a.length);
  return sorted.find((name) => tail === name || tail.startsWith(`${name}/`)) ?? null;
}

export function ComparePrompt({ owner, repo, currentRef, defaultBranch }: {
  owner: string;
  repo: string;
  currentRef: string;
  defaultBranch: string | null;
}): ReactNode {
  const { user } = useSession();
  const [ahead, setAhead] = useState<number | null>(null);
  const [branch, setBranch] = useState<string | null>(null);
  const defaultName = defaultBranch ?? "main";
  const comparable = user !== null && branch !== null && branch !== defaultName && ahead !== null && ahead > 0;

  useEffect(() => {
    let cancelled = false;
    setAhead(null);
    setBranch(null);
    if (!user || currentRef === defaultName || currentRef.startsWith(`${defaultName}/`)) return;
    void (async () => {
      try {
        const names = (await api.branches(owner, repo)).items.map((item) => item.name);
        const resolved = branchFromTail(currentRef, names);
        if (cancelled || !resolved || resolved === defaultName) return;
        setBranch(resolved);
        const result = await api.compare(owner, repo, defaultName, resolved);
        if (!cancelled) setAhead(result.ahead_by);
      } catch {
        if (!cancelled) setAhead(null);
      }
    })();
    return () => { cancelled = true; };
  }, [owner, repo, currentRef, defaultName, user]);

  if (!comparable) return null;
  return (
    <div className="compare-prompt" role="region" aria-label="Create pull request">
      <span className="compare-copy">
        <strong>{branch}</strong> has {ahead!.toLocaleString()} {ahead === 1 ? "commit" : "commits"} not in{" "}
        <strong>{defaultName}</strong>.
      </span>
      <Link
        to={`/${owner}/${repo}/pulls/new?head=${encodeURIComponent(branch!)}&base=${encodeURIComponent(defaultName)}`}
        className="button-link compare-action"
      >
        Create pull request
      </Link>
    </div>
  );
}

export function NewPullPage({ owner, repo, head, base }: { owner: string; repo: string; head: string | null; base: string | null }): ReactNode {
  const { user } = useSession();
  const branches = useBranches(owner, repo);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [headRef, setHeadRef] = useState(head ?? "");
  const [baseRef, setBaseRef] = useState(base ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!user) {
    return <div className="card"><h2>Sign in required</h2><p>Sign in to open a pull request.</p></div>;
  }

  const ready = headRef !== "" && baseRef !== "" && headRef !== baseRef;

  const submit = async () => {
    setBusy(true); setError(null);
    try {
      const created = await api.createPull(owner, repo, { title, body, head: headRef, base: baseRef });
      window.location.hash = "";
      window.location.assign(`/${owner}/${repo}/pulls/${created.number}`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not open the pull request");
      setBusy(false);
    }
  };

  return (
    <div className="card new-pull-form" aria-label="Create pull request">
      <h2>Open a pull request</h2>
      {ready ? <p className="muted small"><strong>{baseRef}</strong> ← <strong>{headRef}</strong></p> : null}
      <ErrorBanner message={error} />
      {branches.loading ? <Spinner label="Loading branches" /> : (
        <>
          <label htmlFor="pull-base">Base branch</label>
          <select id="pull-base" value={baseRef} onChange={(event) => setBaseRef(event.target.value)}>
            <option value="">Choose the branch to merge into</option>
            {(branches.data?.items ?? []).map((branch) => (
              <option key={branch.name} value={branch.name}>{branch.name}</option>
            ))}
          </select>
          <label htmlFor="pull-head">Head branch</label>
          <select id="pull-head" value={headRef} onChange={(event) => setHeadRef(event.target.value)}>
            <option value="">Choose the branch with your changes</option>
            {(branches.data?.items ?? []).filter((branch) => branch.name !== baseRef).map((branch) => (
              <option key={branch.name} value={branch.name}>{branch.name}</option>
            ))}
          </select>
          {ready ? (
            <>
              <label htmlFor="pull-title">Title</label>
              <input id="pull-title" value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Describe the change" />
              <label htmlFor="pull-body">Description</label>
              <textarea id="pull-body" rows={6} value={body} onChange={(event) => setBody(event.target.value)} placeholder="Explain what this pull request changes (Markdown supported)" />
              <button type="button" className="primary" disabled={busy || !title.trim()} onClick={() => void submit()}>
                {busy ? "Creating…" : "Create pull request"}
              </button>
            </>
          ) : null}
        </>
      )}
    </div>
  );
}

function useBranches(owner: string, repo: string) {
  const [data, setData] = useState<{ items: Array<{ name: string }> } | null>(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let cancelled = false;
    api.branches(owner, repo)
      .then((result) => { if (!cancelled) setData(result); })
      .catch(() => { if (!cancelled) setData({ items: [] }); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [owner, repo]);
  return { data, loading };
}

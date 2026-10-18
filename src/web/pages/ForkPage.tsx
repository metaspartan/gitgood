import { useEffect, useState, type ReactNode } from "react";
import { api } from "../api.ts";
import { useSession } from "../App.tsx";
import { Avatar, ErrorBanner, useAsync } from "../components.tsx";
import { Icon } from "../components/Icons.tsx";
import { Link, navigate } from "../router.tsx";

const NAME_PATTERN = /^[A-Za-z0-9._-]{1,100}$/;

export function forkNameProblem(name: string): string | null {
  if (!name.trim()) return "Repository name is required.";
  if (!NAME_PATTERN.test(name)) return "Use letters, numbers, dots, dashes and underscores only.";
  if (name === "." || name === ".." || name.endsWith(".git")) return "That name is reserved.";
  return null;
}

export function ForkPage({ owner, repo }: { owner: string; repo: string }): ReactNode {
  const { user, loading: sessionLoading } = useSession();
  const source = useAsync(() => api.repo(owner, repo), [owner, repo]);
  const orgs = useAsync(() => (user ? api.myOrgs() : Promise.resolve({ items: [] })), [user?.id]);
  const [target, setTarget] = useState("");
  const [name, setName] = useState(repo);
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (user && !target) setTarget(user.username);
  }, [user, target]);
  useEffect(() => {
    if (source.data) setDescription((value) => value || source.data!.description);
  }, [source.data]);

  useEffect(() => {
    if (!sessionLoading && !user) navigate(`/login?next=${encodeURIComponent(`/${owner}/${repo}/fork`)}`, { replace: true });
  }, [sessionLoading, user, owner, repo]);

  const problem = forkNameProblem(name);
  const owners = [
    ...(user ? [{ value: user.username, label: user.username, hue: user.avatar_hue, display: user.display_name }] : []),
    ...(orgs.data?.items ?? []).map((org) => ({ value: org.name, label: org.name, hue: org.avatar_hue, display: org.display_name })),
  ];
  const selected = owners.find((option) => option.value === target);

  const submit = async (): Promise<void> => {
    if (problem || !user) return;
    setBusy(true);
    setError(null);
    try {
      const created = await api.fork(owner, repo, {
        name: name.trim(),
        description,
        ...(target && target !== user.username ? { organization: target } : {}),
      });
      navigate(`/${created.owner}/${created.name}`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not create the fork");
      setBusy(false);
    }
  };

  return (
    <div className="fork-page">
      <h1 className="fork-title">Create a new fork</h1>
      <p className="muted fork-lede">
        A <em>fork</em> is a copy of a repository. Forking lets you experiment freely without affecting{" "}
        <Link to={`/${owner}/${repo}`}>{owner}/{repo}</Link>.
      </p>
      <ErrorBanner message={error ?? source.error} />
      <form
        className="fork-form"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <div className="fork-row">
          <label className="fork-field">
            <span>Owner <span className="danger">*</span></span>
            <span className="fork-owner">
              {selected ? <Avatar user={{ username: selected.value, display_name: selected.display, avatar_hue: selected.hue }} /> : null}
              <select value={target} onChange={(event) => setTarget(event.target.value)} disabled={owners.length <= 1}>
                {owners.map((option) => (
                  <option key={option.value} value={option.value}>{option.label}</option>
                ))}
              </select>
            </span>
          </label>
          <span className="fork-slash" aria-hidden="true">/</span>
          <label className="fork-field fork-grow">
            <span>Repository name <span className="danger">*</span></span>
            <input value={name} onChange={(event) => setName(event.target.value)} aria-invalid={problem ? true : undefined} autoComplete="off" spellCheck={false} required />
          </label>
        </div>
        {problem ? <p className="small danger" role="alert">{problem}</p> : <p className="small muted">By default, forks are named the same as their upstream repository.</p>}
        <label className="fork-field">
          <span>Description <span className="faint">(optional)</span></span>
          <input value={description} maxLength={2048} onChange={(event) => setDescription(event.target.value)} />
        </label>
        <div className="fork-note small muted">
          <Icon name="branch" /> All branches and tags are copied. Your fork starts with the same history as {owner}/{repo}.
        </div>
        <div className="fork-actions">
          <button type="submit" className="btn-primary" disabled={busy || !!problem || !user}>
            {busy ? "Creating fork\u2026" : "Create fork"}
          </button>
          <Link to={`/${owner}/${repo}`} className="btn-secondary">Cancel</Link>
        </div>
      </form>
    </div>
  );
}

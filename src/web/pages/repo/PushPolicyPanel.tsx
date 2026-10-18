import { parseQuotaInput } from "../../quota-input.ts";
import { useState, useEffect, type ReactNode } from "react";
import { api } from "../../api.ts";
import { ErrorBanner, Spinner, formatBytes, useAsync } from "../../components.tsx";
import { Switch } from "../../components/Switch.tsx";

export function PushPolicyPanel({ owner, repo }: { owner: string; repo: string }): ReactNode {
  const detail = useAsync(() => api.repo(owner, repo), [owner, repo]);
  const quota = useAsync(() => api.quota(owner, repo), [owner, repo]);
  const policy = useAsync(() => api.pushPolicy(owner, repo), [owner, repo]);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [limit, setLimit] = useState("");

  const write = detail.data?.permissions?.write === true;
  const info = quota.data;
  const current = policy.data;

  useEffect(() => {
    if (quota.data?.limit_bytes != null) setLimit(String(quota.data.limit_bytes));
  }, [quota.data]);

  const update = async (input: {
    deny_non_fast_forwards?: boolean;
    deny_deletes?: boolean;
    fsck_objects?: boolean;
  }): Promise<void> => {
    if (!current) return;
    setSaving(true);
    setError(null);
    try {
      await api.setPushPolicy(owner, repo, {
        deny_non_fast_forwards: input.deny_non_fast_forwards ?? current.deny_non_fast_forwards,
        deny_deletes: input.deny_deletes ?? current.deny_deletes,
        fsck_objects: input.fsck_objects ?? current.fsck_objects,
      });
      policy.reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save the policy");
    } finally {
      setSaving(false);
    }
  };

  const saveQuota = async (): Promise<void> => {
    setSaving(true);
    setError(null);
    try {
      const bytes = parseQuotaInput(limit);
      await api.setQuota(owner, repo, bytes);
      quota.reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save the limit");
    } finally {
      setSaving(false);
    }
  };

  const percent = info?.percent_used ?? null;

  return (
    <section className="storage-policy">
      <h3 style={{ marginTop: 0 }}>Storage and push policy</h3>
      <ErrorBanner message={error ?? quota.error ?? policy.error} />

      <div className="storage-policy-layout">
        <div>
          <div className="muted small">Used</div>
          <div style={{ fontSize: 20 }}>{info ? formatBytes(info.used_bytes) : "—"}</div>
          {info?.limit_bytes != null ? (
            <>
              <div className="meter" aria-hidden="true">
                <div
                  className={`meter-fill${info.over_quota ? " over" : ""}`}
                  style={{ width: `${percent ?? 0}%` }}
                />
              </div>
              <div className={`small ${info.over_quota ? "" : "faint"}`}>
                {percent}% of {formatBytes(info.limit_bytes)}
                {info.over_quota ? " — over the limit, pushes are refused" : ""}
              </div>
            </>
          ) : (
            <div className="faint small">{info ? "unlimited" : quota.error ? "Unavailable" : "Loading storage…"}</div>
          )}
        </div>

        <div className="storage-policy-limit">
          <div className="muted small">Limit</div>
          {write ? (
            <div className="row" style={{ gap: 6 }}>
              <input
                value={limit}
                onChange={(event) => setLimit(event.target.value)}
                placeholder="Bytes; empty uses instance default"
                inputMode="numeric"
                aria-label="Storage limit in bytes"
              />
              <button onClick={() => void saveQuota()} disabled={saving || quota.loading || !!quota.error}>
                Save
              </button>
            </div>
          ) : (
            <div className="faint small">
              {info?.limit_bytes != null ? formatBytes(info.limit_bytes) : "unlimited"}
            </div>
          )}
          <div className="faint small" style={{ marginTop: 4 }}>
            In bytes. 0 means unlimited. Empty returns it to the instance default.
          </div>
        </div>
      </div>

      <hr style={{ border: "none", borderTop: "1px solid var(--border)", margin: "18px 0" }} />

      {current ? (
        <div className="stack" style={{ gap: 12 }}>
          <Switch
            label="Refuse history rewrites"
            hint="A force-push that replaces existing commits is rejected. Git enforces this inside receive-pack, before objects are written."
            checked={current.deny_non_fast_forwards}
            disabled={!write || saving}
            onChange={(next: boolean) => void update({ deny_non_fast_forwards: next })}
          />
          <Switch
            label="Refuse branch and tag deletion"
            hint="A push that deletes a ref is rejected."
            checked={current.deny_deletes}
            disabled={!write || saving}
            onChange={(next: boolean) => void update({ deny_deletes: next })}
          />
          <Switch
            label="Validate every received object"
            hint="Each object's hash and connectivity is checked as it arrives. Turning this off trades a broken clone weeks later for a faster initial import."
            checked={current.fsck_objects}
            disabled={!write || saving}
            onChange={(next: boolean) => void update({ fsck_objects: next })}
          />
          <div className="faint small">
            {current.differs_from_default
              ? "This repository differs from the instance defaults."
              : "This repository uses the instance defaults."}
          </div>
        </div>
      ) : (
        <Spinner label="Loading policy" />
      )}
    </section>
  );
}

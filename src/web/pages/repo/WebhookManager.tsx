import { LiveStatus } from "../../components/LiveStatus.tsx";
import { useLive } from "../../use-live.ts";
import { useState, type ReactNode } from "react";
import { api } from "../../api.ts";
import { ErrorBanner, Spinner } from "../../components.tsx";
import { Switch } from "../../components/Switch.tsx";
import type { Webhook } from "../../types.ts";
import { DeliveryList } from "./DeliveryList.tsx";

export function WebhookManager({ owner, repo }: { owner: string; repo: string }): ReactNode {
  const hooks = useLive((signal) => api.webhooks(owner, repo, signal), [owner, repo]);
  const [url, setUrl] = useState("");
  const [secret, setSecret] = useState("");
  const [events, setEvents] = useState<string[]>(["push"]);
  const [error, setError] = useState<string | null>(null);
  const [openDeliveries, setOpenDeliveries] = useState<number | null>(null);

  const availableEvents = hooks.data?.available_events ?? ["push", "issues", "pull_request"];

  const create = async (): Promise<void> => {
    setError(null);
    try {
      await api.createWebhook(owner, repo, { url: url.trim(), ...(secret ? { secret } : {}), events });
      setUrl("");
      setSecret("");
      hooks.reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not create webhook");
    }
  };

  const health = (hook: Webhook): { label: string; tone: string } => {
    if (hook.delivery_count === 0) return { label: "never delivered", tone: "faint" };
    if (hook.last_error) return { label: `error: ${hook.last_error}`, tone: "stat-del" };
    if (hook.last_status !== null && hook.last_status !== undefined && hook.last_status < 400) {
      return { label: `last ${hook.last_status}`, tone: "stat-add" };
    }
    return { label: `last ${hook.last_status ?? "failed"}`, tone: "stat-del" };
  };

  return (
    <>
      <hr style={{ border: "none", borderTop: "1px solid var(--border)", margin: "20px 0" }} />
      <div className="row">
        <h3 style={{ margin: 0 }}>Webhooks</h3>
        <span className="spacer" />
        <LiveStatus {...hooks} />
      </div>
      <p className="muted small">
        Signed with HMAC-SHA256 in <span className="mono">X-Hub-Signature-256</span>, retried three times on
        network errors, 5xx and 429.
      </p>
      <ErrorBanner message={error} />

      <form
        className="stack"
        onSubmit={(event) => {
          event.preventDefault();
          void create();
        }}
      >
        <label>
          Payload URL
          <input
            name="webhook-url"
            value={url}
            onChange={(event) => setUrl(event.target.value)}
            placeholder="https://example.com/hooks/gitgood"
            required
          />
        </label>
        <label>
          Secret (optional)
          <input
            name="webhook-secret"
            value={secret}
            onChange={(event) => setSecret(event.target.value)}
            type="password"
          />
        </label>
        <fieldset className="webhook-events">
          <legend className="small faint">Events to deliver</legend>
          <div className="row wrap" style={{ gap: 16 }}>
            {availableEvents.map((event) => (
              <Switch
                key={event}
                className="switch-inline"
                label={event}
                checked={events.includes(event)}
                onChange={(enabled: boolean) =>
                  setEvents((current) =>
                    enabled ? [...current, event] : current.filter((value) => value !== event),
                  )
                }
              />
            ))}
          </div>
        </fieldset>
        <div className="row">
          <button type="submit" className="primary" disabled={!url.trim() || events.length === 0}>
            Add webhook
          </button>
        </div>
      </form>

      <div style={{ marginTop: 16 }}>
        {hooks.loading && !hooks.data ? (
          <Spinner />
        ) : (hooks.data?.items.length ?? 0) === 0 ? (
          <p className="faint small">No webhooks configured.</p>
        ) : (
          <table className="list">
            <thead>
              <tr>
                <th>URL</th>
                <th>Events</th>
                <th>Health</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {hooks.data?.items.map((hook) => {
                const status = health(hook);
                return (
                  <tr key={hook.id}>
                    <td className="mono small truncate" style={{ maxWidth: 260 }} title={hook.url}>
                      {hook.url}
                    </td>
                    <td className="small faint">{hook.events.join(", ")}</td>
                    <td className={status.tone}>
                      {status.label}
                      {hook.delivery_count ? (
                        <span className="faint"> · {hook.delivery_count} deliveries</span>
                      ) : null}
                    </td>
                    <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                      <button
                        className="ghost small"
                        onClick={() => {
                          const next = openDeliveries === hook.id ? null : hook.id;
                          setOpenDeliveries(next);
                          if (next !== null) hooks.reload();
                        }}
                      >
                        {openDeliveries === hook.id ? "Hide" : "Deliveries"}
                      </button>
                      <button
                        className="danger small"
                        onClick={() => {
                          void api.deleteWebhook(owner, repo, hook.id).then(() => hooks.reload());
                        }}
                      >
                        Remove
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {openDeliveries !== null ? (
        <DeliveryList owner={owner} repo={repo} webhookId={openDeliveries} />
      ) : null}
    </>
  );
}

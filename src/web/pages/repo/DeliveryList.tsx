import { useLive } from "../../use-live.ts";
import type { ReactNode } from "react";
import { api } from "../../api.ts";
import { Spinner, timeAgo } from "../../components.tsx";
import type { WebhookDelivery } from "../../types.ts";

export function DeliveryList({
  owner,
  repo,
  webhookId,
}: {
  owner: string;
  repo: string;
  webhookId: number;
}): ReactNode {
  const deliveries = useLive(() => api.webhookDeliveries(owner, repo, webhookId), [owner, repo, webhookId]);

  if (deliveries.loading) return <Spinner label="Loading deliveries" />;
  if ((deliveries.data?.items.length ?? 0) === 0) {
    return <p className="faint small" style={{ marginTop: "var(--s3)" }}>No deliveries recorded yet.</p>;
  }

  return (
    <table className="list" style={{ marginTop: "var(--s3)" }}>
      <thead>
        <tr>
          <th>Event</th>
          <th>Status</th>
          <th>Attempts</th>
          <th>Duration</th>
          <th>When</th>
        </tr>
      </thead>
      <tbody>
        {deliveries.data?.items.map((delivery: WebhookDelivery) => (
          <tr key={delivery.id}>
            <td className="small">{delivery.event}</td>
            <td className={delivery.status_code && delivery.status_code < 400 ? "stat-add" : "stat-del"}>
              {delivery.status_code ?? "no response"}
              {delivery.error ? <span className="faint small"> ({delivery.error})</span> : null}
            </td>
            <td className="small faint">{delivery.attempts}</td>
            <td className="small faint mono">{delivery.duration_ms} ms</td>
            <td className="small faint">{timeAgo(delivery.created_at)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

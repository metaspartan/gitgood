import { request } from "../api.ts";
import { useLive } from "../use-live.ts";
import { ErrorBanner, formatBytes } from "../components.tsx";
import { LiveStatus } from "./LiveStatus.tsx";
import "./InstanceMetricsPanel.css";
import type { InstanceMetrics } from "../../data/instance-metrics.ts";

export function InstanceMetricsPanel() {
  const state = useLive((signal) => request<InstanceMetrics>("/api/admin/metrics", { signal }), []);
  const data = state.data;
  const groups = data
    ? [
        {
          title: "People and access",
          items: [
            { label: "Users", value: data.users.toLocaleString() },
            { label: "Administrators", value: data.admins.toLocaleString() },
            { label: "Active sessions", value: data.sessions.toLocaleString() },
            { label: "Access tokens", value: data.accessTokens.toLocaleString() },
            { label: "SSH keys", value: data.sshKeys.toLocaleString() },
          ],
        },
        {
          title: "Repositories",
          items: [
            { label: "Repositories", value: data.repos.toLocaleString() },
            { label: "Public", value: data.publicRepos.toLocaleString() },
            { label: "Archived", value: data.archivedRepos.toLocaleString() },
            { label: "Organisations", value: data.orgs.toLocaleString() },
            { label: "Stars", value: data.stars.toLocaleString() },
          ],
        },
        {
          title: "Collaboration",
          items: [
            { label: "Open issues", value: data.openIssues.toLocaleString() },
            { label: "Open pull requests", value: data.openPulls.toLocaleString() },
            { label: "Merged (30 days)", value: data.mergedPulls30d.toLocaleString() },
            { label: "Releases", value: data.releases.toLocaleString() },
            { label: "Notifications", value: data.notifications.toLocaleString() },
          ],
        },
        {
          title: "Automation (24 hours)",
          items: [
            { label: "Workflow jobs run", value: data.ciRuns24h.toLocaleString() },
            { label: "Jobs active now", value: data.ciRunning.toLocaleString() },
            { label: "Jobs failed", value: data.ciFailing24h.toLocaleString() },
            { label: "Webhook deliveries", value: data.webhookDeliveries24h.toLocaleString() },
            { label: "Webhook failures", value: data.webhookFailures24h.toLocaleString() },
          ],
        },
        {
          title: "Content",
          items: [
            { label: "LFS objects", value: data.lfsObjects.toLocaleString() },
            { label: "LFS logical size", value: formatBytes(data.lfsBytes) },
            { label: "Indexed search files", value: data.indexedFiles.toLocaleString() },
            { label: "Webhooks configured", value: data.webhooks.toLocaleString() },
          ],
        },
      ]
    : [];
  return (
    <section className="card" aria-labelledby="instance-metrics-title">
      <div className="card-head">
        <h2 id="instance-metrics-title">Instance activity</h2>
        <LiveStatus {...state} />
      </div>
      <p className="muted small">Counts from the instance database, refreshed while this page is visible. Storage totals are measured separately.</p>
      <ErrorBanner message={state.error} />
      {data ? (
        <div className="metrics-grid">
          {groups.map((group) => (
            <div className="metrics-group" key={group.title}>
              <h3>{group.title}</h3>
              <dl>
                {group.items.map((item) => (
                  <div key={item.label}>
                    <dt>{item.label}</dt>
                    <dd>{item.value}</dd>
                  </div>
                ))}
              </dl>
            </div>
          ))}
        </div>
      ) : (
        <p className="faint small">Loading instance activity…</p>
      )}
    </section>
  );
}

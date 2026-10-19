import { AppearanceSettings } from "../components/AppearanceSettings.tsx";
import { InstanceMetricsPanel } from "../components/InstanceMetricsPanel.tsx";
import { DeploymentGuidance } from "../components/DeploymentGuidance.tsx";
import { StoragePolicy } from "../components/StoragePolicy.tsx";
import { RunnerOverview } from "../components/RunnerOverview.tsx";
import { useSession } from "../App.tsx";
import { api } from "../api.ts";
import { ErrorBanner, Spinner, formatBytes } from "../components.tsx";
import { LiveStatus } from "../components/LiveStatus.tsx";
import { StorageOverview, type StorageOverviewData } from "../components/StorageOverview.tsx";
import { useLive } from "../use-live.ts";
import { Link } from "../router.tsx";

export function ConfigurationPage() {
  const { user } = useSession();
  const state = useLive(signal => user?.is_admin ? api.configuration(signal) : Promise.resolve(null), [user?.id]);
  const storage = useLive(async (signal) => {
    if (!user?.is_admin) return null;
    const response = await fetch("/api/admin/storage", { credentials: "same-origin", signal });
    if (!response.ok) throw new Error("Storage overview is unavailable");
    return await response.json() as StorageOverviewData;
  }, [user?.id]);
  if (!user?.is_admin) return <div className="card"><h2>Administrator access required</h2></div>;
  const configuration = state.data?.configuration;
  return <div className="backup-page">
    <div className="admin-head"><h1 className="admin-title">Configuration</h1><span className="spacer" /><LiveStatus {...storage} /></div>
    <p className="muted admin-lede">Understand your deployment. Review security and capacity before changing limits. Sign-up and repository creation are set in <Link to="/admin/settings">Settings</Link>; backups in <Link to="/admin/backups">Backups</Link>.</p>
    <ErrorBanner message={state.error} />
    <StorageOverview data={storage.data} />
    <AppearanceSettings />
    <InstanceMetricsPanel />
    <RunnerOverview />
    <StoragePolicy />
    {state.loading ? <Spinner label="Loading configuration" /> : null}
    {configuration ? <>
      <DeploymentGuidance secureCookies={configuration.secureCookies} sshConfigured={configuration.sshConfigured} privateWebhooks={configuration.privateWebhooks} />
          <div className="card admin-config"><div className="card-head"><h2>Instance configuration</h2><span className="badge">Read-only · server managed</span></div>
            <p className="muted small">Effective limits and security posture. Most settings are server-managed and require a restart. The default repository quota above is editable and applies immediately.</p>
            <dl className="admin-config-grid">
              {[
                ["Public signups", configuration.signup ? "Enabled" : "Disabled", "Admin → Settings (initial value GITGOOD_ALLOW_SIGNUP)"],
                ["Repository creation", configuration.repositoryCreation ? "Everyone" : "Administrators only", "Admin → Settings (initial value GITGOOD_ALLOW_REPO_CREATION)"],
                ["Secure session cookies", configuration.secureCookies ? "Required" : "Development HTTP", "NODE_ENV / GITGOOD_BASE_URL"],
                ["SSH integration", configuration.sshConfigured ? "Configured · not connection tested" : "Not configured", "GITGOOD_SSH_COMMAND"],
                ["Private webhook destinations", configuration.privateWebhooks ? "Allowed — review network access" : "Blocked by default", "GITGOOD_WEBHOOK_ALLOW_PRIVATE"],
                ["Default repository quota", configuration.maxRepoBytes === 0 ? "Unlimited" : formatBytes(configuration.maxRepoBytes), "Admin storage policy / GITGOOD_MAX_REPO_BYTES"],
                ["LFS object ceiling", formatBytes(configuration.maxLfsBytes), "GITGOOD_MAX_LFS_BYTES"],
                ["JSON request ceiling", formatBytes(configuration.maxBodyBytes), "GITGOOD_MAX_JSON_BODY"],
                ["Concurrent Git processes", String(configuration.gitConcurrency), "GITGOOD_GIT_CONCURRENCY"],
                ["Mutating API rate limit / IP", `${configuration.requestLimit} per ${configuration.requestWindowMs / 1000}s`, "GITGOOD_RATE_MAX / GITGOOD_RATE_WINDOW_MS"],
                ["Code search", `Up to ${configuration.indexFiles.toLocaleString()} files/repo`, "GITGOOD_CODE_INDEX_MAX_FILES"],
                ["Indexed file ceiling", formatBytes(configuration.indexFileBytes), "GITGOOD_CODE_INDEX_MAX_FILE_BYTES"],
              ].map(([name,value,setting]) => <div key={name}><dt>{name}</dt><dd>{value}</dd><details className="config-setting"><summary>Environment setting</summary><code>{setting}</code></details></div>)}
            </dl>
          </div>
    </> : null}
  </div>;
}

import type { ReactNode } from "react";
import { AdminAudit, AdminLayout, AdminOverview, AdminRepositories, AdminRunners, AdminSettings, AdminUsers, adminSectionFor } from "./Admin.tsx";

export function AdminPage({ section, configuration, backups }: { section: string | undefined; configuration: ReactNode; backups: ReactNode }): ReactNode {
  const resolved = adminSectionFor(section);
  if (!resolved) {
    return (
      <div className="card">
        <h2>Not found</h2>
      </div>
    );
  }
  const body =
    resolved === "overview" ? <AdminOverview />
    : resolved === "users" ? <AdminUsers />
    : resolved === "repositories" ? <AdminRepositories />
    : resolved === "runners" ? <AdminRunners />
    : resolved === "settings" ? <AdminSettings />
    : resolved === "audit" ? <AdminAudit />
    : resolved === "configuration" ? configuration
    : backups;
  return <AdminLayout section={resolved}>{body}</AdminLayout>;
}

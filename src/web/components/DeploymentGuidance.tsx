import "./DeploymentGuidance.css";

export function DeploymentGuidance({ secureCookies, sshConfigured, privateWebhooks }: {
  secureCookies: boolean; sshConfigured: boolean; privateWebhooks: boolean;
}) {
  if (secureCookies && sshConfigured && !privateWebhooks) return null;
  return <section className="deployment-guidance" aria-labelledby="deployment-guidance-heading">
    <h2 id="deployment-guidance-heading">Deployment guidance</h2>
    <div className="admin-readiness">
      {!secureCookies ? <div><strong>Development HTTP</strong><p>Use HTTPS and production mode before exposing this instance publicly. Check the public URL and certificate trust before sending credentials.</p></div> : null}
      {!sshConfigured ? <div><strong>Git over SSH is not configured</strong><p>Git over HTTPS is independent and can be used without SSH. To offer SSH clone URLs, configure OpenSSH with GitGood’s forced command and authorized keys. The host’s administrative SSH port alone does not enable Git transport.</p></div> : null}
      {privateWebhooks ? <div><strong>Private-network webhooks allowed</strong><p>Review trusted users and network egress restrictions before enabling webhooks on untrusted repositories.</p></div> : null}
    </div>
  </section>;
}

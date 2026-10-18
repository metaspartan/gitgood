# Cloudflare Tunnel: deployment guidance and limits

The current LAN deployment is not automatically exposed by these instructions. No tunnel, DNS record or public Access policy has been created. Replace `git.example.com` with your chosen hostname before configuring anything.

## Recommended first rollout: private team access

Keep public signup and production CI disabled. Change the bootstrap password, enable available MFA, configure off-host backups and test recovery. Use Cloudflare Access with a restricted identity allowlist for the browser, or use a private VPN/WARP route for both browser and Git. An Access-protected hostname is not transparently compatible with stock Git/LFS: interactive redirects and challenges break clients. Plan noninteractive service-token authentication (both Git and LFS must carry the required headers), or use the private network route instead. Never turn off Access on all paths merely to get a clone working without reviewing the exposure.

A tunnel hides the origin from direct inbound connections; it is not application authorization, a security audit, or a sandbox. Cloudflare terminates public TLS and is in the trust path for repository traffic. Existing LAN access remains possible unless separately restricted by the host firewall.

## Requirements

- A domain/zone managed in your Cloudflare account and a dedicated hostname, such as `git.example.com`.
- A remotely managed Cloudflare Tunnel and a connector on `192.0.2.10`.
- Outbound tunnel connectivity (no router port forwarding). Keep port 22 administrative and do not expose application port 3000.
- A decision on browser Access policy versus unattended Git/LFS authentication.
- A plan whose upload-size limit fits your Git pack and LFS object sizes.

## Docker-origin option for the existing deployment

The existing Compose project is `gitgood`; its internal Docker network is `gitgood_default` and application service is `gitgood:3000`.

1. Create a tunnel in the Cloudflare dashboard under Networking / Tunnels. Use the dashboard-provided connector installation instructions and a protected token/secret file where supported. Do not commit the tunnel token, put it into documentation, or expose it in logs.
2. Run the `cloudflared` connector on the **same** `gitgood_default` Docker network. Pin an appropriate supported image version and configure automatic restart. Do not publish any connector ports or mount the Docker socket.
3. Add a published application route: hostname `git.example.com`, service `http://gitgood:3000`. Do not override the HTTP Host Header to `gitgood` or the LAN IP. The incoming public hostname must reach the app. HTTP here is only the same-host Docker bridge hop; the public connection is HTTPS. If same-host plaintext is outside your threat model, use a properly configured HTTPS origin instead.
4. Add a persistent Compose override outside the source release, such as `/srv/gitgood/domain.yml`:

```yaml
services:
  gitgood:
    environment:
      GITGOOD_BASE_URL: https://git.example.com
      GITGOOD_TRUST_PROXY: "true"
```

5. Recreate the app using both files, and keep using the override on future updates:

```sh
cd /srv/gitgood
docker compose --env-file /srv/gitgood/.env -p gitgood \
  -f compose.production.yml -f /srv/gitgood/domain.yml up -d --wait
```

Do **not** change `GITGOOD_PUBLIC_HOST` to the domain in this Compose file. That variable also controls the existing LAN bind address and Caddy IP certificate; leave it `192.0.2.10`. `GITGOOD_BASE_URL` is the public application origin. Check that the connector supplies the HTTPS forwarded scheme and the correct public host before allowing real use. Only trusted proxies should be on this private network; direct application traffic can spoof forwarded headers.

The existing IP-only Caddy virtual host is not a drop-in public-domain origin. If routing the tunnel to `https://192.0.2.10:8443` instead, configure Caddy to accept the new public hostname and arrange matching origin certificates/Host/SNI. Use `caPool` for a private CA and `originServerName` where appropriate; keep `noTLSVerify: false`. Do not mask Host/certificate mismatches by disabling verification or by overriding Host to the IP, which can generate incorrect Git/LFS URLs.

## Cloudflare rules and large-file limits

- Bypass caching for the entire GitGood hostname initially. Never use a Cache Everything rule for authenticated HTML, `/api/*`, Git smart-HTTP paths, LFS paths or private downloads.
- Browser challenges, redirects and bot checks can break Git, LFS and API clients. Configure rules deliberately; do not bypass application authentication.
- Cloudflare's current documented maximum upload sizes are **100 MB Free/Pro**, **200 MB Business**, and **up to 5 GB Enterprise** (zone settings can be lower). Confirm your actual plan/zone. Requests above the limit fail before reaching GitGood.
- Standard LFS basic uploads send an object in one HTTP request. Do not assume chunked transfer encoding, HTTP streaming, Git LFS or Tunnel bypasses the limit. Git receive-pack uploads can also exceed it.
- Proxy timeouts and long-running transfers remain relevant. For multi-gigabyte repositories/assets, use a private VPN/LAN Git endpoint or a separately secured direct endpoint unless the public proxy plan supports the workload. DNS-only is not a bypass for a tunnel-only private origin.
- Existing IP-origin passkeys may require re-enrollment for the public domain. Test login and recovery before changing the main URL for everyone.

## Acceptance before public use

1. Verify `/api/ready` via the public hostname with normal certificate verification.
2. Log in/out; verify Secure cookies, signup restrictions, MFA and admin authorization.
3. Inspect clone URLs and LFS batch action URLs: all must use the public HTTPS hostname.
4. Use a non-admin, least-privilege account for private and public clone/push/fetch; verify a second unrelated account cannot read private content or downloads.
5. Test branches/tags, an LFS upload/download with a byte hash comparison, and object sizes below/at/above the allowed proxy limit. Test a pack approaching the limit as well.
6. Confirm Cloudflare does not cache authenticated responses, serve cross-user data, or inject interactive challenges into protocol requests.
7. Verify backups off-host and restoration, origin firewall restrictions and log/alert coverage. Keep CI disabled until isolated workers and appropriate trust controls exist.

## Security and compatibility position

Git smart HTTPS and Git LFS have functional end-to-end tests. That is not certification of all Git clients, all proxy combinations, multi-gigabyte transfers or million-file workloads. There has been no complete independent penetration test or proof that the application is bug-free.

GitGood is not 1:1 compatible with GitHub/GitLab: its API and workflow format differ. Full GitHub Actions/marketplace actions, GitLab pipelines, protected-review approval gates, required-check policies, environment approvals, schedules and full enterprise SSO/policy capabilities are not implemented to platform parity. Git-over-SSH has not been enabled in this deployment. The trusted-host CI mode is not a sandbox and must stay off for untrusted contributors.

## Sources

- [Cloudflare upload limits / HTTP 413](https://developers.cloudflare.com/support/troubleshooting/http-status-codes/4xx-client-error/error-413/)
- [Tunnel origin TLS and Host parameters](https://developers.cloudflare.com/tunnel/reference/origin-parameters/)

The limits and origin options above were checked against Cloudflare's documentation during this change. Recheck them before purchasing a plan or enabling public access.

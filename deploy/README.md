# Dedicated LAN deployment

Use `compose.production.yml`, not the development Compose defaults. It runs an unprivileged GitGood container behind a dedicated HTTPS proxy on port 8443, leaving existing services on 80/443 alone. Forwarded headers are trusted only on the dedicated internal Compose network; do not publish the app HTTP port. GitGood has no published HTTP port, no Docker socket, a read-only root filesystem, a writable bounded temporary directory, resource limits and persistent data/backup volumes.

```sh
docker compose --env-file /srv/gitgood/.env -p gitgood -f compose.production.yml up -d --build
```

The operator-only environment file must contain `GITGOOD_PUBLIC_HOST` and a unique `GITGOOD_ADMIN_PASSWORD`. Set permissions to 0600. Do not commit it. The password bootstraps the first admin only; change the account password after initial sign-in. Public signup is disabled. Use a unique administrator password.

Caddy uses a private certificate authority for an IP-address LAN deployment. Export its public root certificate from `/data/caddy/pki/authorities/local/root.crt` in the HTTPS container and install it in client trust stores, or configure Git with `http.sslCAInfo`. Do not disable certificate verification. The CA private key must remain on the host. For Internet use, supply a real DNS name and publicly trusted certificate rather than this LAN configuration.

The local backup volume is on the same physical disk: it is a recovery copy, not off-site disaster protection. Configure a mounted NAS or rclone remote as documented in `DEPLOYMENT.md`; this image does not install rclone. Test restoration and protect the host itself.

## CI execution model

Production defaults to `GITGOOD_CI_MODE=runner`: Actions are enabled for every repository, but the server only queues jobs. Registered runners (Admin → Runners) claim jobs over HTTPS, receive the commit as an archive and run each job in a fresh, resource-limited container on their own host. The GitGood container never executes repository code and never needs the Docker socket.

Run runners on a separate machine or VM from the GitGood host where possible. A runner using the Docker executor has access to its host's Docker daemon, so treat a runner host as trusted infrastructure. Use `--allowed-images` to restrict which images workflows may select.

`trusted-host` mode runs job steps directly on the server and is not a sandbox; reserve it for single-user machines you control. `.gitgood-ci.yml` implements a focused subset of GitHub Actions syntax (`on`, `jobs`, `runs-on`, `steps[].run`); unsupported constructs fail visibly instead of reporting a misleading success.

## Updates and rollback

Deploy versioned source releases. Keep the previous image and source release; back up the database and file stores before upgrades. Do not use `down -v`. Schema changes may make an image-only rollback unsafe: restore a matched data snapshot with the service stopped if necessary. Readiness is `/api/ready`; use container health and a real clone/push/LFS round trip as acceptance checks.

## Capacity

Storage figures in the administration page are sampled, not transactional. Git/LFS logical file lengths differ from filesystem allocated bytes; filesystem availability also reflects other services on the same device. Backups, CI workspaces and other host files are not included in the categorized repository total. Retain sufficient headroom for incoming packs, temporary files, WAL and backup copies. Benchmark the deployment with representative repositories before promising a workload size or performance advantage.



Deployment files: `/srv/gitgood/releases/<commit>/`; private environment:
`/srv/gitgood/.env`; public trust certificate:
`/srv/gitgood/shared/gitgood-root-ca.crt`. Bootstrap username is `admin`.
Retrieve the bootstrap password over SSH from the private environment file, not
container logs. Existing services on ports 80/443 are not changed.

The rollout was exercised with verified TLS from another LAN machine: private
repository masking, token authentication, real push/clone/fetch, branch/tag push,
and SHA-256 equality of an 8.2 MiB Git LFS payload. This is a functional smoke test,
not a multi-gigabyte throughput or million-file capacity benchmark. Separate
ephemeral-container checks run the broader e2e suite, LFS protocol/locking/dedup
checks and CI. Production queues Actions jobs for external runners and never executes them in the server.

For a public domain, see [Cloudflare Tunnel setup and security limits](CLOUDFLARE.md). Do not assume the tunnel removes upload-size limits or makes the app fully GitHub-compatible.


## Actions operator controls

**Admin → Runners** registers runners and shows whether each is online, paused or
busy; **Admin → Overview** shows queued and running jobs. Manual `workflow_dispatch`
and reruns require repository write access. Runners authenticate with a hashed,
revocable `ggr_` token, claim jobs atomically, send heartbeats with their logs, and
jobs whose runner stops reporting for 15 minutes are failed. Removing a runner
revokes its token and fails its running jobs. Never mount the Docker socket into the
GitGood container itself; it belongs only on runner hosts.


## Default repository quota

New installations default to unlimited repository bytes (0). Administrators can
change the default immediately at Administration → Configuration → Default
repository quota. This persists in SQLite and takes precedence over
GITGOOD_MAX_REPO_BYTES; explicit repository overrides remain authoritative.
Blank per-repository quota inherits this default; explicit0 stays unlimited.
The separate LFS per-object limit remains5GiB and is not an aggregate storage
quota. Unlimited does not prevent disk exhaustion; monitor available space.

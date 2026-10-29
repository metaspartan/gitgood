# Running GitGood in production

A runbook for a self-hosted instance: what to put in front of it, how to back it
up, how to know it is healthy, and what to do when it is not.

Everything here is tested by `tests/integration/production.test.ts` where it can
be, and marked as a procedure where it cannot.

---

## 1. Capacity

Measured on one core (see [BENCHMARKS.md](./BENCHMARKS.md) for method and caveats):

| | Value |
| --- | --- |
| Idle RSS | ~39 MiB |
| Peak under load | ~72 MiB |
| Container working set | 12–16 MiB |
| Disk | repositories + LFS objects + a metadata database measured in MiB |

A single vCPU and 512 MiB of RAM serves a small team comfortably. The container
in `docker-compose.yml` is limited to 2 CPUs and 512 MiB; raise those together,
because the server is CPU-bound long before it is memory-bound.

**The one setting worth tuning is `GITGOOD_GIT_CONCURRENCY`** (default 16). It
bounds concurrent `git` subprocesses. Each one can transiently use tens of MiB
while packing, so this is the number that decides whether a clone storm spills
into swap. Set it to roughly the number of cores times two; the gauge
`git_queue_depth` tells you if it is too low (see §5).

---

## 2. TLS and a reverse proxy

GitGood speaks plain HTTP and expects a proxy to terminate TLS. Two things must
be true:

1. `GITGOOD_TRUST_PROXY=true`, so `X-Forwarded-For` and `X-Forwarded-Proto` are
   honoured. Rate limiting keys on the client IP, and HSTS needs to know the
   request arrived over TLS.
2. `GITGOOD_BASE_URL` set to the public HTTPS URL. LFS action URLs are derived
   per request, but this is what appears in clone hints and documentation links.

### nginx

```nginx
server {
    listen 443 ssl http2;
    server_name git.example.com;

    ssl_certificate     /etc/letsencrypt/live/git.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/git.example.com/privkey.pem;

    # Git push bodies are packfiles; the default 1m limit rejects a large push
    # with a 413 that the git client reports as a confusing "RPC failed".
    client_max_body_size 0;

    # A clone streams for minutes. Buffering would defeat that: it forces the
    # proxy to hold the whole packfile before the client sees a byte.
    proxy_request_buffering off;
    proxy_buffering off;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        # Long-clone friendly. Keep this above the largest clone you expect.
        proxy_read_timeout    3600s;
        proxy_send_timeout    3600s;
    }
}
```

`proxy_buffering off` and `client_max_body_size 0` are the two lines people
forget, and both produce failures that look like application bugs.

### Caddy

```
git.example.com {
    reverse_proxy 127.0.0.1:3000 {
        flush_interval -1
    }
    request_body {
        max_size 0
    }
}
```

---

## 3. Backups

The state is three things: the database, the bare repositories, and the LFS
object store. `tools/admin.ts backup` captures all three, and the database is
copied with SQLite's own `VACUUM INTO` so the result is a single consistent file
that needs no `-wal` sidecar. This is safe to run against a live server.

```bash
# Nightly, to a dated directory.
bun tools/admin.ts backup --out /var/backups/gitgood/$(date +%F) --label nightly

# Keep two weeks of them.
bun tools/admin.ts prune --backups /var/backups/gitgood --keep 14

# Prove the backup is usable without touching live state.
bun tools/admin.ts restore --from /var/backups/gitgood/2026-01-31 --dry-run
```

### Verify a backup actually restores

A backup that has never been restored is a hypothesis, so there is a tool whose
only job is to falsify that:

```bash
# Round trip in a throwaway instance: seed data, back it up, delete the live
# state, restore, and assert the data is back. Run this after changing anything
# about how backups are taken.
bun tools/restore-check.ts

# Inspect an existing backup without touching live state or the server: opens
# its database read-only, runs SQLite's integrity check, and lists contents.
bun tools/restore-check.ts --from /var/backups/gitgood/2026-01-31
```

Exit code 0 means the claim was verified. It runs each phase in a *separate
process*, because that is the only way it can run at all: a database that any
live handle still refers to cannot be replaced, and an in-process attempt
produces a silently truncated file rather than an error.

A cron entry:

```cron
17 3 * * *  cd /srv/gitgood && bun tools/admin.ts backup --out /var/backups/gitgood/$(date +\%F) --label nightly >> /var/log/gitgood-backup.log 2>&1
30 3 * * *  cd /srv/gitgood && bun tools/admin.ts prune --backups /var/backups/gitgood --keep 14 >> /var/log/gitgood-backup.log 2>&1
```

### Restoring

```bash
bun tools/admin.ts restore --from /var/backups/gitgood/2026-01-31 --dry-run   # verify first
bun tools/admin.ts restore --from /var/backups/gitgood/2026-01-31 --force
# then restart the service
```

The restore moves the previous state aside (it prints where) rather than deleting
it, so a restore from the wrong backup is recoverable. It refuses to run without
`--force`, and it refuses a backup whose database digest does not match the
manifest.

**Restart, and why.** If the server is still running when you restore, it holds
the database open. The restore writes the new file in place rather than deleting
the old one, which succeeds, but two things remain: the old `-wal` sidecar is
still attached to the path, and SQLite will reapply its frames - which describe
the *previous* database - over the restored file. The CLI reports any sidecar it
could not remove and tells you to restart; the restart is what makes the restored
file authoritative. Restoring against a stopped instance has neither problem, and
that is the path `restore-check` verifies.

**Restore is the only thing that proves a backup.** A backup that has never been
restored is a hypothesis. Test one on a scratch instance after you change
anything about how backups are taken.

### What a backup does not cover

- A backup taken during a push may miss the newest ref. Ref updates are atomic
  renames, so the repository is not corrupt, but the very latest commit can be
  absent. Quiesce writes if that matters to you.
- No off-site copy. Ship the directory to object storage with `rclone`,
  `restic` or `rsync`; the format is plain files for exactly this reason.

---

## 4. systemd

```ini
[Unit]
Description=GitGood
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=gitgood
Group=gitgood
WorkingDirectory=/srv/gitgood
EnvironmentFile=/srv/gitgood/.env
ExecStart=/usr/local/bin/bun src/server.ts
Restart=always
RestartSec=2

# Hardening: the service needs its data directory and nothing else.
NoNewPrivileges=true
PrivateTmp=true
PrivateDevices=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/srv/gitgood/data
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
RestrictSUIDSGID=true
RestrictNamespaces=true
LockPersonality=true
MemoryDenyWriteExecute=false

# Raise if you serve very large clones.
LimitNOFILE=65536

[Install]
WantedBy=multi-user.target
```

`MemoryDenyWriteExecute` must stay `false`: JavaScriptCore needs writable-executable
pages, and enabling it produces a service that dies at startup with an unhelpful
message.

---

## 5. Monitoring

### Endpoints

| Endpoint | Purpose | Expected |
| --- | --- | --- |
| `GET /api/health` | liveness; kills a stuck process | `200` |
| `GET /api/ready` | readiness; removes it from a load balancer | `200`, per-dependency detail |
| `GET /api/metrics` | Prometheus | text |
| `GET /api/stats` | JSON snapshot: counts, cache, process | `200` |

`/api/ready` and `/api/health` are deliberately different. Liveness answers "is
this process able to serve", and a failure means *restart it*. Readiness answers
"can a request succeed right now", checking the database, the three data
directories and `git` itself; a failure means *stop sending traffic*, not
*restart*. Wiring readiness to a restart policy is how a database blip becomes a
restart loop.

### The metrics that matter

| Metric | Why |
| --- | --- |
| `git_queue_depth` | > 0 means clones are queuing. Raise `GITGOOD_GIT_CONCURRENCY`. |
| `git_slots_available` | Hits 0 at saturation; the leading indicator of slow clones. |
| `git_queue_waits_total` | Rate of queueing over time. |
| `git_streams_in_flight` | Live clone/fetch/push streams. |
| `git_streams_timed_out_total` | Non-zero means clients are stalling; check for abuse. |
| `http_request_ms` | p99 latency across all endpoints. |
| `git_log_ms`, `git_diff_ms`, `git_blame_ms` | Where git time goes. |
| `cache.hitRate` (in `/api/stats`) | A collapsing hit rate means writes are invalidating constantly. |

An alert worth having: `git_queue_depth > 0` sustained for five minutes.

### Log ingestion

Logs are JSON lines on stdout, one object per event, so any collector can parse
them without a regex. Errors and warnings go to stderr.

```bash
docker compose logs -f          # or journalctl -u gitgood -f
```

---

## 6. Maintenance

```bash
bun tools/admin.ts status                  # sizes, counts, database integrity
bun tools/admin.ts verify                  # fast: object-graph connectivity only
bun tools/admin.ts verify --full           # deep: reads and checksums every object
bun tools/admin.ts verify --repo owner/name
bun tools/admin.ts gc                      # git gc --auto (safe on a schedule)
bun tools/admin.ts gc --aggressive         # re-deltas everything; hours on a big repo
bun tools/admin.ts prune --sessions        # remove expired sessions
bun tools/admin.ts prune --tokens 90       # remove tokens unused for 90 days
bun tools/admin.ts quota                   # usage vs ceiling; --over lists exceptions
bun tools/admin.ts quota --repo o/r --set 5368709120
bun tools/admin.ts ssh                     # registered keys and the sshd command
bun tools/admin.ts ssh --check /home/git/.ssh/authorized_keys   # drift, non-zero exit
bun tools/admin.ts index                   # rebuild the code search index
bun tools/admin.ts policy                   # receive-side settings that differ from the default
```

`quota --over` and `ssh --check` both exit non-zero when something is wrong, so
they work as cron checks:

```cron
0 6 * * *  cd /srv/gitgood && bun tools/admin.ts quota --over >> /var/log/gitgood-quota.log 2>&1
15 6 * * *  cd /srv/gitgood && bun tools/admin.ts ssh --check /home/git/.ssh/authorized_keys >> /var/log/gitgood-ssh.log 2>&1
```

### Storage ceilings

`GITGOOD_MAX_REPO_BYTES` (2 GiB default) is the instance-wide ceiling. One
repository can override it through `PUT /api/repos/:owner/:name/quota`:
`{"quota_bytes": 5368709120}` sets a limit, `0` means unlimited (the way to
exempt a mirror or a release archive without raising the ceiling for everyone),
and `null` returns it to the instance default.

**A push that would exceed the ceiling is refused with `413` before the pack is
written**, using the request's declared `Content-Length`. That ordering is the
point: once `receive-pack` has run, the objects are on disk and refusing the ref
update would leave them there. A chunked push declares no length; those are
measured *after* the push and the repository is flagged, after which further
pushes are refused with a message saying what to do. The owner is notified once,
not once per attempt.

This bounds growth; it shrinks nothing. To bring a flagged repository back under,
run `bun tools/admin.ts gc --repo owner/name` or raise the ceiling.

### Push policy

Three receive-side settings per repository, defaulted instance-wide:

| Setting | Default | What it does |
| --- | --- | --- |
| `GITGOOD_DENY_NON_FAST_FORWARDS` | `false` | Refuse a push that rewrites an existing branch |
| `GITGOOD_DENY_DELETES` | `false` | Refuse a push that deletes a ref |
| `GITGOOD_FSCK_OBJECTS` | `true` | Validate each received object's hash and connectivity as it arrives |

These map onto git's own `receive.*` settings, which matters: enforcement happens
inside `receive-pack`, so a refused push is refused *before* its objects are
written. Reimplementing the check above git would mean accepting the pack and
then refusing the ref, which leaves the objects on disk.

**Git config is the authority, not a database column.** Nothing caches the policy,
because a cached copy would be a second answer to a question `receive-pack`
already answers from the repository's own config - and a stale one would mean a
push that should have been refused was allowed.

Per repository:

```bash
bun tools/admin.ts policy                       # repositories that differ from the defaults
bun tools/admin.ts policy --repo alice/site     # one repository's effective settings
bun tools/admin.ts policy --repo alice/site --deny-non-fast-forwards on
```

Or `PUT /api/repos/:owner/:name/push-policy` with
`{"deny_non_fast_forwards": true}`. Reads are public for a public repository,
because a contributor should know a force-push will be rejected before they try
one; writes require ownership (or the admin role for an organisation
repository).

Setting `fsckObjects` to `false` is worth understanding before doing it: it is
the check that turns a corrupt object into a rejected push instead of a broken
clone weeks later. The reason to disable it is a very large initial import where
the validation cost is unwelcome; turn it back on afterwards.

### Code search index

The index covers each repository's default branch and is rebuilt on push, bounded
per repository by `GITGOOD_CODE_INDEX_MAX_FILES` (2,000),
`GITGOOD_CODE_INDEX_MAX_FILE_BYTES` (256 KiB) and
`GITGOOD_CODE_INDEX_MAX_TOTAL_BYTES` (32 MiB).

Coverage is reported by `GET /api/search/code/status`. A repository whose index
was truncated still searches, but an empty result from it is not evidence of
absence - the API reports `truncated_index: true` for exactly that reason. Rebuild
one with `bun tools/admin.ts index --repo owner/name`.

A push never fails because indexing failed: the objects are already stored, so an
indexing error is recorded in `code_index_state.last_error` and logged rather than
propagated to the client.

`verify` walks the object graph and reports missing or unreachable objects,
which is the damage a bad push or an interrupted gc actually causes; it reads
object headers only, so it finishes in a second per repository. `--full` reads
and checksums every object instead, which is a strictly deeper check at a much
higher cost - minutes per repository - so it belongs on a monthly schedule rather
than a nightly one.

A monthly `verify --full`, a weekly `verify`, and a weekly `gc` are a reasonable
default. `git gc --auto`
already runs opportunistically as part of git's own housekeeping, so the explicit
command is for the case where you want it to happen now.

---

## 7. SSH access (optional)

GitGood does not implement the SSH protocol. OpenSSH owns the transport,
cryptography and host-key verification; this project owns the authorisation
decision, through a forced command. That split is deliberate - reimplementing an
SSH server to avoid depending on `sshd` means owning key exchange and cipher
selection, which is a lot of security-critical code to reimplement worse.

### What is implemented

- A key registry in the database (`/api/ssh-keys`, and the SSH keys section in
  Settings). Fingerprints are computed the way OpenSSH computes them
  (`SHA256:` + base64 of the SHA-256 over the key blob, padding stripped).
- `tools/ssh-command.ts`, the forced command. It parses
  `SSH_ORIGINAL_COMMAND`, resolves the repository through the same
  `canRead` / `canWrite` gates the HTTP path uses, and execs git.
- `authorized_keys` generated from the registry rather than hand-edited, because
  the failure mode of a hand-edited file is a key that was removed in the UI but
  still works.

### Setup

```bash
# 1. Create a dedicated account. It needs no shell.
sudo useradd -r -m -d /home/git -s /usr/bin/git-shell git

# 2. Generate the file from the registry.
bun tools/admin.ts ssh --authorized-keys /home/git/.ssh/authorized_keys
sudo chown -R git:git /home/git/.ssh
sudo chmod 700 /home/git/.ssh && sudo chmod 600 /home/git/.ssh/authorized_keys

# 3. Allow the environment line, which is how the forced command learns which
#    key authenticated. It is trustworthy exactly because it comes from this
#    file and not from the client.
sudo sh -c 'echo "AcceptEnv GITGOOD_SSH_FINGERPRINT" >> /etc/ssh/sshd_config'
sudo systemctl reload sshd
```

Each line in the generated file carries:

```
command="/usr/local/bin/bun /srv/gitgood/tools/ssh-command.ts",
  environment="GITGOOD_SSH_FINGERPRINT=SHA256:...",restrict,
  no-port-forwarding,no-agent-forwarding,no-X11-forwarding,no-pty,no-user-rc
  ssh-ed25519 AAAA... user@host
```

Those options are the security boundary, not decoration. Without `command=` the
key holder gets a shell on the host; without the port-forwarding denials they get
a proxy into your internal network.

Then:

```bash
git clone git@git.example.com:owner/repo.git
```

### Drift

`authorized_keys` is a copy of the database, so it can go stale. The CLI detects
that:

```bash
bun tools/admin.ts ssh --check /home/git/.ssh/authorized_keys   # non-zero on drift
```

Put it in the same cron as the quota check. Adding or removing a key in the web
UI takes effect on the next regeneration, which is why `--check` is worth
scheduling rather than remembering.

### What to know before promising SSH to anyone

- **SSH access is account-wide, not per-repository.** A key acts with the full
  authority of its owner. Read-only is a *token* concept, not a key concept.
- **The server account must be able to read the databases and repositories** owned
  by the GitGood user, because the forced command opens the database to resolve
  the key. Run it as the same user as the service, or grant that access.
- **`GITGOOD_SSH_COMMAND`** overrides the command written into the file, for the
  case where the script is installed somewhere other than the checkout. If unset,
  the generator writes an absolute path to this deployment's own script.

---

## 8. Security posture

What is built in:

- Argon2id password hashing with OWASP-recommended parameters.
- Only SHA-256 digests of access tokens are stored.
- Session cookies: `HttpOnly`, `SameSite=Lax`, and `Secure` when the instance is
  served over TLS.
- Rate limiting on credential endpoints (30 per window per IP) and on mutations;
  reads are never throttled.
- Markdown is escaped before any construct is expanded, so file content cannot
  inject markup; link schemes are allow-listed.
- A Content-Security-Policy with `script-src 'self'` and no `unsafe-eval`. The
  single relaxation is `style-src 'unsafe-inline'`, needed because React sets
  element styles directly.
- HSTS, but only on requests that actually arrived over TLS - sending it over
  plain HTTP would lock browsers out of the `http://` URL for a year.
- Blob content types are sniffed from magic bytes, never trusted from the
  filename, so a mislabelled upload cannot dictate how it is served.
- Git streams are killed after a wall-clock ceiling, so a stalled clone cannot
  hold a subprocess slot forever.

Operator responsibilities:

- **Close registration** once your accounts exist: `GITGOOD_ALLOW_SIGNUP=false`.
  The first account created is the administrator.
- **Serve over TLS.** GitGood does not terminate TLS itself; every credential in
  a `git push` URL is otherwise in plaintext on the wire.
- **Keep `GITGOOD_TRUST_PROXY` false** unless there is a proxy in front. If it is
  true with nothing in front, a client can spoof its own IP and bypass rate
  limiting.
- Rotate backup media off-site.

Not implemented, and worth knowing before you promise it to anyone: no SSH
transport, no CI/CD, no organisations or teams, no forks or stars, no
notifications, no code search, no 2FA or SSO. The README's Limitations section is
the authoritative list.

---

## 9. Verifying a checkout

Before upgrading or releasing, confirm the checkout is complete. Every automated
check here runs against the working tree, where an ignored file looks exactly
like a tracked one - so none of them can tell you that the repository is missing
something a clone would need. This can:

```bash
git clone . /tmp/fresh
cd /tmp/fresh && bun install --frozen-lockfile && bun run typecheck
```

That is not hypothetical. `.gitignore` once contained a bare `data/`, which git
matches at any depth, and it silently ignored `src/data/` - thirteen files
including the whole data layer. The server ran, the tests passed and the
container built, because the files were in the working tree the whole time.
Thirteen commits shipped without them. The mitigation is in
`tests/unit/tracked-files.test.ts`, which fails if a file under `src/` or
`types/` is untracked or matched by a floating ignore rule.

## 10. Upgrade procedure

```bash
bun tools/admin.ts backup --out /var/backups/gitgood/pre-upgrade-$(date +%F) --label pre-upgrade
git -C /srv/gitgood pull --ff-only
bun install --frozen-lockfile
bun run build:web                 # prebuild the SPA; see BENCHMARKS.md for why
docker compose up -d --build      # or: systemctl restart gitgood
curl -fsS https://git.example.com/api/ready
```

Schema changes are additive and applied at startup (`ALTER TABLE ... ADD COLUMN`
guarded by a column check), so a rollback to the previous build keeps working
against the newer database. A rollback that drops a column does not, which is why
the pre-upgrade backup is step one.

---

## 11. Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| `git push` fails with 413 | Proxy body limit | `client_max_body_size 0` |
| Clone hangs at "Receiving objects" | Proxy buffering the stream | `proxy_buffering off` |
| Clone stalls after minutes | Proxy read timeout | Raise `proxy_read_timeout` |
| Everything slow, `git_queue_depth > 0` | Too few git slots | Raise `GITGOOD_GIT_CONCURRENCY` |
| 401 on a private clone with a valid token | Token lacks `write`/`read` scope | Check scopes in Settings |
| 429 on login | Rate limiter | Wait a window; the limit is per IP |
| `/api/ready` fails on a data directory | Volume not writable by the service user | Check ownership and `ReadWritePaths` |
| Readiness fails at boot, then recovers | Expected: the check writes a probe file per directory | None |


## Backup administration page

Instance administrators manage backups at **Admin area → Backups** (`/admin/backups`):

- **Destinations**: add, edit, test and remove local folders, mounted NAS shares,
  Google Drive (sign in with Google) and rclone remotes. **Test** checks that the
  destination is writable and reports free space.
- **Schedules**: manual, daily or weekly at a chosen hour (UTC). The server checks
  once a minute and runs at most one backup at a time; a run missed while the
  server was down starts once when it comes back.
- **Upload bandwidth**: Google Drive and rclone destinations have a maximum upload
  speed in Mbps (megabits per second, not megabytes). Set it directly, or enter your
  internet connection's upload speed and use **20%**. Zero preserves the unlimited
  behavior of existing destinations. The app does not run a speed test or infer WAN
  speed from the LAN adapter. The saved rate applies to the next backup, not one
  already running. Drive bodies are paced in small slices, including retries; rclone
  uses its bandwidth limit. Protocol overhead is not included in the payload cap.
  New destination forms default to weekly. Existing schedules are not changed by
  upgrading. A slower full backup can take several days; the scheduler never runs
  two backups at the same time.
- **Retention**: keep the latest *N* backups per destination (0 keeps all). After a
  successful run, older copies GitGood made in that destination are deleted, locally
  and on the remote. Failed runs never delete anything.
- **History**: every run is stored in the database with trigger, status, size,
  duration and location, and survives restarts. Runs interrupted by a restart are
  marked failed. Errors shown in the browser never include filesystem paths.

Destinations can also be defined on the server with `GITGOOD_BACKUP_DESTINATIONS`
(JSON on one line). These appear in the admin area marked *Server environment*:
their location is not shown in the browser and only their schedule and retention
can be changed there.

```json
[{"id":"local","name":"Recovery disk","kind":"local","target":"/backups/gitgood"},{"id":"nas","name":"Office NAS","kind":"nas","target":"/mnt/nas/gitgood"},{"id":"offsite","name":"Off-site archive","kind":"rclone","target":"b2:gitgood-backups"}]
```

Paths must be absolute. On Windows use paths such as `D:/Backups/GitGood` or a UNC
share. NAS paths must already exist; mount SMB/NFS with the operating system and give
the service account write access. An existing directory does not prove a NAS is
mounted, so use **Test**. Container deployments must bind-mount the destination.
Destinations and staging must be outside GitGood's data, repository and LFS
directories, including symlink targets; the worker refuses them.

### Google Drive

Google Drive backups need no extra software. In **Admin → Backups → Google Drive**:

1. **One-time OAuth client.** In Google Cloud Console enable the *Google Drive API*,
   configure the *Google Auth Platform* consent screen (add your account as a test user
   or publish the app), and create an OAuth client of type **TVs and Limited Input
   devices**. Paste its client ID and secret into the admin page, or set
   `GITGOOD_GOOGLE_CLIENT_ID` and `GITGOOD_GOOGLE_CLIENT_SECRET`. The admin page
   links to each console screen.
2. **Sign in with Google.** Click the button, open `google.com/device`, enter the code
   shown and pick the account. GitGood never sees the Google password. The link uses
   Google's device flow, so it works on LAN and HTTP-only installs without a public
   redirect URL.
3. **Add a Google Drive destination**, choosing the account and a folder name in My
   Drive (created if missing). **Test** reports the account and free space.

GitGood requests only the `drive.file` scope: it can see and delete files it created,
nothing else in the Drive. Each run snapshots locally to `GITGOOD_BACKUP_STAGING`
(default `./backups`; needs room for one full copy), streams a single `.tar` archive to
Drive with a resumable upload (8 MiB chunks, automatic retries, token refresh), checks
the size and MD5 that Google reports, and removes the staging copy. Retention deletes
older archives from Drive. Disconnecting an account revokes GitGood's access; files
already uploaded stay in Drive.

The OAuth client secret and refresh tokens are stored encrypted (AES-256-GCM) with a key
from `GITGOOD_SECRET_KEY`, or a random key generated at `<data dir>/secret.key` on first
use. Back that key up separately: database backups alone cannot decrypt the Google
credentials, which is intentional. If the key is lost, sign in with Google again.

### Other cloud storage (rclone)

For S3, Backblaze B2, SFTP and anything else rclone supports, choose **rclone remote
(advanced)**. Install rclone in the server runtime (not in the stock image), configure the
remote with `rclone config` under the service identity, and use `remote:path` as the
target. `RCLONE_CONFIG` and `GITGOOD_RCLONE_BIN` are honoured. Each run is staged
locally, then `rclone copy` and `rclone check` run with a one-hour deadline each; failures
keep the local copy. Existing destinations that used a `drive:` rclone remote keep
working as rclone destinations.

To configure an environment destination's rate, use `upload_bytes_per_second`
(an integer, 0 for unlimited). Admin changes to its rate, schedule and retention
are saved in the database. Decimal Mbps are converted with `Mbps × 125,000`.
For example, 5 Mbps is 625,000 bytes/s; a 30 Mbps WAN uplink at 20% is 6 Mbps.

Backups are not encrypted by GitGood; use disk encryption or an rclone crypt remote and keep
its keys elsewhere.

The worker runs as a separate process so copying never blocks the web server. Run a
single application process per data directory; schedules are not coordinated
across replicas, and CLI backups are not counted as running jobs.

The SQLite database is snapshotted with VACUUM INTO; repositories, LFS and release
assets are copied sequentially. **Pause writes during backup** for a cross-store
consistent recovery point. A successful copy is not proof of restorability.

Download/copy the complete backup directory back to local storage before using
`bun tools/admin.ts restore --from PATH --dry-run`. Stop the service before actual
restore. The current CLI restores the database, repositories and LFS; additionally
copy the backup's `releases/` directory to `GITGOOD_DATA_DIR/releases/` with the
service stopped. Retain the previous release directory until recovery is verified.
Server configuration, TLS/SSH host keys and rclone credentials are outside this
backup and must be protected separately. Test recovery on an isolated instance.


### Automatic status and effective configuration

The admin backup page now shows effective server limits and security settings,
including repository/LFS ceilings, Git process concurrency, rate limits, search
index budgets and whether SSH is configured. This is a read-only view; sensitive
paths and credentials are not returned. Configuration remains operator-managed.

Backup status, CI runs/logs and webhook health/deliveries update automatically
while their page is visible, normally every 10 seconds. Manual refresh buttons
are removed. Requests are sequential, hidden tabs suspend polling, failures back
off up to 60 seconds, and returning to a visible tab triggers an update. This is
bounded polling, not instantaneous push-based real-time delivery. CI logs still
use the existing bounded log endpoint; this pass does not add full-log pagination.

These changes do not establish million-file capacity or superiority to GitHub or
GitLab. Code search defaults to 2,000 files per repository and 256 KiB per indexed
file. Large repositories need representative clone/push/LFS benchmarks, storage
capacity planning, backup recovery drills and SSH transport tests in the actual
deployment. Increasing the index limits can increase memory and disk use.

Administration separates backup operations (`/admin/backups`) from effective configuration (`/admin/configuration`). Live status indicates paused/offline and retrying states. Polling aborts on unmount and unchanged responses do not replace page data. Environment-variable names are available in expandable configuration details.

# Feature parity vs GitHub and GitLab

An honest inventory, not a marketing table. Everything in "present" is verified
against this codebase (schema tables, routes, or shipped UI); everything in "gap"
is absent as of 2026-09-18 and named so it can be picked up one item at a time.

Parity with either host is asymptotic - both are a decade-plus of surface area.
The useful question is which missing pieces block day-to-day use of a self-hosted
forge, and those are the Tier 1 gaps below.

## Present (verified in code)

| Area | Notes |
| --- | --- |
| Git smart HTTP | clone/fetch/push, protocol v0/v1/v2, anonymous public reads, 401+WWW-Authenticate for private |
| Shallow & partial clone | `--depth 1` and `--filter=blob:none` verified working against the server (2026-09-18) - the transport passes git's capability negotiation through untouched |
| Repositories | visibility, forks, stars, default branch, deletion, archives (tar.gz/zip), size quotas, push policy (deny force-push / deny deletes / fsck) |
| Browsing | highlighted code view, blame, unified diffs with rename detection, commit detail, per-file history, README rendering, raw download |
| Issues | labels, comments, close/reopen, notifications |
| Pull requests | diff, comments, server-side merge (ff + merge-tree), CI status gating on merge |
| Git LFS | batch API, SHA-256 dedup, streaming uploads, file locking, pointer-aware viewer |
| CI | GitHub-Actions-style YAML, push trigger, one-job `run:` steps, logs, per-repo history, merge gating |
| Search | code search (FTS), repo/user/org search |
| Organisations | shared namespace with users, membership, roles |
| Webhooks | per-repo, event selection, HMAC signing, delivery log; destinations gated against loopback/link-local/private ranges (SSRF), opt-out for self-hosted internal CI |
| Notifications | in-app, per-user, mark-read, pagination |
| Releases | tag + notes (markdown) + binary assets with download counts; publishing auto-creates the tag; deleting a release keeps the tag; drafts hidden from non-writers; elease webhook event |
| Web file editing | create, edit, delete a file as a real commit from the browser; binary (image) upload with preview; first commit on an empty repo; webhooks and CI fire like a push |
| Auth | sessions, access tokens with scopes, TOTP 2FA with replay prevention, recovery codes, passkeys (WebAuthn), bootstrap admin, credential-change session invalidation |
| SSH | key registration, `authorized_keys` generation |
| Ops | online backup/restore, verify, gc, prune, quotas, health/metrics endpoints |
| UI | dark theme, keyboard focus rings, reduced-motion support, skip link, responsive layout |

## Tier 1 gaps - the ones a daily driver notices

1. **Pull request reviews (partially shipped).** Approve, request-changes and
   comment reviews plus SHA-bound PR merge approval/check policies are implemented.
   Inline threads, CODEOWNERS, review requests/dismissals and provider-compatible
   APIs remain missing. See the review gate update below.
2. **Branch protection rules.** Protection is repo-wide (push policy); there are
   no per-branch rules (protected branches, required status checks, required
   reviews, dismiss-stale-approvals).
3. **Scheduled and event-triggered CI.** `push` and manual `workflow_dispatch` run. No `schedule` (cron),
   no `pull_request` trigger, no `matrix:` (parsed but reported unsupported) -
   the Actions workflow tab says so itself.
4. **Milestones.** Issues have labels but no milestone grouping or due dates.

## Tier 2 gaps - power-user surface

- **Wiki** (both hosts) - per-repo markdown space.
- **Projects / kanban** (both) - issue/PR boards.
- **Discussions** (GitHub) - Q&A space separate from issues.
- **Deploy keys** - read/write repo-scoped SSH keys; only personal keys exist.
- **CI environments and secrets** - encrypted per-repo/org secrets, environment
  protection rules. CI steps get no secret store today.
- **Commit signature verification** - GPG/SSH signed-commit badges.
- **Email notifications** - notifications are in-app only; no outbound mail.
- **Subgroups** (GitLab) - orgs are one level deep.
- **Audit log** (both, admin surface) - security events are logged, but there is
  no queryable admin audit trail UI.
- **Organisation-wide 2FA enforcement** (GitHub).

## Tier 3 gaps - ecosystem, not core forge

GitHub-compatible REST API and GraphQL; package/container registry; GitHub
Pages; Codespaces/cloud dev; Dependabot and security advisories; code navigation
(go-to-definition); insights graphs (traffic, contributors over time); light
theme; i18n; mobile apps.

## If I were picking the next three

1. Pull request reviews - approve / request-changes / blocking, which the
   merge gate can then require.
2. Per-branch protection rules with required status checks.
3. `pull_request` + `schedule` CI triggers - the runner already exists; these
   are trigger plumbing, not a new execution model.

### Transport notes

Verified over the wire with real git clients on 2026-09-18:

- `git ls-remote` (v0/1), protocol v2 advertisement (`version 2` in the
  info/refs response when `Git-Protocol: version=2` is offered),
- `git clone --depth 1` (shallow),
- `git clone --filter=blob:none` (partial clone),
- LFS batch/transfer, and push over the same transport.

Both hosts additionally speak HTTP/2 for the browser UI; GitGood's server is
HTTP/1.1. For git itself this is near-invisible - git clients default to
HTTP/1.1 and negotiate up only when told - but it is a real difference for
browser page loads on high-latency links, and it is listed here rather than
hidden. SSH transport works through OpenSSH's own `sshd` with the forced
command in `tools/ssh-command.ts`; deploy keys (repo-scoped, machine-owned)
remain the transport-adjacent Tier 2 gap.

## Code browsing update — 2026-09-23

Blob text views support shareable `#L12` and `#L12-L20` links, Shift-click range selection, and copying the selected link. Branch-based links follow the branch; they are not immutable commit permalinks. Deep links into large files retain the 5,000-row initial rendering cap and show a window around the selected start line.


## Review gate update — 2026-09-24

PR review submission now supports APPROVE, REQUEST_CHANGES and COMMENT. Reviews
are immutable history tied to a commit SHA. Authors cannot approve themselves;
only current repository writers can make decisive reviews. New commits stale
approvals; change requests persist until that reviewer approves. Removing write
authority removes the review from the current merge decision.

Exact-base-branch **PR merge policies** can require 0–6 approvals and successful
checks on the current head. Missing, pending and failed checks block when checks
are required. Latest runs are grouped by workflow name and job ID, so a passing
job in another workflow cannot hide a failure. The head is pinned for merge and
the base ref update uses compare-and-swap to avoid overwriting a concurrent push.
The review UI polls automatically and detects a changed head while drafting.

This closes the basic PR-review submission gap, not the entire review feature set.
Direct pushes are NOT blocked by this policy. No branch patterns, named required
check allowlist, CODEOWNERS, review dismissal, inline review threads, external
check-run API, review notifications/webhooks, or full GitHub API compatibility is
claimed. Personal repositories currently have no independent collaborator write
grant: decisive reviewers must have existing owner/org-admin/instance-admin write
authority. A complete least-privilege collaborator model remains necessary.

Full GitHub/GitLab drop-in compatibility remains incomplete. Priorities: direct
push branch protection and named checks; collaborator permissions; isolated CI
workers and explicit workflow compatibility; scheduled/manual/PR events; API
compatibility and migration tooling; enterprise identity/environment approvals.
Production CI must remain disabled for untrusted code until isolation exists.


## Actions dispatch update — 2026-09-24

Actions now offers branch workflow inspection, manual `workflow_dispatch` (without
inputs), and completed-job reruns from the original commit and workflow. Push and
manual jobs share an in-process scheduler with two execution slots and at most 20
pending jobs. Workflow admission is all-or-nothing, rejected pushes have visible
failure records, and every updated branch is considered. Run rows are persisted
before API success; server startup marks interrupted queued/running records failed
instead of silently retrying side effects. Multiple app replicas sharing a database
are not supported by this scheduler.

The log viewer reads beyond the old first-500-line cutoff using incremental cursors,
retains up to 4,000 displayed lines, and stops fetching completed logs when caught
up. Output is persisted when a job completes, not streamed live from each step.
Admin configuration displays runner policy and queue capacity; it does not expose
an unsafe enable-execution toggle. Production remains disabled by default.

This is NOT a complete Actions system. There is no isolated remote worker fleet,
runner registration/labels/leases, cancellation with process-tree cleanup, secrets
vault, artifact/cache service, dependent-job DAG, cron/PR triggers, workflow inputs,
marketplace `uses`, GitHub expressions, GitLab pipeline compatibility or environment
approval model. Unsupported trigger filters/options are rejected rather than ignored.


## Historical PR comparisons

New merges preserve file-change metadata and the exact base/head SHAs before the
Git ref update. Merged PR file lists and statistics remain stable after later
branch edits or deletion. Review history uses the saved head SHA, and merged PRs
cannot be reopened or closed. This stores file-change metadata, not patch text or
permanent Git object retention; inline historical code review remains incomplete.
Legacy merges without snapshots explicitly report unavailable comparisons instead
of showing a misleading live-branch diff. Snapshots above 4 MiB of serialized
metadata are refused before ref mutation. This is not a guarantee of million-file
PR capacity. Full isolated Actions runners and provider compatibility remain open.


## Actions history browsing

The run list supports bounded ID-cursor pagination (30 by default, maximum100),
with Latest jobs / Newer / Older navigation. Concurrent inserts do not shift older
pages. A selected job is polled by ID independently of the visible history page,
so jobs outside the newest30 still reach terminal status in the log view. This is
job history, not workflow-run grouping, searchable retention or a full runner system.


## Exact branch protection

Repository Settings now supports up to100 exact branch rules requiring PR merges.
Enabled rules block direct HTTP/SSH receive-pack creation, updates, force pushes
and deletion, plus web file edits/deletion and branch API mutations. PR merges
continue through the approval/check gates. Owners/admins have no direct-write
bypass; removing the rule is a separately authorized settings operation.

Receive-pack uses an immutable, per-invocation pre-receive hook in the writable
application data directory, cleaned up when the child exits. Hook installation
errors fail closed. Existing repo hook files are not modified, but while any rule
is enabled the trusted hooksPath replaces repository hook execution; chaining
operator hooks is not implemented. Rules are snapshotted when a push begins:
changes do not retroactively cancel an already accepted/in-flight operation.
Administrators should quiesce writes while establishing protection boundaries.
A host crash can leave a small temporary hook directory until operator cleanup.

No wildcard matching, actor bypass lists, named-check allowlists, tag protection,
CODEOWNERS or multi-replica policy synchronization is claimed. Live OpenSSH
transport deployment/testing remains separate; HTTP tests exercise real Git pushes.
Host filesystem administrators can still alter repository data directly.


## Host-runner deadlines

Step execution and repository preparation now share a deadline covering both
process exit and pipe draining. A timeout kills the direct child with SIGKILL,
cancels pipe readers and returns exit124 rather than holding a scheduler slot
indefinitely. This is not process-tree containment or isolation: descendants may
survive on a trusted host. Production therefore uses registered runners instead: scoped, revocable runner
tokens, atomic claims, ownership-checked log and completion endpoints, heartbeat
expiry, and disposable resource-limited containers on the runner host
(`runner/gitgood-runner.ts`). Job cancellation from the UI is not implemented yet.

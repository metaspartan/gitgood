# Security policy

## Reporting a vulnerability

Please do not open a public issue for security problems. Use GitHub's **Report a vulnerability** button on the repository's Security tab to send a private advisory. Include the affected version or commit, steps to reproduce and the impact you observed.

You should receive an acknowledgement within a few days. Fixes are released as soon as they are verified, and reporters are credited unless they prefer otherwise.

## Scope

In scope: the GitGood server (`src/`), the web UI, the runner agent (`runner/`) and the shipped Docker and Compose files.

Out of scope: vulnerabilities that require an already-compromised administrator account, denial of service through unrestricted resources you configured yourself, and issues in third-party runner images selected by workflows.

## Hardening defaults

- Passwords hashed with Argon2id; sessions are HttpOnly, SameSite=Lax and Secure in production.
- Cookie-authenticated cross-site writes are refused (Origin / Sec-Fetch-Site checks).
- Strict Content-Security-Policy with no remote origins; JavaScript `eval` is forbidden.
- Private repositories answer 404 to anyone without access.
- Webhook destinations on private, loopback and link-local networks are refused by default.
- CI jobs run on external runners, never inside the server process.

# Working on GitGood

Guidance for contributors and coding agents. Read this before changing code.

## Setup

```bash
bun install
bun run build:web     # the server serves the prebuilt SPA from dist/web
bun run dev           # http://localhost:3000, hot reload
bun run seed          # optional large demo dataset (users seed/dev1.., password in tools/seed.ts output)
```

Requirements: Bun 1.4.4+, git 2.30+, git-lfs for LFS tests.

## Verify every change

```bash
bun run typecheck     # strict TypeScript, no unused locals or parameters
bun test              # unit + integration (about 5 minutes); target files with bun test ./tests/<file>
bun run build:web     # must succeed before shipping UI changes
```

All three must pass before a change is considered done. UI changes should also be checked in a browser at desktop and 390 px widths.

## Layout

| Path | Contents |
|---|---|
| `src/server.ts` | Request dispatch: git smart HTTP + LFS, `/api/*`, SPA shell |
| `src/api/routes/*.ts` | One module per resource; register in `src/api/index.ts` |
| `src/data/` | SQLite access (`one`, `all`, `run`, `changes` from `src/db/index.ts`) and cached git reads |
| `src/db/schema.sql`, `src/db/migrations/` | Schema; new columns via `addColumnIfMissing` in `src/db/index.ts` |
| `src/git/` | All git subprocesses go through `src/git/run.ts` (concurrency + output limits) |
| `src/ci/` | Workflow parser, queue, runner protocol; `runner/` is the standalone agent |
| `src/web/` | React SPA; pages are lazy-loaded per route; global styles in `styles.css`, themes in `themes.ts` |
| `tests/unit`, `tests/integration` | `bun test`; integration tests start a real server with `createServer(0)` |

## Conventions

- No comments in source code; names and small functions carry the meaning. Explain decisions in commit messages and docs.
- Validate every request body with `src/lib/validate.ts` (`v.strictObject`) and read it with `readJson`.
- Throw typed errors from `src/lib/errors.ts`; private resources must answer `notFound`, never `forbidden`.
- Use the access helpers (`loadReadableRepo`, `loadWritableRepo`, `requireAdmin`, `requireInstanceAdmin`) instead of ad-hoc checks.
- Never pass user input to git as an option: validate refs with `GIT_REF_PATTERN` and place paths after `--`.
- Every cache and buffer must be bounded in entries or bytes.
- New UI must not shift layout while loading: reserve space with skeletons and render frames before data arrives.
- Add or update tests with every behaviour change; prefer integration tests through the HTTP API.
- Stage explicit paths when committing; never commit `.env`, databases or anything under `data/`.

## Security-sensitive areas

Authentication (`src/auth`), the runner protocol (`src/api/routes/runners.ts`, `src/ci/runners.ts`), webhook egress (`src/lib/egress.ts`), raw/blob/archive serving and the Markdown renderer. Changes there need tests that cover the refusal paths, not only the happy path.

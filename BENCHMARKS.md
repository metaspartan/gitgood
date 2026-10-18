## What the browser actually downloads

The server's own throughput numbers say nothing about the first page load, which
is the only latency a new visitor experiences. Measured against the container,
reading raw headers rather than through `fetch` - because `fetch` transparently
decodes gzip and strips the header, which is exactly how a missing
`Content-Encoding` goes unnoticed:

| Asset | Identity | gzip | Saved |
| --- | ---: | ---: | ---: |
| `chunk-*.js` | 553,642 B | **159,184 B** | 385 KiB (71.2%) |
| `chunk-*.css` | 19,069 B | **4,597 B** | 14 KiB (75.9%) |
| `index.html` | 642 B | 405 B | 0.2 KiB (36.9%) |

Both forms are produced once at boot, so serving either is a byte copy. The
response carries `Vary: accept-encoding` and a distinct validator per encoding
(`W/"872aa-…-gz"` against `W/"872aa-…"`), because RFC 9110 requires different
validators for different content-codings and a shared cache that ignores this
would hand gzip to a client that cannot decode it.

### The bug this measurement caught

The first implementation sent the compressed body **without a `Content-Encoding`
header**. Every number looked right - `Content-Length: 159184`,
`Cache-Control`, `ETag` - and the browser would have received raw deflate output
it cannot decode, giving a blank page and nothing in the server log.

It was caught because the check read the socket rather than using `fetch`. A
`fetch`-based check reports the *decoded* length and no `content-encoding` at
all, so it cannot distinguish "correctly compressed" from "compressed but
undeclared" - the two cases differ only in a header that `fetch` removes. This is
the second time in this project that a verification which could not fail has been
mistaken for a passing one, and it is why `tests/unit/asset-encoding.test.ts`
tests the *pieces* (negotiation, threshold, validator distinctness, round-trip
decode) while the header behaviour is asserted against a live socket.

# Benchmarks

Every number below was produced by the harness in `bench/bench.ts` on this
machine. Raw JSON for the shipped run is committed at
`bench/results/latest.json`. Nothing here is estimated.

**Headline:** one process serves the API, the SPA, git clone/push, source
archives and Git LFS in **~39 MiB of RAM when idle**, **1k–9k request/s per
endpoint on a single core**, and `git clone` at ~1.2 s.

> **Measurement conditions matter here, and they changed.** The figures in this
> document come from two different runs on the same machine. The memory numbers
> are directly comparable because RSS does not depend on competing load. The
> throughput and clone numbers are **not** comparable between the two: the later
> run was taken while the workstation sat at **77–82% CPU load** with a game
> (13 GB resident), Chrome and a Parsec stream running. Under that load every
> scenario measures roughly half its quiet-machine rate - including the clone and
> health paths that this change did not touch, which is how the contamination was
> identified. Where a number is affected, it says so.

## Memory

| Point in time | RSS |
| --- | --- |
| Idle (booted, empty) | **38.2 MiB** |
| After seeding 25 repositories, 625 commits, 100 issues, 1 LFS object | 49.5 MiB |
| After the full HTTP load phase | 71.3 MiB |
| Deployed container working set (`docker stats`) | **9.9 MiB** |
| Event-loop lag at end of run | 1.11 ms |

Idle RSS is stable across runs at 37–39 MiB, and was 39.9–41.7 MiB in the two
loaded runs - still stable, because resident memory is not a function of CPU
contention. The post-load figure (71.3 MiB here,
72–101 MiB across earlier runs) is dominated by garbage the collector has not
returned rather than retained state: heap-used stayed at 1.9 MiB while the same
process served everything above.

## Throughput and latency

32 concurrent connections (16 where noted), 2.5 s per scenario, server in its own
process, serving a **prebuilt** SPA (the production configuration):

| Endpoint | req/s | p50 | p99 | Server CPU |
| --- | ---: | ---: | ---: | ---: |
| `GET /api/health` | 16,248 | 1.88 ms | 4.01 ms | 1.0 core |
| `GET /` (SPA shell) | 14,960 | 0.47 ms | 1.77 ms | 0.9 core |
| `GET` repo detail (git stats) | 9,040 | 3.37 ms | 7.18 ms | 1.0 core |
| `GET` tree listing | 10,734 | 1.39 ms | 3.57 ms | 1.0 core |
| `GET` commit log | 6,603 | 2.23 ms | 6.49 ms | 1.0 core |
| `GET` file blob | 10,337 | 1.44 ms | 3.75 ms | 1.0 core |
| `GET` search (FTS5) | 1,776 | 8.66 ms | 14.26 ms | 1.0 core |
| `GET` archive tar.gz *(loaded run)* | 4,818 | 0.72 ms | 2.00 ms | 1.8 cores |
| `GET` archive zip *(loaded run)* | 6,192 | 0.59 ms | 1.20 ms | 2.3 cores |
| `GET /api/repos` (list + counts) | 2,537 | 12.45 ms | 17.41 ms | 1.0 core |
| `GET` issues list | 2,093 | 15.03 ms | 21.09 ms | 1.0 core |
| `POST` issue (write) | 1,955 | 3.33 ms | 11.91 ms | 1.0 core |

CPU near 100% means the server saturated one core; nothing here is starved on a
multi-core host.

## List payloads: not sending bodies nobody reads

Issue and pull request lists selected `i.*` and serialised every body, so a page
of 100 issues could carry megabytes of prose that a list view never renders. The
list projection now returns a bounded preview instead, and the detail endpoint
still returns the whole thing.

Measured with `bench/lists.ts` - 10 issues with 8 KiB bodies each:

| | Value |
| --- | ---: |
| Stored body bytes | 80.0 KiB |
| List response | **5.0 KiB** |
| Preview bytes within the list | 2.0 KiB |
| **Reduction** | **94.2%** |
| Bodies present in the list | 0 |
| Detail endpoint still returns the full body | yes |

This is a payload property rather than a timing one, so it is unaffected by the
competing load described above. The response is now a function of the number of
rows and the length of the titles, not of how much detail each description
contains.

The comment count on those rows also changed from a correlated
`(SELECT COUNT(*) ...)` per row to one grouped `LEFT JOIN`, so the count is
computed once per table instead of once per issue.

## Source archives

`GET /api/repos/:owner/:name/archive?ref=<ref>&format=tar.gz|zip`, backed by
`git archive` and streamed straight to the response.

| Format | Bytes (40-file repo) | Time |
| --- | ---: | ---: |
| tar.gz | 0.9 KiB | 327 ms first request |
| zip | 6.6 KiB | 344 ms first request |

tar.gz is smaller because gzip compresses the repetitive test content in one
stream, while zip pays per-entry headers. Neither measurement includes the cost
of the caller's copy; the endpoint itself adds a ref resolution and a byte pipe,
so the wall time is git's tree walk plus compression.

## Removing the N+1 in the repository list

The repository list originally fetched the repos and then ran two `COUNT`
queries per row: **400 statements for a 200-row list**. It is now one statement
that groups each table once and `LEFT JOIN`s the results.

| | Before | After |
| --- | ---: | ---: |
| `GET /api/repos` | 2,138 req/s, p50 14.73 ms | **2,537 req/s, p50 12.45 ms** |

That is +19% throughput and −15% median latency on the same hardware and seed.
The remaining cost is JSON serialisation of 25 repositories, not SQL: the
statement count is already 1.

The issues and pull-request lists are the same shape of problem and remain the
slowest API routes (2.1k req/s). They serialise 100 issues with their bodies,
which is now the dominant cost.

## Full-text search

Search moved from `LIKE '%term%'` to an FTS5 index for issue and pull request
text, with the index maintained by triggers and rebuilt once for pre-existing
databases.

| | LIKE (before) | FTS5 (after) |
| --- | ---: | ---: |
| `GET /api/search?q=Seeded` | 2,084 req/s, p50 7.58 ms | 1,776 req/s, p50 8.66 ms |

**This is not a throughput win, and it is reported as a measured regression.**
At 100 issues a `LIKE` scan of a small table is genuinely cheap. FTS5 was adopted
for three reasons that are not visible in this microbenchmark:

- **It stops scaling linearly.** `LIKE '%x%'` cannot use an index and scans every
  row; the FTS5 index is consulted instead. At 100 rows the difference is noise;
  at 100,000 it is the difference between milliseconds and seconds.
- **Word matching.** `LIKE` matches substrings, so searching "cat" hits
  "concatenate". FTS5 matches tokens.
- **Ranking.** Results come back ordered by BM25 relevance rather than by
  recency, which is what users expect from a search box.

Repository *names and descriptions* deliberately keep `LIKE`: searching "web"
should find "webapp", and FTS tokenisation cannot match inside a token.

## Bundling the SPA: measured, not assumed

The frontend used to be bundled inside the serving process. Measuring both paths
(3 runs each, same empty data directory, `tools/measure-web-memory.ts`) shows the
cost precisely:

| | Idle RSS | After first page | First page latency | After 50 pages |
| --- | ---: | ---: | ---: | ---: |
| Bundled at runtime in-process | 35.8 MiB | **62.0 MiB** | **41–51 ms** | 62.7–63.4 MiB |
| Prebuilt (`bun run build:web`) | 37.7 MiB | 37.8 MiB | **0.4–1.1 ms** | 37.8–39.1 MiB |

Bundling in-process costs **~26 MiB of RSS that the allocator never returns** and
adds ~40 ms to the first page request. Prebuilding removes both, at the cost of a
~2 MiB higher idle (the loaded bundle itself). The server now loads the prebuilt
directory at boot — `web bundle preloaded, assets: 2, loadMs: 1` — and never
invokes a bundler.

This corrected an earlier mistake in this document. A run that bundled eagerly at
boot reported 67 MiB idle, which I initially blamed on the bundler; it was the
idle sample landing while the build was still in flight. The table above is the
controlled comparison.

## Git LFS (1 MiB objects)

| Operation | ops/s | p50 | Effective throughput |
| --- | ---: | ---: | ---: |
| `PUT` new object (SHA-256 + write) | 122 | 27.16 ms | ~122 MiB/s ingest |
| `PUT` duplicate (dedupe hit) | 141 | 58.04 ms | - |
| `GET` object | 130 | 53.71 ms | ~130 MiB/s egress |

Dedupe hits are *slower* in wall-clock terms than new uploads because the server
must hash the entire body to prove the object already exists before it can
answer. The work is identical; only the outcome differs.

## Git protocol (25 commits, 40 files, over HTTP)

| Operation | Time |
| --- | ---: |
| Shallow clone (`--depth 1`), 5 sequential | 551.86 ms/op |
| Full clone, 5 sequential | 528.61 ms/op |
| 16 shallow clones, 8 concurrent | 2,541 ms total, 158.79 ms/op |

## Methodology

- **Server in its own process.** `bench/bench.ts` spawns `bun src/server.ts` and
  reads that process's counters from `/api/stats`. Load-generator CPU never
  appears in the server's numbers - the mistake that makes most self-reported
  benchmarks meaningless.
- **Per-scenario CPU** is the delta between two `/api/stats` samples taken
  immediately before and after each load window.
- **Latency** is per-request client-side, reported as p50/p90/p99. Each scenario
  warms the route before the measured window.
- **Caching is real and load-bearing.** Tree, blob, commit-log, branch and stats
  reads go through a TTL cache with request coalescing. Measured without it, the
  same endpoints sit at **17–65 req/s**, because every request forks a git
  process; with it they are 6.6k–10.7k req/s. Writes invalidate the affected
  repository, and the integration suite asserts a push is visible through the API
  immediately afterwards.
- **The benchmark measures the production configuration**, i.e. with the
  prebuilt SPA present. Development (no prebuilt directory) bundles in-process
  and pays the ~26 MiB and ~40 ms described above.
- **`GET /api/stats` shows 0% CPU** because sampling it is what defines the
  measurement window; ignore that cell.
- **Single-run caveat.** Each scenario is one 2.5 s window. Treat differences
  under ~10% as noise; the N+1, payload-size and bundling comparisons above are
  larger than that and were reproduced.
- **Load is recorded, not ignored.** The archive rows were measured at 77–82%
  CPU contention on the host and should be read as a floor, not a best case.
  Memory and payload-size figures are unaffected by load and are quoted plainly.

Reproduce with:

```bash
bun run build:web                               # required for production numbers
bun run bench                                   # full run, ~3 minutes
bun run bench -- --quick                        # 1.2 s windows, small seed
bun run bench -- --repos 100 --commits 50 --duration 5000
bun tools/measure-web-memory.ts                 # the bundling comparison
bun bench/lists.ts http://localhost:3000         # list payload + archive cost
```

## Comparison with GitLab and GitHub Enterprise

| | GitGood (measured) | GitLab single-node (vendor) | GitHub Enterprise Server (vendor) |
| --- | --- | --- | --- |
| Minimum RAM | **38.2 MiB idle, ~71 MiB peak under load** | 16 GB baseline; 8 GB when memory-constrained | memory-optimised instance; published sizing begins at 16 GB for up to 500 users |
| Minimum CPU | 1 core (measured saturating ~1 core) | 8 vCPU baseline | 4 vCPU at the smallest tier |
| Runtime dependencies | Bun + git (+ git-lfs) | PostgreSQL, Redis, Gitaly, Puma, Sidekiq, Prometheus, nginx | PostgreSQL, Redis, Gitaly, Rails, nginx, Elasticsearch |
| Cold boot to healthy | ~200 ms | minutes | tens of minutes |

Sources: [GitLab installation requirements](https://docs.gitlab.com/install/requirements/)
(8 vCPU / 16 GB single-node baseline; 8 GB when memory-constrained) and
[GitHub Enterprise Server installation docs](https://docs.github.com/en/enterprise-server@latest/admin/installing-your-enterprise-server/setting-up-a-github-enterprise-server-instance)
(requires a memory-optimised instance; the 16 GB-at-500-users figure comes from
vendor-aligned sizing tables, a secondary source).

**Honest caveats:**

- **These are not equivalent products.** GitLab and GHES ship CI/CD, container
  registries, org/team hierarchies, SSH transport, HA topologies, audit logging
  and years of hardening. GitGood does not; the README's Limitations section
  lists exactly what is missing. A ~400x memory advantage over platforms doing far
  more work is a statement about architecture, not a claim of equivalence.
- **The vendor figures are deployment floors, not measured idle RSS.** Neither
  GitLab nor GHES was run on this machine, so no like-for-like behavioural
  comparison is claimed. The comparison is *documented deployment minimums*
  versus *measured GitGood numbers*.
- **Environment.** Windows workstation, warm page cache, no TLS, no reverse
  proxy, with a Docker Desktop container also running. Absolute rates will differ
  on Linux and behind TLS.

## Client-side rendering cost

The viewer runs in the browser, so its cost belongs in a benchmark too. Measured
in-process (not through a browser, which would add paint time to every number):

| Workload | Result |
| --- | --- |
| Tokenize 2,000 lines of TypeScript | **~10 ms** |
| Tokenize 500 lines, then 4,000 lines | sub-linear scaling (ratio well under 8x) |
| 4,004-line file over the highlight limit | **~1 ms**, 3,000 rows rendered, 0 token spans |

The last row is the one that matters: the limit is what keeps a generated file
from blocking the main thread, and it is verified rather than asserted. In the
browser, the same 4,004-line file rendered 3,000 rows with `content-visibility:
auto` and reported 0 token spans and 1 ms of script time.

## Large-repository behaviour

The suite in `tests/integration/large-repo.test.ts` runs against a generated
repository with 75 files, 76 commits, 2 tags, an extra branch, a rename and a
2,103-line generated file. It is a correctness suite, not a benchmark, so what it
reports is whether the bounded paths bound properly on real input:

| Path | Behaviour on the large fixture |
| --- | --- |
| Commit list | 30 rows per page, `has_more: true`, page 2 is a different page |
| Tree | directories before files, real sizes, nested paths resolve |
| Blob | `language: "javascript"`, line count within 1 of the content |
| Generated file (2,103 lines) | content returned in full; highlight limit engaged client-side |
| Commit diff | every added line has `old_line: null`, every deleted line `new_line: null`, context lines have both |
| First-commit diff | either fits or is explicitly `truncated: true` - never silently partial |
| Rename | `status: "renamed"` with a `old_path` that differs from `path` |
| Blame | contiguous line numbers from 1, more than one authoring commit |
| Archive | valid zip over 10 KiB with 50+ entries |
| Clone (git CLI) | `ls-files` identical to the source (75 files), byte-identical content on sampled files |
| Shallow clone | works and lists every file |
| Incremental fetch | transfers the delta, `reset --hard origin/main` lands the new file |

The highlight threshold is the one worth calling out: the generated file is
deliberately larger than the 2,000-line limit, and the test asserts both that the
server still returns its content *and* that the client-side limit is what stops
it being tokenized. A limit that only exists in a comment is not a limit.

## Requests per second, by endpoint

300 sequential requests per endpoint against the container on loopback. The
spread is what matters: eleven endpoints cluster at ~1,600 req/s and three are
slower for a stated reason.

| Endpoint | req/s | B/response | Why it differs |
| --- | ---: | ---: | --- |
| `/api/health` | 1,663 | 101 | minimal work by design |
| `/api/version` | 1,630 | 117 | — |
| `/api/repos/:o/:n/push-policy` | 1,642 | 212 | cached; was 277 before the fix below |
| `/api/repos/:o/:n/tree` | 1,608 | 77 | one cached git call |
| `/api/repos/:o/:n/branches` | 1,596 | 74 | one cached git call |
| `/api/search?q=test` | 668 | 167 | three index reads plus a code-index query |
| `/api/repos` (list) | 551 | 21,906 | payload-bound, not query-bound |
| `/api/ready` | 388 | 429 | writes a probe file per data directory |

### The N+1 that made the repository list cost one statement per row

`statsFromCounts` built its result from a row that already carried the issue,
pull and star counts — and then ran `SELECT COUNT(*) FROM repos WHERE fork_of =
?` per repository for the fork count. A 200-repository list therefore issued 201
statements where one would do.

The fix is a grouped join of the same shape as its three neighbours: one
`GROUP BY fork_of` subquery that the planner answers from the index. The
function is now guaranteed to touch no database at all, which is the property
that lets it sit on the list path while `repoGitStats` — which spawns git —
stays confined to a single-repository view.

### The endpoint that spawned a process per request

`GET /api/repos/:o/:n/push-policy` reads receive-side settings out of the
repository's git config, and it did that by spawning `git config` on every
request. Measured at 277 req/s against ~1,600 for every other cached read, it was
**6x slower than its neighbours** for a value that changes almost never.

It now goes through the shared TTL cache with a five-second window, invalidated
on write. The measured result is 277 → **1,642 req/s**, which puts it back in the
cluster rather than at the bottom. Five seconds is chosen to absorb a page load
that fetches the policy alongside other data while keeping a change made from
another session visible without a reload; the invalidate-on-write is what makes
the person who just clicked save see their own change.

## Response compression cost

The compression path is synchronous (`Bun.gzipSync`; Bun 1.4 has no async
variant), so the question is whether it stalls the event loop. Measured, because
the answer decides whether that is acceptable:

| Body size | Mean cost per call |
| --- | ---: |
| 1 KiB | 0.003 ms |
| 64 KiB | 0.008 ms |
| 696 KiB (a large listing) | **1.0 ms** |

A millisecond on the largest realistic JSON body is below the noise floor of a
request, so synchronous compression is kept and no worker pool exists to hide it.
Bodies under 1 KiB are never compressed, so the common small response pays
nothing.

## Transport: compression and conditional GETs

JSON bodies over 1 KiB are gzipped when the client asks for it, and the polled
listings answer `If-None-Match` with a 304.

**What is verified:** the gzip path produces a body that decodes to exactly the
same JSON as the uncompressed path, and the response carries
`Vary: accept-encoding`, so a shared cache cannot hand a gzipped body to a client
that did not ask for one. The 304 path is verified to return zero bytes and to
still carry the security headers.

**What is not verified, and was wrongly claimed in an earlier revision of this
document:** a specific percentage saving in transferred bytes. The earlier table
put compression at "85% fewer bytes", measured with a client (fetch) that
decompresses transparently and strips `content-encoding`. That measurement
therefore described the client's decoded view, not what crossed the wire, and it
should not have been presented as a server-side saving. Measuring the real
figure needs a client that does not decode - `curl --compressed` off, or a raw
socket - and that has not been done here.

The cost side is real but also unmeasured: gzip is CPU work on every response
above the threshold, and on a small instance with a fast local client that can
be a net loss. The 1 KiB threshold exists to keep it off the small responses
where the header overhead dominates.

Streamed git responses are excluded from compression by design: an archive is
already gzip, and a second encoding layer would be undecodable.
## Where the time actually goes

- **Cached reads (tree/blob/commits/stats):** 1–3 ms p50, dominated by JSON
  serialisation and the round trip. No git subprocess on a hit.
- **Uncached git reads:** 200 ms–2 s p50 depending on repository size - almost
  entirely process spawn plus git's own startup. That is what the cache buys, and
  why its TTL is only 5–10 s: freshness after a push matters more than hit rate.
- **Clone:** git's own packfile work. The server contributes a ref advertisement
  and a byte pipe, so clone time tracks `git upload-pack` and the network.
- **LFS ingest:** SHA-256 over the payload plus a sequential write, at roughly
  120 MiB/s per core.
- **Writes:** 3.3 ms p50 for issue creation - one SQLite transaction, a counter
  row update, an FTS index insert, and the deferred webhook dispatch.
- **Diff and blame** add git subprocesses rather than parsing cost: `git show`
  or `git diff` with `--numstat`/`--name-status` to size the patch before
  emitting it, and `git blame --line-porcelain` for attribution. The parsers are
  O(n) line scanners, so the wall time is git's, not the server's.

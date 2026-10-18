const base = process.argv[2] ?? "http://127.0.0.1:3099";
const RUNS = Number(process.argv[3] ?? 5);

let session = "";

async function timed(path: string, method = "GET", body?: unknown): Promise<{ status: number; ms: number; bytes: number }> {
  const headers: Record<string, string> = {};
  if (session) headers.cookie = session;
  if (body !== undefined) headers["content-type"] = "application/json";
  const start = performance.now();
  const response = await fetch(base + path, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  return { status: response.status, ms: performance.now() - start, bytes: text.length };
}

const login = await fetch(`${base}/api/auth/login`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ username: "seed", password: "seed-admin-password" }),
});
session = (login.headers.get("set-cookie") ?? "").split(";")[0]!;
if (login.status !== 200) {
  console.error(`login failed: ${login.status} - seed the instance first`);
  process.exit(1);
}

async function measure(path: string, method = "GET", body?: unknown) {
  const samples: number[] = [];
  let status = 0;
  let bytes = 0;
  for (let i = 0; i < RUNS; i += 1) {
    if (i === 1) continue;
    const result = await timed(path, method, body);
    status = result.status;
    bytes = result.bytes;
    samples.push(result.ms);
  }
  samples.sort((a, b) => a - b);
  return { status, median: samples[Math.floor(samples.length / 2)] ?? 0, worst: samples.at(-1) ?? 0, bytes };
}

const PATHS: Array<{ label: string; path: string; note?: string }> = [
  { label: "repository list (page 1)", path: "/api/repos?per_page=30&page=1" },
  { label: "repository list (page 13)", path: "/api/repos?per_page=30&page=13" },
  { label: "repository list (per_page=100)", path: "/api/repos?per_page=100" },
  { label: "large repository header", path: "/api/repos/seed/large-repository" },
  { label: "large repository tree", path: "/api/repos/seed/large-repository/tree?ref=main" },
  { label: "large repository commits p1", path: "/api/repos/seed/large-repository/commits?per_page=30&page=1" },
  { label: "large repository commits p17", path: "/api/repos/seed/large-repository/commits?per_page=30&page=17" },
  { label: "nested tree walk", path: "/api/repos/seed/large-repository/tree?ref=main&path=src/module-00" },
  { label: "blob (file contents)", path: "/api/repos/seed/large-repository/blob?ref=main&path=src/module-00/file-0.ts" },
  { label: "raw file", path: "/api/repos/seed/large-repository/raw/src/module-00/file-0.ts?ref=main" },
  { label: "issues (open, p1)", path: "/api/repos/seed/large-repository/issues?state=open&per_page=30&page=1" },
  { label: "issues (all, p9)", path: "/api/repos/seed/large-repository/issues?state=all&per_page=30&page=9" },
  { label: "issues filtered by assignee", path: "/api/repos/seed/large-repository/issues?state=all&assignee=dev1" },
  { label: "one issue", path: "/api/repos/seed/large-repository/issues/1" },
  { label: "pull requests (all)", path: "/api/repos/seed/large-repository/pulls?state=all&per_page=30" },
  { label: "one pull request", path: "/api/repos/seed/large-repository/pulls/1" },
  { label: "pull request files", path: "/api/repos/seed/large-repository/pulls/1/files" },
  { label: "milestones", path: "/api/repos/seed/large-repository/milestones?state=all" },
  { label: "search: repositories", path: "/api/search?q=seeded&type=repos" },
  { label: "notifications", path: "/api/notifications?per_page=30" },
  { label: "admin metrics", path: "/api/admin/metrics" },
];

console.log(`\n${base}  (${RUNS - 1} samples each, first discarded)\n`);
console.log(
  ["page", "status", "median", "worst", "bytes"].map((h, i) => (i === 0 ? h.padEnd(38) : h.padStart(11))).join(""),
);
console.log("-".repeat(95));
const results: Array<{ label: string; median: number }> = [];
for (const { label, path } of PATHS) {
  const result = await measure(path);
  results.push({ label, median: result.median });
  const flag = result.median > 300 ? "  <-- slow" : result.median > 120 ? "  <- watch" : "";
  console.log(
    [
      label.padEnd(38),
      String(result.status).padStart(11),
      `${result.median.toFixed(1)} ms`.padStart(11),
      `${result.worst.toFixed(1)} ms`.padStart(11),
      `${(result.bytes / 1024).toFixed(1)} KiB`.padStart(11),
    ].join("") + flag,
  );
}

const slowest = [...results].sort((a, b) => b.median - a.median).slice(0, 5);
console.log(`\nslowest five:`);
for (const entry of slowest) console.log(`  ${entry.median.toFixed(1)} ms  ${entry.label}`);

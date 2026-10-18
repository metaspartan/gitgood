import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BASE = process.argv[2] ?? "http://127.0.0.1:3210";
const scratch = mkdtempSync(join(tmpdir(), "gg-e2e-"));
let cookie = "";
let failures = 0;

function check(label: string, condition: boolean, detail?: unknown): void {
  if (condition) {
    console.log(`  PASS  ${label}`);
  } else {
    failures += 1;
    console.log(`  FAIL  ${label}${detail === undefined ? "" : ` :: ${JSON.stringify(detail)}`}`);
  }
}

async function api<T>(
  path: string,
  init: RequestInit & { body?: string } = {},
): Promise<{ status: number; data: T }> {
  const response = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...(cookie ? { cookie } : {}),
      ...(init.headers ?? {}),
    },
  });
  const setCookie = response.headers.get("set-cookie");
  if (setCookie) cookie = setCookie.split(";")[0] ?? "";
  const text = await response.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  return { status: response.status, data: data as T };
}

async function git(args: string[], cwd: string): Promise<{ code: number; out: string }> {
  const proc = Bun.spawn(["git", ...args], {
    cwd,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, out: out + err };
}

const IDENTITY = ["-c", "user.name=E2E", "-c", "user.email=e2e@example.com"];

console.log(`\n[1] health + signup (${BASE})`);
const health = await api<{ status: string }>("/api/health");
check("health is ok", health.data.status === "ok", health.data);

const suffix = Date.now().toString(36);
const username = `e2e${suffix}`;
const signup = await api<{ user: { id: number; username: string } }>("/api/auth/signup", {
  method: "POST",
  body: JSON.stringify({ username, email: `${username}@example.com`, password: "supersecret123" }),
});
check("signup returns a user", signup.status === 201 && signup.data.user.username === username, signup);

console.log("\n[2] access token + repository creation");
const tokenResponse = await api<{ token: string }>("/api/tokens", {
  method: "POST",
  body: JSON.stringify({ name: "e2e" }),
});
const token = tokenResponse.data.token;
check("token issued", typeof token === "string" && token.startsWith("ggh_"), tokenResponse.data);

const created = await api<{ full_name: string; default_branch: string }>("/api/repos", {
  method: "POST",
  body: JSON.stringify({ name: "demo", description: "e2e repository" }),
});
check("repository created", created.status === 201 && created.data.full_name === `${username}/demo`, created.data);

console.log("\n[3] git push over smart HTTP");
const work = join(scratch, "work");
const clone = join(scratch, "clone");
mkdirSync(work, { recursive: true });
const remote = `${BASE.replace("http://", `http://${username}:${token}@`)}/${username}/demo.git`;

await git(["init", "-q", "-b", "main", work], work);
await git(["remote", "add", "origin", remote], work);
writeFileSync(join(work, "README.md"), "# demo\n\nPushed by the e2e suite.\n");
writeFileSync(join(work, "app.txt"), "hello\n");
await git(["add", "."], work);
await git([...IDENTITY, "commit", "-q", "-m", "initial commit"], work);
const push = await git(["push", "-q", "origin", "main"], work);
check("push accepted", push.code === 0, push.out);

console.log("\n[4] git clone over smart HTTP (anonymous)");
const cloned = await git(["clone", "-q", `${BASE}/${username}/demo.git`, clone], scratch);
check("anonymous clone succeeds", cloned.code === 0, cloned.out);
if (cloned.code === 0) {
  check("cloned README content matches", readFileSync(join(clone, "README.md"), "utf8").includes("e2e suite"));
}

console.log("\n[5] server-side repository inspection");
const branches = await api<{ items: Array<{ name: string }>; default_branch: string }>(
  `/api/repos/${username}/demo/branches`,
);
check("main branch visible", branches.data.items.some((b) => b.name === "main"), branches.data);

const commits = await api<{ items: Array<{ message: string }> }>(`/api/repos/${username}/demo/commits`);
check("commit listed", commits.data.items[0]?.message === "initial commit", commits.data);

const tree = await api<{ items: Array<{ name: string; type: string }> }>(`/api/repos/${username}/demo/tree`);
check("tree lists README.md", tree.data.items.some((e) => e.name === "README.md"), tree.data);

const readme = await api<{ content: string | null }>(`/api/repos/${username}/demo/readme`);
check("readme rendered", (readme.data.content ?? "").includes("Push"), readme.data);

console.log("\n[6] issues, comments and labels");
const issue = await api<{ number: number }>(`/api/repos/${username}/demo/issues`, {
  method: "POST",
  body: JSON.stringify({ title: "First issue", body: "Body text", labels: ["bug"] }),
});
check("issue created", issue.status === 201 && issue.data.number === 1, issue.data);

const comment = await api<{ id: number }>(`/api/repos/${username}/demo/issues/1/comments`, {
  method: "POST",
  body: JSON.stringify({ body: "A comment" }),
});
check("comment created", comment.status === 201, comment.data);

const closed = await api<{ state: string }>(`/api/repos/${username}/demo/issues/1`, {
  method: "PATCH",
  body: JSON.stringify({ state: "closed" }),
});
check("issue closed", closed.data.state === "closed", closed.data);

console.log("\n[7] pull request + server-side merge");
await git(["checkout", "-q", "-b", "feature"], work);
writeFileSync(join(work, "feature.txt"), "new feature\n");
await git(["add", "."], work);
await git([...IDENTITY, "commit", "-q", "-m", "add feature"], work);
const featurePush = await git(["push", "-q", "origin", "feature"], work);
check("feature branch pushed", featurePush.code === 0, featurePush.out);

const pull = await api<{ number: number; state: string }>(`/api/repos/${username}/demo/pulls`, {
  method: "POST",
  body: JSON.stringify({ title: "Add feature", head: "feature", base: "main" }),
});
check("pull request created", pull.status === 201, pull.data);

const files = await api<{ stats: { files_changed: number } }>(`/api/repos/${username}/demo/pulls/1/files`);
check("pull request diff computed", (files.data.stats?.files_changed ?? 0) >= 1, files.data);

const merge = await api<{ merged: boolean; sha: string; fastForward: boolean }>(
  `/api/repos/${username}/demo/pulls/1/merge`,
  { method: "POST", body: "{}" },
);
check("pull request merged", merge.data.merged === true, merge.data);

const afterMerge = await api<{ items: Array<{ name: string }> }>(`/api/repos/${username}/demo/tree`);
check("merged file present on main", afterMerge.data.items.some((e) => e.name === "feature.txt"), afterMerge.data);

console.log("\n[8] Git LFS protocol");
const content = `lfs-payload-${suffix}`;
const oid = new Bun.CryptoHasher("sha256").update(content).digest("hex");
const lfsHeaders = {
  "content-type": "application/vnd.git-lfs+json",
  authorization: `Bearer ${token}`,
};
const batch = await fetch(`${BASE}/${username}/demo.git/info/lfs/objects/batch`, {
  method: "POST",
  headers: lfsHeaders,
  body: JSON.stringify({
    operation: "upload",
    transfers: ["basic"],
    objects: [{ oid, size: content.length }],
  }),
});
const batchBody = (await batch.json()) as {
  objects: Array<{ actions?: { upload?: { href: string } } }>;
};
check("lfs batch returns upload action", batch.status === 200 && Boolean(batchBody.objects[0]?.actions?.upload), batchBody);

const uploadHref = batchBody.objects[0]?.actions?.upload?.href;
if (uploadHref) {
  const upload = await fetch(uploadHref, { method: "PUT", headers: { authorization: `Bearer ${token}` }, body: content });
  check("lfs upload accepted", upload.status === 200, upload.status);
}

const downloadBatch = await fetch(`${BASE}/${username}/demo.git/info/lfs/objects/batch`, {
  method: "POST",
  headers: lfsHeaders,
  body: JSON.stringify({ operation: "download", transfers: ["basic"], objects: [{ oid, size: content.length }] }),
});
const downloadBody = (await downloadBatch.json()) as {
  objects: Array<{ actions?: { download?: { href: string } } }>;
};
const downloadHref = downloadBody.objects[0]?.actions?.download?.href;
check("lfs batch returns download action", Boolean(downloadHref), downloadBody);
if (downloadHref) {
  const download = await fetch(downloadHref, { headers: { authorization: `Bearer ${token}` } });
  const text = await download.text();
  check("lfs download content matches", text === content, text);
}

const badHash = await fetch(`${BASE}/${username}/demo.git/info/lfs/objects/${"0".repeat(64)}`, {
  method: "PUT",
  headers: { authorization: `Bearer ${token}` },
  body: "mismatched",
});
check("lfs rejects mismatched oid", badHash.status === 422, badHash.status);

console.log("\n[9] authorization boundaries");
const anon = await fetch(`${BASE}/${username}/demo.git/info/refs?service=git-upload-pack`);
check("anonymous fetch allowed on public repo", anon.status === 200, anon.status);

const privateRepo = await api<{ full_name: string }>("/api/repos", {
  method: "POST",
  body: JSON.stringify({ name: "secret", visibility: "private" }),
});
check("private repo created", privateRepo.status === 201, privateRepo.data);
const anonPrivate = await fetch(`${BASE}/${username}/secret.git/info/refs?service=git-upload-pack`);
check("anonymous fetch denied on private repo", anonPrivate.status === 401, anonPrivate.status);

const savedCookie = cookie;
cookie = "";
const anonApi = await api<{ error: { code: string } }>(`/api/repos/${username}/secret`);
check("anonymous API read is hidden as not-found", anonApi.status === 404, anonApi);
const anonApiOther = await api<{ error: { code: string } }>(`/api/repos/${username}/does-not-exist-${Date.now()}`);
check(
  "and is indistinguishable from a repository that does not exist",
  anonApiOther.status === anonApi.status,
  { real: anonApi.status, missing: anonApiOther.status },
);
cookie = savedCookie;

const badToken = await fetch(`${BASE}/${username}/demo.git/git-receive-pack`, {
  method: "POST",
  headers: { authorization: "Bearer ggh_deadbeef_invalid" },
  body: "0000",
});
check("invalid token cannot push", badToken.status === 401, badToken.status);

console.log("\n[10] search and stats");
const search = await api<{ repos: unknown[]; issues: unknown[] }>(`/api/search?q=demo`);
check("search finds the repository", search.data.repos.length > 0, search.data);

const stats = await api<{
  counts: { repos: number };
  process: { rssBytes: number; cpuPercent: number };
  histograms: Record<string, { p99: number; count: number }>;
}>(`/api/stats`);
check("stats reports repositories", stats.data.counts.repos >= 2, stats.data.counts);
check(
  "requests recorded",
  (stats.data.histograms.http_request_ms?.count ?? 0) > 0,
  stats.data.histograms.http_request_ms,
);

console.log("\n[11] code, diff, blame and image endpoints");

const PNG_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==",
  "base64",
);

await git(["checkout", "-q", "main"], work);
await git(["fetch", "-q", "origin"], work);
await git(["reset", "--hard", "-q", "origin/main"], work);

mkdirSync(join(work, "src"), { recursive: true });
mkdirSync(join(work, "scripts"), { recursive: true });
mkdirSync(join(work, "assets"), { recursive: true });
writeFileSync(
  join(work, "src", "app.ts"),
  "// entry point\nexport function greet(name: string): string {\n  return `hello ${name}`;\n}\n",
);
writeFileSync(join(work, "scripts", "build.sh"), "#!/bin/sh\necho building\n");
writeFileSync(join(work, "assets", "dot.png"), PNG_BYTES);
await git(["add", "."], work);
await git([...IDENTITY, "commit", "-q", "-m", "add source, script and image"], work);
await git(["mv", "scripts/build.sh", "scripts/release.sh"], work);
await git([...IDENTITY, "commit", "-q", "-m", "rename build script"], work);
const enrich = await git(["push", "-q", "origin", "main"], work);
check("enriched content pushed", enrich.code === 0, enrich.out);

const blob = await api<{
  language: string | null;
  line_count: number;
  binary: boolean;
  content: string | null;
}>(`/api/repos/${username}/demo/blob?path=src/app.ts&ref=main`);
check("blob reports the language", blob.data.language === "typescript", blob.data);
check("blob reports a line count", (blob.data.line_count ?? 0) >= 4, blob.data.line_count);
check("blob is not marked binary", blob.data.binary === false, blob.data.binary);
check("blob returns the source text", (blob.data.content ?? "").includes("greet"), blob.data.content?.slice(0, 40));

const rawImage = await fetch(`${BASE}/api/repos/${username}/demo/raw?path=assets/dot.png&ref=main`);
const imageBytes = new Uint8Array(await rawImage.arrayBuffer());
check(
  "image served with a png content type",
  (rawImage.headers.get("content-type") ?? "").includes("image/png"),
  rawImage.headers.get("content-type"),
);
check(
  "image bytes are a real PNG",
  imageBytes[0] === 0x89 && imageBytes[1] === 0x50 && imageBytes[2] === 0x4e && imageBytes[3] === 0x47,
  [...imageBytes.slice(0, 4)],
);
check(
  "image is served inline",
  (rawImage.headers.get("content-disposition") ?? "").includes("inline"),
  rawImage.headers.get("content-disposition"),
);

writeFileSync(join(work, "assets", "mislabelled.txt"), PNG_BYTES);
await git(["add", "."], work);
await git([...IDENTITY, "commit", "-q", "-m", "mislabelled image"], work);
await git(["push", "-q", "origin", "main"], work);
const mislabelled = await fetch(`${BASE}/api/repos/${username}/demo/raw?path=assets/mislabelled.txt&ref=main`);
check(
  "a PNG named .txt is served as image/png",
  mislabelled.headers.get("content-type") === "image/png",
  mislabelled.headers.get("content-type"),
);

const enrichedCommits = await api<{ items: Array<{ sha: string; message: string }> }>(
  `/api/repos/${username}/demo/commits?ref=main`,
);
const renameSha = enrichedCommits.data.items.find((entry) => entry.message === "rename build script")?.sha;
check(
  "rename commit is listed",
  Boolean(renameSha),
  enrichedCommits.data.items.map((entry) => entry.message).slice(0, 5),
);

if (renameSha) {
  const renameDiff = await api<{ files: Array<{ path: string; old_path: string | null; status: string }> }>(
    `/api/repos/${username}/demo/commits/${renameSha}/diff`,
  );
  const renamed = renameDiff.data.files.find((entry) => entry.status === "renamed");
  check("commit diff detects the rename", Boolean(renamed), renameDiff.data.files);
  check("rename reports the previous path", renamed?.old_path === "scripts/build.sh", renamed);

  const detail = await api<{ sha: string; files: Array<{ path: string }> }>(
    `/api/repos/${username}/demo/commits/${renameSha}`,
  );
  check("commit detail lists changed files", (detail.data.files?.length ?? 0) >= 1, detail.data.files?.length);
}

const range = await api<{ files: Array<{ path: string }> }>(
  `/api/repos/${username}/demo/diff?base=HEAD~3&head=HEAD`,
);
check("range diff returns files", (range.data.files?.length ?? 0) >= 1, range.data.files?.length);

const blame = await api<{
  lines: Array<{ sha: string; line_number: number }>;
  path: string;
  language: string | null;
}>(`/api/repos/${username}/demo/blame?path=src/app.ts&ref=main`);
check("blame attributes every line", (blame.data.lines?.length ?? 0) >= 4, blame.data.lines?.length);
check("blame reports the path", blame.data.path === "src/app.ts", blame.data.path);
check("blame resolves a language", blame.data.language === "typescript", blame.data.language);
check(
  "blame lines carry commit shas",
  /^[0-9a-f]{7,}$/.test(blame.data.lines?.[0]?.sha ?? ""),
  blame.data.lines?.[0],
);

console.log("\n[12] git CLI interop");

const interop = join(scratch, "interop");
const interopClone = await git(["clone", "-q", `${BASE}/${username}/demo.git`, interop], scratch);
check("clone succeeds", interopClone.code === 0, interopClone.out);

const tracked = (await git(["ls-files"], interop)).out;
check("clone contains the renamed path", tracked.includes("scripts/release.sh"), tracked.split("\n").slice(0, 8));
check("clone no longer contains the old path", !tracked.includes("scripts/build.sh"));
check("clone contains the image", tracked.includes("assets/dot.png"));

const localLog = (await git(["log", "--format=%s"], interop)).out;
check("clone contains the earlier pull request's work", tracked.includes("feature.txt"), tracked.split("\n").slice(0, 8));
check("clone history includes the rename", localLog.includes("rename build script"));

const localBlame = await git(["blame", "--porcelain", "src/app.ts"], interop);
check(
  "git blame works against the clone",
  localBlame.code === 0 && localBlame.out.includes("greet"),
  localBlame.out.slice(0, 60),
);

await git(["checkout", "-q", "-b", "diverged"], work);
writeFileSync(join(work, "diverged.txt"), "branch side\n");
await git(["add", "."], work);
await git([...IDENTITY, "commit", "-q", "-m", "branch side change"], work);
await git(["push", "-q", "-u", "origin", "diverged"], work);

await git(["checkout", "-q", "main"], work);
writeFileSync(join(work, "main-side.txt"), "main side\n");
await git(["add", "."], work);
await git([...IDENTITY, "commit", "-q", "-m", "main side change"], work);
await git(["push", "-q", "origin", "main"], work);

const divergedPull = await api<{ number: number }>(`/api/repos/${username}/demo/pulls`, {
  method: "POST",
  body: JSON.stringify({ title: "Diverged merge", head: "diverged", base: "main" }),
});
check("diverged pull created", divergedPull.status === 201, divergedPull.data);

const divergedMerge = await api<{ merged: boolean; sha: string; fastForward: boolean }>(
  `/api/repos/${username}/demo/pulls/${divergedPull.data.number}/merge`,
  { method: "POST", body: "{}" },
);
check("diverged pull merged", divergedMerge.data.merged === true, divergedMerge.data);
check("diverged merge was not a fast-forward", divergedMerge.data.fastForward === false, divergedMerge.data);

await git(["fetch", "-q", "origin"], interop);
const parents = (await git(["rev-list", "--parents", "-n", "1", divergedMerge.data.sha], interop)).out
  .trim()
  .split(/\s+/);
check("server-side merge is a real two-parent commit", parents.length === 3, parents.map((sha) => sha.slice(0, 8)));

const ancestor = await git(["merge-base", "--is-ancestor", divergedMerge.data.sha, "origin/main"], interop);
check("merge is reachable from a fetched origin/main", ancestor.code === 0, ancestor.code);

await git(["checkout", "-q", "-B", "verify-merge", "origin/main"], interop);
const mergedTree = (await git(["ls-files"], interop)).out;
check(
  "merged tree contains both sides",
  mergedTree.includes("diverged.txt") && mergedTree.includes("main-side.txt"),
  mergedTree.split("\n").filter((file) => file.includes("side") || file.includes("diverged")),
);

await git(["fetch", "-q", "origin"], work);
await git(["reset", "--hard", "-q", "origin/main"], work);

writeFileSync(join(work, "after-merge.txt"), "post merge\n");
await git(["add", "."], work);
await git([...IDENTITY, "commit", "-q", "-m", "commit after merge"], work);
const postMergePush = await git(["push", "-q", "origin", "main"], work);
check("push works after a server-side merge", postMergePush.code === 0, postMergePush.out);

console.log("\n[13] source archives and list payloads");

async function listingOf(bytes: Uint8Array, label: string): Promise<string[]> {
  const dir = join(scratch, `x-${label}`);
  mkdirSync(dir, { recursive: true });
  const file = join(scratch, `${label}.archive`);
  writeFileSync(file, bytes);
  const proc = Bun.spawn([process.env.GITGOOD_TEST_TAR ?? "tar", "-xf", file, "-C", dir], { stdout: "pipe", stderr: "pipe" });
  const [stderr, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
  if (code !== 0) throw new Error(`tar failed for ${label}: ${stderr}`);
  const found: string[] = [];
  const walk = (directory: string, prefix: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(join(directory, entry.name), relative);
      else found.push(relative);
    }
  };
  walk(dir, "");
  return found.sort();
}

const tarball = await fetch(`${BASE}/api/repos/${username}/demo/archive?ref=main&format=tar.gz`);
check("tar.gz archive is served", tarball.status === 200, tarball.status);
check(
  "tar.gz declares gzip and an attachment",
  (tarball.headers.get("content-type") ?? "").includes("gzip") &&
    (tarball.headers.get("content-disposition") ?? "").includes("attachment"),
  tarball.headers.get("content-disposition"),
);
const tarBytes = new Uint8Array(await tarball.arrayBuffer());
check("tar.gz has gzip magic bytes", tarBytes[0] === 0x1f && tarBytes[1] === 0x8b, [...tarBytes.slice(0, 2)]);
const tarListing = await listingOf(tarBytes, "targz");
check("tarball extracts with the repository contents", tarListing.includes("main/README.md"), tarListing.slice(0, 6));
check("tarball includes the renamed script", tarListing.includes("main/scripts/release.sh"), tarListing.slice(0, 8));

const zipDownload = await fetch(`${BASE}/api/repos/${username}/demo/archive?ref=main&format=zip`);
check("zip archive is served", zipDownload.status === 200, zipDownload.status);
const zipBytes = new Uint8Array(await zipDownload.arrayBuffer());
check("zip has PK magic bytes", zipBytes[0] === 0x50 && zipBytes[1] === 0x4b, [...zipBytes.slice(0, 2)]);
const zipListing = await listingOf(zipBytes, "zip");
check("zip extracts to the same tree", zipListing.includes("main/README.md"), zipListing.slice(0, 6));
check("both formats contain the same files", tarListing.join(",") === zipListing.join(","));

const missingArchive = await fetch(`${BASE}/api/repos/${username}/demo/archive?ref=not-a-real-branch`);
check("archive of an unknown ref is 404", missingArchive.status === 404, missingArchive.status);
const badFormat = await fetch(`${BASE}/api/repos/${username}/demo/archive?format=rar`);
check("unsupported archive format is 400", badFormat.status === 400, badFormat.status);

const bigBody = "z".repeat(6000);
await api(`/api/repos/${username}/demo/issues`, {
  method: "POST",
  body: JSON.stringify({ title: "Large body issue", body: bigBody }),
});
const issueList = await api<{
  items: Array<{ number: number; body?: string; body_preview?: string; body_truncated?: boolean }>;
}>(`/api/repos/${username}/demo/issues?state=open`);
const bigOne = issueList.data.items.find((item) => item.body_truncated === true);
check("issue list omits the full body", issueList.data.items.every((item) => item.body === undefined), {
  sample: issueList.data.items[0],
});
check("issue list carries a preview instead", typeof bigOne?.body_preview === "string", bigOne?.body_preview?.length);
check(
  "the preview is bounded well below the stored body",
  (bigOne?.body_preview?.length ?? 0) < bigBody.length / 10,
  bigOne?.body_preview?.length,
);

const issueDetail = await api<{ body: string }>(`/api/repos/${username}/demo/issues/${bigOne?.number}`);
check("issue detail still returns the whole body", issueDetail.data.body.length === bigBody.length, issueDetail.data.body.length);

console.log(
  `\nserver RSS: ${(stats.data.process.rssBytes / 1024 / 1024).toFixed(1)} MiB, ` +
    `cpu: ${stats.data.process.cpuPercent}%, http p99: ${stats.data.histograms.http_request_ms?.p99} ms`,
);

rmSync(scratch, { recursive: true, force: true });
console.log(failures === 0 ? "\nE2E PASSED" : `\nE2E FAILED (${failures} checks)`);
process.exit(failures === 0 ? 0 : 1);

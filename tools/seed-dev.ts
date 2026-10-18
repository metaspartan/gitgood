import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const arg = (name: string, fallback: number): number => {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : Number(process.argv[index + 1]);
};

const REPOS = arg("repos", 400);
const COMMITS = arg("commits", 1500);
const FILES = arg("files", 1200);
const ISSUES = arg("issues", 260);
const PULLS = arg("pulls", 140);

const root = process.env.GITGOOD_DATA_DIR ?? join(process.env.TEMP ?? ".", "gitgood-seed");
const repoRoot = join(root, "repos");
rmSync(root, { recursive: true, force: true });
mkdirSync(repoRoot, { recursive: true });
process.env.GITGOOD_DATA_DIR = root;
process.env.GITGOOD_REPO_ROOT = repoRoot;
process.env.GITGOOD_LFS_ROOT = join(root, "lfs");
process.env.GITGOOD_CI_MODE = "disabled";
process.env.GITGOOD_ADMIN_PASSWORD = "seed-admin-password";

const { db, migrate } = await import("../src/db/index.ts");
const { createUser } = await import("../src/auth/service.ts");
const { hashedRepositoryPath, initBareRepository } = await import("../src/git/repo.ts");
const { createRepository, findRepo } = await import("../src/data/repos.ts");
const { createIssue } = await import("../src/data/issues.ts");
const { createPull } = await import("../src/data/pulls.ts");
const { createLabel, setIssueLabels } = await import("../src/data/labels.ts");

migrate();
const started = Date.now();
const log = (message: string): void => console.log(`[${((Date.now() - started) / 1000).toFixed(1)}s] ${message}`);

const admin = await createUser({
  username: "seed",
  email: "seed@example.test",
  password: "seed-admin-password",
  displayName: "Seed Admin",
});
const principal = {
  kind: "user",
  userId: admin.id,
  username: admin.username,
  isAdmin: true,
  via: "session",
  scopes: ["admin"],
  tokenRepoId: null,
} as never;

const git = (cwd: string, args: string[]): void => {
  const result = spawnSync("git", args, { cwd, stdio: "pipe", encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed in ${cwd}: ${result.stderr || result.stdout}`);
  }
};

const people = [admin];
for (let i = 0; i < 8; i += 1) {
  people.push(
    await createUser({
      username: `dev${i + 1}`,
      email: `dev${i + 1}@example.test`,
      password: "seed-member-password",
      displayName: `Dev ${i + 1}`,
    }),
  );
}
const org = db
  .query(
    "INSERT INTO orgs (name, display_name, avatar_hue, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
  )
  .run("seedorg", "Seed Organisation", 200, admin.id, Date.now(), Date.now());
const orgId = Number(org.lastInsertRowid);
for (const person of people.slice(0, 4)) {
  db.query("INSERT OR IGNORE INTO org_members (org_id, user_id, role, created_at) VALUES (?, ?, ?, ?)")
    .run(orgId, person.id, people.indexOf(person) === 0 ? "owner" : "member", Date.now());
}
log(`${people.length} users and one organisation`);

interface SeedRepo { id: number; name: string; owner: string; disk: string }
const seeded: SeedRepo[] = [];

function insertRepo(name: string, ownerId: number, ownerName: string, isOrg: boolean): SeedRepo {
  const timestamp = Date.now() - Math.floor(Math.random() * 1000 * 60 * 60 * 24 * 90);
  const result = db
    .query(
      `INSERT INTO repos (owner_id, name, description, visibility, default_branch, lfs_enabled, archived, created_at, updated_at, disk_path, org_id)
       VALUES (?, ?, ?, 'public', 'main', 0, 0, ?, ?, ?, ?)`,
    )
    .run(
      ownerId,
      name,
      `Seeded repository ${name} used to measure how the list page behaves with real rows.`,
      timestamp,
      timestamp,
      hashedRepositoryPath(ownerName, name),
      isOrg ? orgId : null,
    );
  return { id: Number(result.lastInsertRowid), name, owner: ownerName, disk: hashedRepositoryPath(ownerName, name) };
}

for (let i = 0; i < REPOS; i += 1) {
  const owner = people[i % Math.min(people.length, 4)]!;
  const isOrg = i % 9 === 0;
  const record = insertRepo(`seeded-repo-${i.toString().padStart(4, "0")}`, owner.id, isOrg ? "seedorg" : owner.username, isOrg);
  if (i % 5 === 0) db.query("UPDATE repos SET visibility = 'private' WHERE id = ?").run(record.id);
  if (i % 17 === 0) db.query("UPDATE repos SET archived = 1 WHERE id = ?").run(record.id);
  if (i % 7 === 0) db.query("UPDATE repos SET description = '' WHERE id = ?").run(record.id);
  seeded.push(record);
  if ((i + 1) % 100 === 0) log(`${i + 1}/${REPOS} repositories`);
}
log(`${REPOS} repositories inserted`);

const bigName = "large-repository";
const big = await createRepository(principal, {
  name: bigName,
  description: `${FILES} files across ${COMMITS} commits. This is the repository that makes the slow paths slow.`,
  visibility: "public",
});
const bigDisk = join(repoRoot, "large");
rmSync(bigDisk, { recursive: true, force: true });
await initBareRepository(bigDisk, "main");

const work = join(root, "work-large");
mkdirSync(work, { recursive: true });
git(work, ["init", "-q", "-b", "main"]);
git(work, ["config", "user.email", "seed@example.test"]);
git(work, ["config", "user.name", "Seed"]);

const fileCount = Math.max(FILES, 1);
for (let i = 0; i < fileCount; i += 1) {
  const group = `src/module-${(i % 40).toString().padStart(2, "0")}`;
  mkdirSync(join(work, group), { recursive: true });
  const depth = i % 3;
  const path = depth === 0 ? `${group}/file-${i}.ts` : `${group}/nested/deep/file-${i}.ts`;
  mkdirSync(join(work, group, "nested", "deep"), { recursive: true });
  writeFileSync(
    join(work, path),
    Array.from({ length: 60 }, (_, line) => `export const value${line} = ${line} * 2; // file ${i}`).join("\n"),
  );
}
git(work, ["add", "-A"]);
git(work, ["commit", "-q", "-m", `Import ${fileCount} files`]);
log(`${fileCount} files committed`);

for (let c = 1; c < COMMITS; c += 1) {
  const target = `src/module-${(c % 40).toString().padStart(2, "0")}/file-${c % fileCount}.ts`;
  const path = join(work, target);
  if (!Bun.file(path).size) continue;
  writeFileSync(path, `${Bun.file(path).text()}\n// change ${c}\n`);
  const add = spawnSync("git", ["add", target], { cwd: work, stdio: "pipe" });
  if (add.status !== 0) continue;
  const commit = spawnSync(
    "git",
    ["commit", "-q", "--no-verify", "-m", `Change ${c}: adjust module ${c % 40}`],
    { cwd: work, stdio: "pipe" },
  );
  if (commit.status !== 0) continue;
  if (c % 250 === 0) log(`${c}/${COMMITS} commits`);
}
log(`${COMMITS} commits written`);

const tip = spawnSync("git", ["rev-parse", "HEAD"], { cwd: work, stdio: "pipe", encoding: "utf8" }).stdout.trim();
git(bigDisk, ["fetch", "-q", work, "main:refs/heads/main"]);
db.query("UPDATE repos SET disk_path = ? WHERE id = ?").run(bigDisk, big.id);
const bigRepo = findRepo(admin.username, bigName);
if (!bigRepo) throw new Error("the large repository vanished after creation");
void tip;
log("large repository pushed");

const LABELS = [
  ["bug", "d73a4a"],
  ["documentation", "0075ca"],
  ["enhancement", "a2eeef"],
  ["good first issue", "7057ff"],
  ["help wanted", "008672"],
  ["question", "d876e3"],
] as const;
for (const [name, color] of LABELS) createLabel(bigRepo.id, name, color);

for (let i = 1; i <= ISSUES; i += 1) {
  const issue = createIssue(bigRepo, people[i % people.length]!.id, {
    title: `Seeded issue ${i}: something that needed doing`,
    body: `Body for issue ${i}.\n\nIt has a paragraph of prose, a list:\n\n- first\n- second\n\nand some \`code\` to make the Markdown renderer work.`,
  });
  if (i % 4 !== 0) setIssueLabels(bigRepo.id, issue.id, [LABELS[i % LABELS.length]![0]]);
  db.query("UPDATE issues SET created_at = ?, updated_at = ? WHERE id = ?")
    .run(Date.now() - i * 3_600_000, Date.now() - i * 3_600_000, issue.id);
  if (i % 3 === 0) db.query("UPDATE issues SET state = 'closed', closed_at = ? WHERE id = ?").run(Date.now(), issue.id);
  if (i % 5 === 0) {
    const assignee = people[i % people.length]!.id;
    db.query("INSERT OR IGNORE INTO issue_assignees (issue_id, user_id, assigned_at, assigned_by) VALUES (?, ?, ?, ?)")
      .run(issue.id, assignee, Date.now(), admin.id);
  }
}
log(`${ISSUES} issues`);

const prWork = join(root, "work-pr");
rmSync(prWork, { recursive: true, force: true });
mkdirSync(prWork, { recursive: true });
git(prWork, ["clone", "-q", bigDisk, "."]);
git(prWork, ["config", "user.email", "seed@example.test"]);
git(prWork, ["config", "user.name", "Seed"]);
for (let p = 1; p <= PULLS; p += 1) {
  const branch = `seeded-pr-${p}`;
  git(prWork, ["checkout", "-q", "-b", branch, "main"]);
  writeFileSync(join(prWork, `pr-${p}.md`), `# Pull request ${p}\n\nA seeded change.\n`);
  git(prWork, ["add", "-A"]);
  git(prWork, ["commit", "-q", "-m", `Add pull request ${p}`]);
  git(prWork, ["push", "-q", "origin", `HEAD:refs/heads/${branch}`]);
  const pull = await createPull(bigRepo, people[p % people.length]!.id, {
    title: `Seeded pull request ${p}`,
    head: branch,
    base: "main",
  });
  db.query("UPDATE pulls SET created_at = ?, updated_at = ? WHERE id = ?")
    .run(Date.now() - p * 7_200_000, Date.now() - p * 7_200_000, pull.id);
  if (p % 3 === 0) {
    db.query("UPDATE pulls SET state = 'merged', merged_at = ?, merged_sha = ? WHERE id = ?")
      .run(Date.now(), "0".repeat(40), pull.id);
  }
  git(prWork, ["checkout", "-q", "main"]);
}
git(prWork, ["push", "-q", "origin", "main:refs/heads/main"]);
log(`${PULLS} pull requests`);

log(`done in ${((Date.now() - started) / 1000).toFixed(1)}s`);
console.log(`\ndata dir: ${root}`);
console.log(`sign in as: seed / seed-admin-password`);
const count = (table: string): number =>
  (db.query(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
console.log(`repos: ${count("repos")}`);
console.log(`issues: ${count("issues")}`);
console.log(`pulls: ${count("pulls")}`);

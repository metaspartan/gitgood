import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "gg-bench-"));
process.env.GITGOOD_DATA_DIR = dir;
process.env.GITGOOD_REPO_ROOT = join(dir, "repos");
process.env.GITGOOD_LFS_ROOT = join(dir, "lfs");
process.env.GITGOOD_CI_MODE = "disabled";

const { db, migrate } = await import("../src/db/index.ts");
const { createRepository } = await import("../src/data/repos.ts");
const { createIssue, listIssues } = await import("../src/data/issues.ts");
const { labelNamesForIssue, labelNamesForIssues } = await import("../src/data/labels.ts");

migrate();
db.query(
  "INSERT INTO users (username, email, display_name, password_hash, is_admin, avatar_hue, created_at) VALUES (?, ?, ?, ?, 1, 0, ?)",
).run("bench", "bench@example.test", "Bench", "not-a-real-hash", Date.now());
const user = db.query("SELECT id FROM users WHERE username = 'bench'").get() as { id: number };
const principal = {
  kind: "user",
  userId: user.id,
  username: "bench",
  isAdmin: true,
  via: "session",
  scopes: ["admin"],
  tokenRepoId: null,
} as never;

const repo = await createRepository(principal, { name: `bench${Date.now().toString(36)}` });

const LABELS = ["bug", "documentation", "enhancement", "good first issue", "help wanted"];
const TOTAL = 30;
let labelled = 0;
for (let i = 1; i <= TOTAL; i += 1) {
  const issue = createIssue(repo, user.id, { title: `issue ${i}`, body: "x" });
  if (i % 3 !== 0) {
    const name = LABELS[i % LABELS.length]!;
    db.query("INSERT OR IGNORE INTO labels (repo_id, name, color) VALUES (?, ?, '888888')").run(repo.id, name);
    const label = db.query("SELECT id FROM labels WHERE repo_id = ? AND name = ?").get(repo.id, name) as { id: number };
    db.query("INSERT OR IGNORE INTO issue_labels (issue_id, label_id) VALUES (?, ?)").run(issue.id, label.id);
    labelled += 1;
  }
}

let executions = 0;
const originalPrepare = db.prepare.bind(db);
db.prepare = ((sql: string) => {
  const statement = originalPrepare(sql);
  const target = statement as unknown as Record<string, unknown>;
  for (const method of ["all", "get", "run"] as const) {
    const original = (target[method] as (...a: unknown[]) => unknown).bind(statement);
    target[method] = (...args: unknown[]) => {
      executions += 1;
      return original(...args);
    };
  }
  return statement;
}) as typeof db.prepare;

function measure(run: () => unknown): { executions: number; ms: number } {
  executions = 0;
  const start = performance.now();
  run();
  return { executions, ms: performance.now() - start };
}

labelNamesForIssue(1);
labelNamesForIssues([1]);

const items = listIssues(repo.id, { state: "open", limit: 30, offset: 0 });
const ids = items.map((issue) => issue.id);

let perRow: string[][] = [];
const before = measure(() => {
  perRow = ids.map((id) => labelNamesForIssue(id));
});
const after = measure(() => labelNamesForIssues(ids));

console.log(`page size             ${ids.length} issues (default per_page)`);
console.log(`before: per-row       ${before.executions} executions, ${before.ms.toFixed(2)} ms`);
console.log(`after:  batched       ${after.executions} execution, ${after.ms.toFixed(2)} ms`);
console.log(`saved                 ${before.executions - after.executions} executions, ${(before.ms - after.ms).toFixed(2)} ms`);
console.log(`labelled issues      ${perRow.filter((names) => names.length > 0).length} of ${ids.length} (${labelled} assigned)`);

rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });

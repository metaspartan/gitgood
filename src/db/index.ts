import { Database, type SQLQueryBindings, type Statement } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { config } from "../config.ts";
import { markDatabaseOpen } from "../lib/open-databases.ts";

mkdirSync(config.dataDir, { recursive: true });
mkdirSync(config.repoRoot, { recursive: true });
mkdirSync(config.lfsRoot, { recursive: true });
mkdirSync(dirname(config.dbPath), { recursive: true });

export const db = new Database(config.dbPath, { create: true, strict: true });
markDatabaseOpen(config.dbPath);

db.exec("PRAGMA journal_mode = WAL;");
db.exec("PRAGMA synchronous = NORMAL;");
db.exec("PRAGMA foreign_keys = ON;");
db.exec("PRAGMA busy_timeout = 5000;");
db.exec("PRAGMA cache_size = -16000;");
db.exec("PRAGMA temp_store = MEMORY;");
db.exec("PRAGMA mmap_size = 268435456;");

let migrated = false;

function addColumnIfMissing(table: string, column: string, definition: string): void {
  const columns = db.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (columns.some((entry) => entry.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

function backfillSearchIndex(): void {
  const rebuild = (fts: string, content: string): void => {
    const indexed = one<{ c: number }>(`SELECT COUNT(*) AS c FROM ${fts}`);
    if ((indexed?.c ?? 0) > 0) return;
    const rows = one<{ c: number }>(`SELECT COUNT(*) AS c FROM ${content}`);
    if ((rows?.c ?? 0) === 0) return;
    db.exec(`INSERT INTO ${fts}(${fts}) VALUES('rebuild')`);
  };

  rebuild("issues_fts", "issues");
  rebuild("pulls_fts", "pulls");
}
export function migrate(): void {
  if (migrated) return;
  const schema = require("node:fs").readFileSync(
    new URL("./schema.sql", import.meta.url),
    "utf8",
  ) as string;
  db.exec(schema);

  addColumnIfMissing("webhook_deliveries", "attempts", "INTEGER NOT NULL DEFAULT 1");
  addColumnIfMissing("webhook_deliveries", "duration_ms", "INTEGER NOT NULL DEFAULT 0");

  addColumnIfMissing("ci_runs", "pull_id", "INTEGER REFERENCES pulls(id) ON DELETE SET NULL");

  addColumnIfMissing("repos", "org_id", "INTEGER REFERENCES orgs(id) ON DELETE CASCADE");
  addColumnIfMissing("repos", "fork_of", "INTEGER REFERENCES repos(id) ON DELETE SET NULL");
  addColumnIfMissing("repos", "quota_bytes", "INTEGER");
  addColumnIfMissing("repos", "over_quota_at", "INTEGER");

  addColumnIfMissing("users", "totp_secret", "TEXT");
  addColumnIfMissing("users", "totp_confirmed_at", "INTEGER");
  addColumnIfMissing("users", "totp_last_step", "INTEGER");
  addColumnIfMissing("users", "credentials_changed_at", "INTEGER");
  addColumnIfMissing("users", "is_bootstrap", "INTEGER NOT NULL DEFAULT 0");

  addColumnIfMissing("repos", "disk_path", "TEXT");

  db.exec(
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_repos_org_name
       ON repos(org_id, name) WHERE org_id IS NOT NULL`,
  );

  db.exec(
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_orgs_name_unique ON orgs(name COLLATE NOCASE)`,
  );

  db.exec("DROP TABLE IF EXISTS repo_git_policy");

  db.exec(require("node:fs").readFileSync(new URL("./migrations/001_pull_reviews.sql", import.meta.url), "utf8"));
  db.exec(require("node:fs").readFileSync(new URL("./migrations/002_branch_protection.sql", import.meta.url), "utf8"));
  db.exec(require("node:fs").readFileSync(new URL("./migrations/003_repo_collaborators.sql", import.meta.url), "utf8"));
  db.exec(require("node:fs").readFileSync(new URL("./migrations/004_milestones.sql", import.meta.url), "utf8"));
  db.exec(require("node:fs").readFileSync(new URL("./migrations/005_assignees.sql", import.meta.url), "utf8"));
  db.exec(require("node:fs").readFileSync(new URL("./migrations/006_topics.sql", import.meta.url), "utf8"));
  db.exec(require("node:fs").readFileSync(new URL("./migrations/007_thread_events.sql", import.meta.url), "utf8"));
  db.exec(require("node:fs").readFileSync(new URL("./migrations/008_lfs_repo_objects.sql", import.meta.url), "utf8"));
  db.exec(require("node:fs").readFileSync(new URL("./migrations/009_runners_admin.sql", import.meta.url), "utf8"));
  addColumnIfMissing("users", "blocked_at", "INTEGER");
  addColumnIfMissing("sessions", "ip", "TEXT");
  addColumnIfMissing("comments", "updated_at", "INTEGER");
  db.exec(`CREATE TABLE IF NOT EXISTS reactions (
    comment_id INTEGER NOT NULL REFERENCES comments(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    content TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (comment_id, user_id, content)
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS push_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    repo_id INTEGER NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    commits INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  )`);
  db.exec("CREATE INDEX IF NOT EXISTS idx_push_events_user ON push_events(user_id, created_at)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_comments_author ON comments(author_id, created_at)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_issues_author ON issues(author_id, created_at)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_pulls_author ON pulls(author_id, created_at)");
  addColumnIfMissing("sessions", "user_agent", "TEXT");
  addColumnIfMissing("sessions", "last_seen_at", "INTEGER");
  db.exec(`CREATE TABLE IF NOT EXISTS admin_audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    actor_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    actor_username TEXT NOT NULL,
    action TEXT NOT NULL,
    target TEXT NOT NULL DEFAULT '',
    detail TEXT NOT NULL DEFAULT '',
    ip TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL
  )`);
  db.exec("CREATE INDEX IF NOT EXISTS idx_admin_audit_created ON admin_audit_log(created_at DESC)");
  addColumnIfMissing("watches", "level", "TEXT NOT NULL DEFAULT 'all'");
  addColumnIfMissing("repos", "actions_enabled", "INTEGER NOT NULL DEFAULT 1");
  addColumnIfMissing("ci_runs", "executor", "TEXT NOT NULL DEFAULT 'local'");
  addColumnIfMissing("ci_runs", "runner_id", "INTEGER REFERENCES ci_runners(id) ON DELETE SET NULL");
  addColumnIfMissing("ci_runs", "heartbeat_at", "INTEGER");
  db.exec("CREATE INDEX IF NOT EXISTS idx_ci_runs_queue ON ci_runs(executor, status, id)");

  addColumnIfMissing("issues", "milestone_id", "INTEGER REFERENCES milestones(id) ON DELETE SET NULL");
  addColumnIfMissing("pulls", "milestone_id", "INTEGER REFERENCES milestones(id) ON DELETE SET NULL");
  db.exec("CREATE INDEX IF NOT EXISTS idx_issues_milestone ON issues(milestone_id)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_pulls_milestone ON pulls(milestone_id)");

  addColumnIfMissing("pulls", "merge_comparison", "TEXT");
  addColumnIfMissing("access_tokens", "repo_id", "INTEGER REFERENCES repos(id) ON DELETE CASCADE");
  db.exec("CREATE INDEX IF NOT EXISTS idx_tokens_repo ON access_tokens(repo_id)");
  db.exec("CREATE TABLE IF NOT EXISTS instance_settings (key TEXT PRIMARY KEY, value INTEGER NOT NULL CHECK (value >= 0 AND value <= 1125899906842624))");
  db.prepare("INSERT OR IGNORE INTO instance_settings (key, value) VALUES ('lfs_link_cutoff', ?)").run(Date.now());
  db.exec("CREATE TABLE IF NOT EXISTS instance_appearance (id INTEGER PRIMARY KEY CHECK(id=1), theme TEXT NOT NULL)");
  backfillSearchIndex();
  migrated = true;
}

const statementCache = new Map<string, Statement>();
const MAX_CACHED_STATEMENTS = 512;


function prepare(sql: string): Statement {
  const cached = statementCache.get(sql);
  if (cached) return cached;
  const stmt = db.prepare(sql);
  if (statementCache.size >= MAX_CACHED_STATEMENTS) {
    const oldest = statementCache.keys().next().value;
    if (oldest !== undefined) {
      statementCache.get(oldest)?.finalize();
      statementCache.delete(oldest);
    }
  }
  statementCache.set(sql, stmt);
  return stmt;
}

export function all<T>(sql: string, ...params: SQLQueryBindings[]): T[] {
  return prepare(sql).all(...params) as T[];
}

export function one<T>(sql: string, ...params: SQLQueryBindings[]): T | null {
  const row = prepare(sql).get(...params);
  return (row as T | undefined) ?? null;
}

export function run(sql: string, ...params: SQLQueryBindings[]): number {
  const info = prepare(sql).run(...params);
  return Number(info.lastInsertRowid);
}

export function changes(sql: string, ...params: SQLQueryBindings[]): number {
  return prepare(sql).run(...params).changes;
}

export function transaction<T>(fn: () => T): T {
  return db.transaction(fn)();
}

export function now(): number {
  return Date.now();
}

export function scalar<T extends number | string | null>(
  sql: string,
  ...params: SQLQueryBindings[]
): T {
  const row = prepare(sql).get(...params) as Record<string, unknown> | undefined;
  if (!row) return null as T;
  const values = Object.values(row);
  return (values[0] as T) ?? (null as T);
}

import { Database } from "bun:sqlite";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const SEED_FLAG = "--seed";
const ROUNDTRIP_FLAG = "--roundtrip";

const runId =
  process.env.GITGOOD_CHECK_MARKER ??
  `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
const MARKER_USER = `restore-check-${runId}`;
const MARKER_REPO_CONTENT = "repository payload";

interface BackupManifest {
  format: number;
  label: string;
  createdAt: string;
  database: { file: string; bytes: number };
  repositories: { count: number; bytes: number };
  lfs: { objects: number; files: number; bytes: number };
}

const results: boolean[] = [];

function ok(label: string, condition: boolean, detail?: unknown): boolean {
  if (condition) console.log(`  ok    ${label}`);
  else console.log(`  FAIL  ${label}${detail === undefined ? "" : ` :: ${JSON.stringify(detail)}`}`);
  results.push(condition);
  return condition;
}

function verdict(): number {
  const passed = results.length > 0 && results.every(Boolean);
  console.log(
    `\n${passed ? "PASS" : "FAIL"} - ${results.filter(Boolean).length}/${results.length} checks`,
  );
  return passed ? 0 : 1;
}

async function seed(): Promise<number> {
  const { config } = await import("../src/config.ts");
  const { db, migrate, run, scalar } = await import("../src/db/index.ts");

  migrate();

  run(
    "INSERT INTO users (username, email, display_name, password_hash, is_admin, avatar_hue, created_at) VALUES (?, ?, ?, ?, 0, 0, ?)",
    MARKER_USER,
    `${MARKER_USER}@example.com`,
    MARKER_USER,
    "hash",
    Date.now(),
  );

  const repoPath = join(config.repoRoot, "checkowner", "checkrepo.git");
  mkdirSync(repoPath, { recursive: true });
  writeFileSync(join(repoPath, "HEAD"), "ref: refs/heads/main\n");
  writeFileSync(join(repoPath, "payload.txt"), MARKER_REPO_CONTENT);

  console.log("1. Seed the instance");
  ok("a user row was written", (scalar<number>("SELECT COUNT(*) FROM users WHERE username = ?", MARKER_USER) ?? 0) === 1);
  ok("a repository was written to disk", existsSync(join(repoPath, "payload.txt")));
  console.log("   (this process now exits, releasing the database handle)");
  db.close();
  console.log(`\n${verdict() === 0 ? "PASS" : "FAIL"} - seed phase`);
  return results.every(Boolean) ? 0 : 1;
}

async function roundtrip(): Promise<number> {
  const { config } = await import("../src/config.ts");
  const { runBackup, runRestore } = await import("../src/lib/backup.ts");

  const repoPath = join(config.repoRoot, "checkowner", "checkrepo.git");
  const backupDir = join(config.dataDir, "check-backup");

  console.log("2. Back up");
  const manifest = await runBackup({ outDir: backupDir, label: `restore-check-${runId}` });
  ok("the backup wrote a database", existsSync(join(backupDir, manifest.database.file)));
  ok("the backup wrote a repositories tree", existsSync(join(backupDir, "repositories")));
  ok("the backed-up database is non-empty", manifest.database.bytes > 0, manifest.database.bytes);

  console.log("\n3. Destroy the live state (the disaster this is meant to survive)");
  for (const suffix of ["", "-wal", "-shm"]) {
    const p = `${config.dbPath}${suffix}`;
    if (existsSync(p)) rmSync(p, { force: true });
  }
  rmSync(config.repoRoot, { recursive: true, force: true });
  rmSync(config.lfsRoot, { recursive: true, force: true });
  ok("the live database is gone", !existsSync(config.dbPath));
  ok("the live repository is gone", !existsSync(join(repoPath, "payload.txt")));

  console.log("\n4. Restore");
  const result = runRestore({ from: backupDir, force: true });
  ok("the restore reports the database written", result.restored.database);
  ok("the restore reports the repository tree written", result.restored.repositories);
  ok("no SQLite sidecars were left pending", result.sidecarsPending.length === 0, result.sidecarsPending);

  console.log("\n5. Verify the data came back");
  ok("the restored database file exists", existsSync(config.dbPath));
  ok("the restored repository is on disk", existsSync(join(repoPath, "payload.txt")));

  const reopened = new Database(config.dbPath, { readonly: true });
  try {
    const integrity = reopened.query("PRAGMA integrity_check").get() as { integrity_check: string };
    ok("the restored database passes SQLite's integrity check", integrity.integrity_check === "ok", integrity);

    const found = reopened.query("SELECT username FROM users WHERE username = ?").get(MARKER_USER) as
      | { username: string }
      | undefined;
    ok("the user row written before the backup is present after the restore", found?.username === MARKER_USER);

    const bytes = statSync(config.dbPath).size;
    ok("the restored database matches the manifest size", bytes === manifest.database.bytes, {
      bytes,
      manifest: manifest.database.bytes,
    });
  } finally {
    reopened.close();
  }

  const payload = readFileSync(join(repoPath, "payload.txt"), "utf8");
  ok("the repository content is byte-identical", payload === MARKER_REPO_CONTENT);

  return verdict();
}

function inspect(backupDir: string): number {
  const from = resolve(backupDir);
  console.log(`Inspecting backup at ${from}\n`);

  const manifestPath = join(from, "manifest.json");
  if (!ok("manifest.json is present", existsSync(manifestPath))) return verdict();

  let manifest: BackupManifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as BackupManifest;
  } catch (error) {
    console.log(`  FAIL  manifest.json is not valid JSON :: ${error instanceof Error ? error.message : "unknown"}`);
    return 1;
  }
  console.log(`        label "${manifest.label}" created ${manifest.createdAt}, format ${manifest.format}`);

  const dbPath = join(from, manifest.database.file);
  if (!ok("the backup contains its database", existsSync(dbPath))) return verdict();

  const onDisk = statSync(dbPath).size;
  ok("the database size matches the manifest", onDisk === manifest.database.bytes, {
    onDisk,
    manifest: manifest.database.bytes,
  });

  const db = new Database(dbPath, { readonly: true });
  try {
    const integrity = db.query("PRAGMA integrity_check").get() as { integrity_check: string };
    ok("SQLite reports the backup database is intact", integrity.integrity_check === "ok", integrity);

    const counts = db
      .query("SELECT (SELECT COUNT(*) FROM users) AS users, (SELECT COUNT(*) FROM repos) AS repos")
      .get() as { users: number; repos: number };
    console.log(`        ${counts.users} users, ${counts.repos} repositories`);
    ok("the backup database holds the expected tables", counts.users >= 0 && counts.repos >= 0);
  } catch (error) {
    ok("the backup database is readable", false, error instanceof Error ? error.message : "unknown");
  } finally {
    db.close();
  }

  const repoDir = join(from, "repositories");
  if (ok("the backup contains a repositories tree", existsSync(repoDir))) {
    const dirs = readdirSync(repoDir, { withFileTypes: true }).filter((e) => e.isDirectory());
    console.log(`        ${dirs.length} owner directories under repositories/`);
  }

  return verdict();
}

function selfPath(): string {
  return new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
}

async function orchestrate(): Promise<number> {
  const scratch = mkdtempSync(join(tmpdir(), "gg-restore-check-"));
  const dataDir = join(scratch, "data");
  mkdirSync(dataDir, { recursive: true });

  console.log(`Scratch instance: ${dataDir}`);
  console.log("(each phase runs in its own process, so no handle outlives it)\n");

  const childEnv = {
    ...process.env,
    NODE_ENV: "test",
    GITGOOD_CHECK_MARKER: runId,
    GITGOOD_DATA_DIR: dataDir,
    GITGOOD_DB_PATH: join(dataDir, "check.db"),
    GITGOOD_REPO_ROOT: join(dataDir, "repositories"),
    GITGOOD_LFS_ROOT: join(dataDir, "lfs"),
    GITGOOD_LOG_LEVEL: "error",
    GITGOOD_WEB_DIST: join(scratch, "no-web"),
  };

  const runPhase = async (flag: string): Promise<number> => {
    const proc = Bun.spawn(["bun", selfPath(), flag], {
      env: childEnv,
      stdout: "inherit",
      stderr: "inherit",
    });
    return proc.exited;
  };

  const seeded = await runPhase(SEED_FLAG);
  if (seeded !== 0) {
    console.log("\nSeed phase failed; not attempting the round trip.");
    rmSync(scratch, { recursive: true, force: true });
    return seeded;
  }

  const code = await runPhase(ROUNDTRIP_FLAG);
  rmSync(scratch, { recursive: true, force: true });
  return code;
}

async function main(): Promise<number> {
  const argv = Bun.argv.slice(2);

  if (argv.includes(SEED_FLAG)) return seed();
  if (argv.includes(ROUNDTRIP_FLAG)) return roundtrip();

  const fromIndex = argv.indexOf("--from");
  if (fromIndex >= 0) {
    const target = argv[fromIndex + 1];
    if (!target) {
      console.error("--from needs a directory");
      return 2;
    }
    return inspect(target);
  }

  return orchestrate();
}

process.exit(await main());

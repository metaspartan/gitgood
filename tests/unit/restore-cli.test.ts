import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

test("real restore CLI preserves database contents without importing the live database", async () => {
  const root = mkdtempSync(join(tmpdir(), "restore-cli-"));
  try {
    const source = join(root, "source"); const target = join(root, "target");
    mkdirSync(source); mkdirSync(target);
    const db = new Database(join(source, "gitgood.db"));
    db.run("CREATE TABLE marker (value TEXT)"); db.run("INSERT INTO marker VALUES ('preserved')"); db.close();
    const bytes = readFileSync(join(source, "gitgood.db"));
    writeFileSync(join(source, "manifest.json"), JSON.stringify({ format: 1, database: { file: "gitgood.db", bytes: bytes.length }, repositories: { files: 0, bytes: 0 }, lfs: { objects: 0, bytes: 0 }, databaseSha256: new Bun.CryptoHasher("sha256").update(bytes).digest("hex") }));
    const env = { ...process.env, GITGOOD_DATA_DIR: target, GITGOOD_DB_PATH: join(target, "gitgood.db"), GITGOOD_REPO_ROOT: join(target, "repositories"), GITGOOD_LFS_ROOT: join(target, "lfs") };
    const run = async (args: string[]) => {
      const proc = Bun.spawn([process.execPath, "tools/admin.ts", "restore", "--from", source, ...args], { cwd: resolve("."), env, stdout: "pipe", stderr: "pipe" });
      const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
      return { stdout, stderr, code };
    };
    const preview = await run(["--dry-run"]); expect(preview.code === 0 ? "" : preview.stderr).toBe("");
    expect(await Bun.file(join(target, "gitgood.db")).exists()).toBe(false);
    const result = await run([]); expect(result.stderr).toBe(""); expect(result.code).toBe(0);
    const restored = new Database(join(target, "gitgood.db"), { readonly: true });
    expect(restored.query("SELECT value FROM marker").get()).toEqual({ value: "preserved" }); restored.close();
    expect((await run([])).code).toBe(1);
    expect((await run(["--force"])).code).toBe(0);
    expect(readFileSync(join(target, "gitgood.db"))).toEqual(bytes);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

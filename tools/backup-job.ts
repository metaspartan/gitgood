import { cpSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { config } from "../src/config.ts";
import { runBackup } from "../src/lib/backup.ts";
import { parseBackupDestinations } from "../src/lib/backup-destinations.ts";

const [destinationId, jobId] = process.argv.slice(2);
if (!jobId || !/^backup-[0-9a-f-]{36}$/.test(jobId)) throw new Error("Invalid backup job ID");
const destination = parseBackupDestinations(process.env.GITGOOD_BACKUP_DESTINATIONS).find(d => d.id === destinationId);
if (!destination) throw new Error("Unknown destination");
const stagingRoot = resolve(process.env.GITGOOD_BACKUP_STAGING ?? "./backups");
const requestedRoot = destination.kind === "google-drive" ? stagingRoot : resolve(destination.target);
if (destination.kind === "nas" && !existsSync(requestedRoot)) throw new Error("NAS mount must already exist");
mkdirSync(requestedRoot, { recursive: true });
const localRoot = realpathSync(requestedRoot);
for (const source of [config.dataDir, config.repoRoot, config.lfsRoot]) {
  const rel = relative(existsSync(source) ? realpathSync(source) : resolve(source), localRoot);
  if (!rel || (rel !== ".." && !rel.startsWith("../") && !rel.startsWith("..\\") && !isAbsolute(rel))) {
    throw new Error("Backup destination must be outside source storage");
  }
}
const outDir = join(localRoot, jobId);
mkdirSync(dirname(outDir), { recursive: true });
runBackup({ outDir });
const releases = join(config.dataDir, "releases");
if (existsSync(releases)) cpSync(releases, join(outDir, "releases"), { recursive: true });
const manifestPath = join(outDir, "manifest.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
manifest.releaseAssetsIncluded = true;
manifest.consistency = "SQLite snapshot with sequential file copies; quiesce writes for a cross-store consistent recovery point";
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
if (destination.kind === "google-drive") {
  const remote = `${destination.target.replace(/\/$/, "")}/${jobId}`;
  for (const command of ["copy", "check"]) {
    const proc = Bun.spawn([process.env.GITGOOD_RCLONE_BIN ?? "rclone", command, outDir, remote, "--retries", "2", "--contimeout", "15s", "--timeout", "2m"], { stdout: "ignore", stderr: "ignore" });
    const timer = setTimeout(() => proc.kill("SIGKILL"), 60 * 60 * 1000);
    const code = await proc.exited.finally(() => clearTimeout(timer));
    if (code !== 0) throw new Error("Remote transfer or verification failed; local staging retained");
  }
}

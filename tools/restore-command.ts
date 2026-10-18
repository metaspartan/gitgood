import { formatBytes } from "../src/lib/format.ts";
import { resolve } from "node:path";
import { runRestore } from "../src/lib/backup.ts";
function flagString(flags: Map<string, string | true>, name: string): string | undefined {
  const value = flags.get(name); return typeof value === "string" ? value : undefined;
}
function commandRestore(flags: Map<string, string | true>): number {
  const from = flagString(flags, "from");
  if (!from) throw new Error("--from DIR is required");
  const dryRun = flags.get("dry-run") === true;
  const result = runRestore({ from, force: flags.get("force") === true, dryRun });

  if (dryRun) {
    console.log(`dry run against ${resolve(from)}`);
    console.log(`  backup created ${result.manifest.createdAt} (label "${result.manifest.label}")`);
    console.log(`  database      ${formatBytes(result.manifest.database.bytes)}`);
    console.log(`  repositories  ${result.manifest.repositories.count} repos`);
    console.log(`  lfs           ${result.manifest.lfs.objects} objects`);
    console.log("  digest verified, format supported, nothing written");
    return 0;
  }

  console.log(`restored from ${resolve(from)}`);
  console.log(`  database      ${result.restored.database ? "written" : "missing in backup"}`);
  console.log(`  repositories  ${result.restored.repositories ? "written" : "missing in backup"}`);
  console.log(`  lfs           ${result.restored.lfs ? "written" : "missing in backup"}`);
  if (result.previousState) console.log(`  previous state saved at ${result.previousState}`);
  if (result.sidecarsPending.length > 0) {
    console.log(`  note: ${result.sidecarsPending.length} SQLite sidecar(s) could not be removed because`);
    console.log(`        this process holds the database open. The restart below removes their`);
    console.log(`        influence; until then the restored file is not authoritative.`);
  }
  console.log("\nrestart the server so the new database is opened.");
  return 0;
}

const flags = new Map<string, string | true>();
for (let i = 3; i < process.argv.length; i++) {
  const arg = process.argv[i]!;
  if (!arg.startsWith("--")) throw new Error("Unexpected restore argument");
  const next = process.argv[i + 1];
  flags.set(arg.slice(2), next && !next.startsWith("--") ? (i++, next) : true);
}
try { process.exit(commandRestore(flags)); }
catch (error) { console.error(error instanceof Error ? error.message : "Restore failed"); process.exit(1); }

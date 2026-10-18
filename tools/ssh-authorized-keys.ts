import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { config } from "../src/config.ts";
import { migrate } from "../src/db/index.ts";
import { authorizedKeysFile, listAllKeysWithOwners, type SshKeyRow } from "../src/ssh/keys.ts";

function build(): string {
  migrate();
  const rows = listAllKeysWithOwners();
  const keys: SshKeyRow[] = rows.map((row) => ({
    id: row.id,
    user_id: row.user_id,
    title: row.title,
    fingerprint: row.fingerprint,
    public_key: row.public_key,
    created_at: row.created_at,
  }));
  return authorizedKeysFile(keys, sshCommandPath());
}

function sshCommandPath(): string {
  if (config.sshCommand.trim().length > 0) return config.sshCommand.trim();
  const script = new URL("./ssh-command.ts", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
  const bun = Bun.which("bun") ?? "/usr/local/bin/bun";
  return `${bun} ${script}`;
}

function flag(name: string): string | undefined {
  const index = Bun.argv.indexOf(name);
  if (index < 0) return undefined;
  const value = Bun.argv[index + 1];
  return value === undefined || value.startsWith("--") ? undefined : value;
}

const generated = build();

const out = flag("--out");
const check = flag("--check");

if (check !== undefined) {
  if (!existsSync(check)) {
    console.error(`check: ${check} does not exist`);
    process.exit(1);
  }
  const deployed = readFileSync(check, "utf8");
  if (deployed === generated) {
    console.log(`check: ${check} matches the database (${generated.split("\n").length - 5} keys)`);
    process.exit(0);
  }
  const deployedKeys = new Set(deployed.split("\n").filter((line) => !line.startsWith("#") && line.trim()));
  const generatedKeys = new Set(generated.split("\n").filter((line) => !line.startsWith("#") && line.trim()));
  const missing = [...generatedKeys].filter((line) => !deployedKeys.has(line));
  const stale = [...deployedKeys].filter((line) => !generatedKeys.has(line));
  console.error(`check: ${check} differs from the database`);
  if (missing.length > 0) console.error(`  ${missing.length} key(s) registered but not deployed`);
  if (stale.length > 0) console.error(`  ${stale.length} key(s) deployed but no longer registered`);
  console.error("  run: bun tools/ssh-authorized-keys.ts --out " + check);
  process.exit(1);
} else if (out !== undefined) {
  if (existsSync(out)) {
    renameSync(out, `${out}.bak`);
  }
  writeFileSync(out, generated);
  const keys = generated.split("\n").filter((line) => !line.startsWith("#") && line.trim()).length;
  console.log(`wrote ${out} (${keys} keys, previous kept as ${out}.bak)`);
  console.log("ensure the file is 0600 and owned by the git account");
} else {
  process.stdout.write(generated);
}

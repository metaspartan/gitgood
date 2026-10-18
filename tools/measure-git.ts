import { join } from "node:path";
import { spawnSync } from "node:child_process";

const root = process.env.GITGOOD_SEED_DIR ?? join(process.env.TEMP ?? ".", "gitgood-seed");
const repo = join(root, "repos", "large");

function time(label: string, args: string[], runs = 7): void {
  spawnSync("git", args, { cwd: repo, stdio: "pipe" });
  const samples: number[] = [];
  for (let i = 0; i < runs; i += 1) {
    const start = performance.now();
    const result = spawnSync("git", args, { cwd: repo, stdio: "pipe" });
    samples.push(performance.now() - start);
    if (result.status !== 0) {
      console.log(`  ${label} FAILED: ${result.stderr?.toString().slice(0, 200)}`);
      return;
    }
  }
  samples.sort((a, b) => a - b);
  const median = samples[Math.floor(samples.length / 2)]!;
  console.log(`  ${label.padEnd(44)} ${median.toFixed(1)} ms`);
}

console.log("\ngit subprocess cost, measured inside bun (median of 7)\n");
time("spawn only: rev-parse HEAD", ["rev-parse", "HEAD"]);
time("diff --numstat -z (three-dot)", ["diff", "--numstat", "-z", "refs/heads/main...refs/heads/seeded-pr-1"]);
time("diff --name-status -z (three-dot)", ["diff", "--name-status", "-z", "refs/heads/main...refs/heads/seeded-pr-1"]);
time("diff-tree -r (single commit)", ["diff-tree", "--no-commit-id", "-r", "HEAD"]);
time("ls-tree -r HEAD", ["ls-tree", "-r", "HEAD"]);
time("rev-list --count main", ["rev-list", "--count", "main"]);
time("count-objects -v", ["count-objects", "-v"]);
time("for-each-ref heads (current impl)", ["for-each-ref", "--format=%(refname:short)%00%(objectname)%00%(committerdate:unix)%1e", "refs/heads"]);
time("for-each-ref heads+tags+HEAD (batched)", ["for-each-ref", "--format=%(refname:short)%00%(objectname)%00%(committerdate:unix)%00%(objecttype)%00%(*objectname)%1e", "refs/heads", "refs/tags"]);
time("ls-tree -l root", ["ls-tree", "-l", "main"]);

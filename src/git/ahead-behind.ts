import { gitStdout } from "./run.ts";

export interface BranchAhead {
  ahead_by: number;
  behind_by: number;
}

export async function countAheadBehind(path: string, base: string, head: string): Promise<BranchAhead | null> {
  const result = await gitStdout(["rev-list", "--left-right", "--count", `${base}...${head}`], { cwd: path, allowFailure: true });
  if (result === "" ) return null;
  const parts = result.trim().split(/\s+/).map(Number);
  const [behind, ahead] = [parts[0] ?? NaN, parts[1] ?? NaN];
  if (!Number.isSafeInteger(ahead) || !Number.isSafeInteger(behind)) return null;
  return { ahead_by: ahead, behind_by: behind };
}

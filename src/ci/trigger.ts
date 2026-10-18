import type { RepoRecord } from "../data/repos.ts";
import { admitPush } from "./scheduler.ts";

export { readWorkflowAt } from "./scheduler.ts";

export async function maybeTriggerCi(
  repo: RepoRecord,
  changes: Array<{ ref: string; after: string | null }>,
): Promise<void> {
  const pushes = changes.filter((c) => c.ref.startsWith("refs/heads/") && c.after !== null);
  for (const push of pushes) {
    const refName = push.ref.slice("refs/heads/".length);
    const sha = push.after as string;
    try {
      const result = await admitPush(repo, refName, sha);
      if (result.rejected) {
        console.error(
          `CI push rejected for ${repo.owner_username}/${repo.name} ${refName}: ${result.reason ?? "queue full"}`,
        );
      }
    } catch (cause) {
      console.error(
        `CI trigger failed for ${repo.owner_username}/${repo.name}: ${cause instanceof Error ? cause.message : cause}`,
      );
    }
  }
}

export function defaultWorkflowName(): string {
  return "CI";
}

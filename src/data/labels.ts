import { all, changes, one, run, scalar } from "../db/index.ts";
import { conflict, notFound } from "../lib/errors.ts";

export interface LabelRow {
  id: number;
  repo_id: number;
  name: string;
  color: string;
}

const HEX_COLOR = /^[0-9a-fA-F]{6}$/;

export function listLabels(repoId: number): LabelRow[] {
  return all<LabelRow>("SELECT * FROM labels WHERE repo_id = ? ORDER BY name", repoId);
}

export function createLabel(repoId: number, name: string, color: string): LabelRow {
  const clean = name.trim();
  if (!clean) throw conflict("Label name is required");
  const normalized = HEX_COLOR.test(color) ? color.toLowerCase() : "888888";
  const existing = one<LabelRow>(
    "SELECT * FROM labels WHERE repo_id = ? AND name = ?",
    repoId,
    clean,
  );
  if (existing) {
    changes("UPDATE labels SET color = ? WHERE id = ?", normalized, existing.id);
    return { ...existing, color: normalized };
  }
  const id = run("INSERT INTO labels (repo_id, name, color) VALUES (?, ?, ?)", repoId, clean, normalized);
  const created = one<LabelRow>("SELECT * FROM labels WHERE id = ?", id);
  if (!created) throw notFound("Label not found after creation");
  return created;
}

export function deleteLabel(repoId: number, name: string): boolean {
  return changes("DELETE FROM labels WHERE repo_id = ? AND name = ?", repoId, name) > 0;
}

export function labelsForIssue(issueId: number): LabelRow[] {
  return all<LabelRow>(
    `SELECT l.* FROM labels l JOIN issue_labels il ON il.label_id = l.id
     WHERE il.issue_id = ? ORDER BY l.name`,
    issueId,
  );
}

export function setIssueLabels(repoId: number, issueId: number, names: string[]): LabelRow[] {
  changes("DELETE FROM issue_labels WHERE issue_id = ?", issueId);
  for (const name of names) {
    const label = createLabel(repoId, name, "888888");
    run(
      "INSERT OR IGNORE INTO issue_labels (issue_id, label_id) VALUES (?, ?)",
      issueId,
      label.id,
    );
  }
  return labelsForIssue(issueId);
}

export function labelNamesForIssue(issueId: number): string[] {
  return all<{ name: string }>(
    `SELECT l.name FROM labels l JOIN issue_labels il ON il.label_id = l.id
     WHERE il.issue_id = ? ORDER BY l.name`,
    issueId,
  ).map((row) => row.name);
}

export function labelNamesForIssues(issueIds: readonly number[]): Map<number, string[]> {
  const result = new Map<number, string[]>(issueIds.map((id) => [id, []]));
  if (issueIds.length === 0) return result;
  const placeholders = issueIds.map(() => "?").join(",");
  const rows = all<{ issue_id: number; name: string }>(
    `SELECT il.issue_id AS issue_id, l.name AS name
       FROM issue_labels il
       JOIN labels l ON l.id = il.label_id
      WHERE il.issue_id IN (${placeholders})
      ORDER BY l.name`,
    ...issueIds,
  );
  for (const row of rows) result.get(row.issue_id)?.push(row.name);
  return result;
}

export function countLabels(repoId: number): number {
  return scalar<number>("SELECT COUNT(*) FROM labels WHERE repo_id = ?", repoId) ?? 0;
}

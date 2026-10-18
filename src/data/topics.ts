import { all, changes, now, one, run } from "../db/index.ts";
import { badRequest, notFound } from "../lib/errors.ts";

export const MAX_TOPIC_LENGTH = 35;
export const MAX_TOPICS_PER_REPO = 20;

const TOPIC_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export interface TopicRow {
  name: string;
  repo_count: number;
}

export function normalizeTopic(raw: string): string {
  const trimmed = raw.trim().toLowerCase();
  if (!trimmed) throw badRequest("A topic cannot be empty");
  if (trimmed.length > MAX_TOPIC_LENGTH) {
    throw badRequest(`A topic can be at most ${MAX_TOPIC_LENGTH} characters`);
  }
  if (/[^a-z0-9-]/.test(trimmed)) {
    if (/[_\s]/.test(trimmed)) {
      throw badRequest("A topic cannot contain spaces or underscores - use hyphens, like web-api");
    }
    throw badRequest("A topic may only contain letters, digits and hyphens");
  }
  if (trimmed.startsWith("-") || trimmed.endsWith("-")) {
    throw badRequest("A topic cannot start or end with a hyphen");
  }
  if (!TOPIC_PATTERN.test(trimmed)) throw badRequest("That is not a valid topic");
  return trimmed;
}

export function normalizeTopics(raw: readonly string[]): string[] {
  const unique = [...new Set(raw.map(normalizeTopic))].sort();
  if (unique.length > MAX_TOPICS_PER_REPO) {
    throw badRequest(`A repository can have at most ${MAX_TOPICS_PER_REPO} topics`);
  }
  return unique;
}

export function listTopicsForRepo(repoId: number): string[] {
  return all<{ name: string }>(
    `SELECT t.name FROM repo_topics rt
       JOIN topics t ON t.id = rt.topic_id
      WHERE rt.repo_id = ?
      ORDER BY t.name`,
    repoId,
  ).map((row) => row.name);
}

export function popularTopics(limit = 20): TopicRow[] {
  return all<TopicRow>(
    "SELECT name, repo_count FROM topics WHERE repo_count > 0 ORDER BY repo_count DESC, name LIMIT ?",
    Math.max(1, Math.min(limit, 100)),
  );
}

export function repoIdsWithTopic(name: string, limit: number, offset: number): { ids: number[]; total: number } {
  const topic = one<{ id: number }>("SELECT id FROM topics WHERE name = ?", name);
  if (!topic) return { ids: [], total: 0 };
  const total =
    one<{ n: number }>("SELECT COUNT(*) AS n FROM repo_topics WHERE topic_id = ?", topic.id)?.n ?? 0;
  const ids = all<{ repo_id: number }>(
    "SELECT repo_id FROM repo_topics WHERE topic_id = ? ORDER BY repo_id LIMIT ? OFFSET ?",
    topic.id,
    limit,
    offset,
  ).map((row) => row.repo_id);
  return { ids, total };
}

export function setTopicsForRepo(repoId: number, raw: readonly string[]): string[] {
  const topics = normalizeTopics(raw);
  const timestamp = now();

  const existing = all<{ topic_id: number; name: string }>(
    `SELECT rt.topic_id AS topic_id, t.name AS name FROM repo_topics rt
       JOIN topics t ON t.id = rt.topic_id WHERE rt.repo_id = ?`,
    repoId,
  );
  const wantedNames = new Set(topics);

  for (const row of existing) {
    if (wantedNames.has(row.name)) continue;
    changes("DELETE FROM repo_topics WHERE repo_id = ? AND topic_id = ?", repoId, row.topic_id);
    decrementTopic(row.topic_id);
  }

  for (const name of topics) {
    if ([...existing].some((row) => row.name === name)) continue;
    const topicId = topicIdFor(name, timestamp);
    if (changes("INSERT OR IGNORE INTO repo_topics (repo_id, topic_id, created_at) VALUES (?, ?, ?)", repoId, topicId, timestamp) > 0) {
      incrementTopic(topicId);
    }
  }
  return topics;
}

function topicIdFor(name: string, timestamp: number): number {
  const existing = one<{ id: number }>("SELECT id FROM topics WHERE name = ?", name);
  if (existing) return existing.id;
  const id = run("INSERT INTO topics (name, repo_count, created_at) VALUES (?, 0, ?)", name, timestamp);
  return id;
}

function incrementTopic(topicId: number): void {
  changes("UPDATE topics SET repo_count = repo_count + 1 WHERE id = ?", topicId);
}

function decrementTopic(topicId: number): void {
  changes("UPDATE topics SET repo_count = MAX(repo_count - 1, 0) WHERE id = ?", topicId);
}

export function pruneTopic(name: string): void {
  changes("DELETE FROM topics WHERE name = ? AND repo_count <= 0", name);
}

export function topicsPayload(topics: readonly string[]): {
  topics: string[];
  topics_csv: string;
  max_topics: number;
} {
  return { topics: [...topics], topics_csv: topics.join(","), max_topics: MAX_TOPICS_PER_REPO };
}

export function requireTopic(name: string): void {
  if (!one("SELECT name FROM topics WHERE name = ? AND repo_count > 0", name)) {
    throw notFound(`No repositories are tagged "${name}"`);
  }
}

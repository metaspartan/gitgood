CREATE TABLE IF NOT EXISTS topics (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL UNIQUE,
  repo_count INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_topics_count ON topics(name, repo_count DESC);

CREATE TABLE IF NOT EXISTS repo_topics (
  repo_id   INTEGER NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  topic_id  INTEGER NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (repo_id, topic_id)
);

CREATE INDEX IF NOT EXISTS idx_repo_topics_topic ON repo_topics(topic_id, repo_id);

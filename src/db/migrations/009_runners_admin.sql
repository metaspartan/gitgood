CREATE TABLE IF NOT EXISTS ci_runners (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT NOT NULL,
  token_hash    TEXT NOT NULL UNIQUE,
  token_prefix  TEXT NOT NULL,
  created_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at    INTEGER NOT NULL,
  last_seen_at  INTEGER,
  last_ip       TEXT,
  version       TEXT,
  paused        INTEGER NOT NULL DEFAULT 0
);

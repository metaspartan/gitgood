CREATE TABLE IF NOT EXISTS thread_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  repo_id     INTEGER NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  target_type TEXT    NOT NULL CHECK (target_type IN ('issue', 'pull')),
  target_id   INTEGER NOT NULL,
  actor_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  actor_name  TEXT    NOT NULL DEFAULT '',
  kind        TEXT    NOT NULL,
  detail      TEXT    NOT NULL DEFAULT '{}',
  created_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_thread_events_target
  ON thread_events(target_type, target_id, id);

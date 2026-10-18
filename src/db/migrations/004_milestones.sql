CREATE TABLE IF NOT EXISTS milestones (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  repo_id     INTEGER NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  number      INTEGER NOT NULL,
  title       TEXT    NOT NULL,
  description TEXT    NOT NULL DEFAULT '',
  state       TEXT    NOT NULL DEFAULT 'open' CHECK (state IN ('open','closed')),
  due_on      INTEGER,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  closed_at   INTEGER,
  creator_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  UNIQUE (repo_id, number)
);
CREATE INDEX IF NOT EXISTS idx_milestones_repo ON milestones(repo_id, state, number);

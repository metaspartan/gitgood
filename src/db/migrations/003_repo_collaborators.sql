CREATE TABLE IF NOT EXISTS repo_collaborators (
  repo_id    INTEGER NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  permission TEXT    NOT NULL CHECK (permission IN ('read', 'write')),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (repo_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_repo_collaborators_user ON repo_collaborators(user_id);

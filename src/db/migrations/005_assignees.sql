CREATE TABLE IF NOT EXISTS issue_assignees (
  issue_id    INTEGER NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  assigned_at INTEGER NOT NULL,
  assigned_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  PRIMARY KEY (issue_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_issue_assignees_user ON issue_assignees(user_id);

CREATE TABLE IF NOT EXISTS pull_assignees (
  pull_id     INTEGER NOT NULL REFERENCES pulls(id) ON DELETE CASCADE,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  assigned_at INTEGER NOT NULL,
  assigned_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  PRIMARY KEY (pull_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_pull_assignees_user ON pull_assignees(user_id);

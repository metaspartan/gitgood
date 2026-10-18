
CREATE TABLE IF NOT EXISTS pull_reviews (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  repo_id    INTEGER NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  pull_id    INTEGER NOT NULL REFERENCES pulls(id) ON DELETE CASCADE,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  event      TEXT NOT NULL CHECK (event IN ('APPROVE', 'REQUEST_CHANGES', 'COMMENT')),
  body       TEXT NOT NULL DEFAULT '',
  commit_id  TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pull_reviews_pull ON pull_reviews(pull_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_pull_reviews_user ON pull_reviews(pull_id, user_id, id DESC);

CREATE TABLE IF NOT EXISTS pull_merge_policies (
  repo_id             INTEGER NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  branch              TEXT NOT NULL,
  required_approvals  INTEGER NOT NULL DEFAULT 0 CHECK (required_approvals BETWEEN 0 AND 6),
  require_checks      INTEGER NOT NULL DEFAULT 0 CHECK (require_checks IN (0, 1)),
  updated_at          INTEGER NOT NULL,
  PRIMARY KEY (repo_id, branch)
);

CREATE INDEX IF NOT EXISTS ci_runs_review_gate ON ci_runs(repo_id, sha, workflow_name, job_id, id);

CREATE TABLE IF NOT EXISTS branch_protection (
  repo_id INTEGER NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  branch TEXT NOT NULL,
  require_pull_request INTEGER NOT NULL DEFAULT 0 CHECK (require_pull_request IN (0, 1)),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (repo_id, branch)
);

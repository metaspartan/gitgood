CREATE TABLE IF NOT EXISTS lfs_repo_objects (
  repo_id    INTEGER NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  oid        TEXT    NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (repo_id, oid)
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS idx_lfs_repo_objects_oid ON lfs_repo_objects(oid);

CREATE TABLE IF NOT EXISTS lfs_repo_scans (
  repo_id    INTEGER PRIMARY KEY REFERENCES repos(id) ON DELETE CASCADE,
  scanned_at INTEGER NOT NULL,
  pointers   INTEGER NOT NULL
);

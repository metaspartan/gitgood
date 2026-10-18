PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA synchronous = NORMAL;

CREATE TABLE IF NOT EXISTS users (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  username       TEXT NOT NULL UNIQUE COLLATE NOCASE,
  email          TEXT NOT NULL UNIQUE COLLATE NOCASE,
  display_name   TEXT NOT NULL,
  password_hash  TEXT NOT NULL,
  is_admin       INTEGER NOT NULL DEFAULT 0,
  avatar_hue     INTEGER NOT NULL DEFAULT 0,
  created_at     INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id          TEXT PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at  INTEGER NOT NULL,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

CREATE TABLE IF NOT EXISTS access_tokens (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  token_hash   TEXT NOT NULL UNIQUE,
  scopes       TEXT NOT NULL DEFAULT 'read,write',
  last_used_at INTEGER,
  created_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tokens_user ON access_tokens(user_id);

CREATE TABLE IF NOT EXISTS ssh_keys (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title       TEXT NOT NULL,
  fingerprint TEXT NOT NULL UNIQUE,
  public_key  TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ssh_keys_user ON ssh_keys(user_id);

CREATE TABLE IF NOT EXISTS repos (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name           TEXT NOT NULL COLLATE NOCASE,
  description    TEXT NOT NULL DEFAULT '',
  visibility     TEXT NOT NULL DEFAULT 'public' CHECK (visibility IN ('public','private')),
  default_branch TEXT NOT NULL DEFAULT 'main',
  lfs_enabled    INTEGER NOT NULL DEFAULT 1,
  archived       INTEGER NOT NULL DEFAULT 0,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL,
  UNIQUE (owner_id, name)
);

CREATE TABLE IF NOT EXISTS issues (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  repo_id    INTEGER NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  number     INTEGER NOT NULL,
  title      TEXT NOT NULL,
  body       TEXT NOT NULL DEFAULT '',
  state      TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open','closed')),
  author_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  closed_at  INTEGER,
  UNIQUE (repo_id, number)
);
CREATE INDEX IF NOT EXISTS idx_issues_repo_state ON issues(repo_id, state, number);

CREATE TABLE IF NOT EXISTS pulls (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  repo_id       INTEGER NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  number        INTEGER NOT NULL,
  title         TEXT NOT NULL,
  body          TEXT NOT NULL DEFAULT '',
  state         TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open','closed','merged')),
  author_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  head_ref      TEXT NOT NULL,
  base_ref      TEXT NOT NULL,
  merged_sha    TEXT,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  merged_at     INTEGER,
  UNIQUE (repo_id, number)
);
CREATE INDEX IF NOT EXISTS idx_pulls_repo_state ON pulls(repo_id, state, number);

CREATE TABLE IF NOT EXISTS comments (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  repo_id     INTEGER NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  target_type TEXT NOT NULL CHECK (target_type IN ('issue','pull')),
  target_id   INTEGER NOT NULL,
  author_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body        TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_comments_target ON comments(target_type, target_id, id);

CREATE TABLE IF NOT EXISTS labels (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  repo_id INTEGER NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  name    TEXT NOT NULL,
  color   TEXT NOT NULL DEFAULT '888888',
  UNIQUE (repo_id, name)
);

CREATE TABLE IF NOT EXISTS issue_labels (
  issue_id INTEGER NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  label_id INTEGER NOT NULL REFERENCES labels(id) ON DELETE CASCADE,
  PRIMARY KEY (issue_id, label_id)
);

CREATE TABLE IF NOT EXISTS webhooks (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  repo_id    INTEGER NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  url        TEXT NOT NULL,
  secret     TEXT NOT NULL DEFAULT '',
  events     TEXT NOT NULL DEFAULT 'push',
  active     INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_webhooks_repo ON webhooks(repo_id);

CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  webhook_id   INTEGER NOT NULL REFERENCES webhooks(id) ON DELETE CASCADE,
  event        TEXT NOT NULL,
  status_code  INTEGER,
  error        TEXT,
  attempts     INTEGER NOT NULL DEFAULT 1,
  duration_ms  INTEGER NOT NULL DEFAULT 0,
  created_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_deliveries_webhook ON webhook_deliveries(webhook_id, id DESC);

CREATE TABLE IF NOT EXISTS lfs_objects (
  oid        TEXT PRIMARY KEY,
  size       INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS lfs_locks (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  repo_id    INTEGER NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  path       TEXT NOT NULL,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  UNIQUE (repo_id, path)
);

CREATE VIRTUAL TABLE IF NOT EXISTS issues_fts USING fts5(
  title,
  body,
  content = 'issues',
  content_rowid = 'id',
  tokenize = 'unicode61'
);

CREATE TRIGGER IF NOT EXISTS issues_fts_insert AFTER INSERT ON issues BEGIN
  INSERT INTO issues_fts (rowid, title, body) VALUES (new.id, new.title, new.body);
END;

CREATE TRIGGER IF NOT EXISTS issues_fts_delete AFTER DELETE ON issues BEGIN
  INSERT INTO issues_fts (issues_fts, rowid, title, body)
  VALUES ('delete', old.id, old.title, old.body);
END;

CREATE TRIGGER IF NOT EXISTS issues_fts_update AFTER UPDATE ON issues BEGIN
  INSERT INTO issues_fts (issues_fts, rowid, title, body)
  VALUES ('delete', old.id, old.title, old.body);
  INSERT INTO issues_fts (rowid, title, body) VALUES (new.id, new.title, new.body);
END;

CREATE VIRTUAL TABLE IF NOT EXISTS pulls_fts USING fts5(
  title,
  body,
  content = 'pulls',
  content_rowid = 'id',
  tokenize = 'unicode61'
);

CREATE TRIGGER IF NOT EXISTS pulls_fts_insert AFTER INSERT ON pulls BEGIN
  INSERT INTO pulls_fts (rowid, title, body) VALUES (new.id, new.title, new.body);
END;

CREATE TRIGGER IF NOT EXISTS pulls_fts_delete AFTER DELETE ON pulls BEGIN
  INSERT INTO pulls_fts (pulls_fts, rowid, title, body)
  VALUES ('delete', old.id, old.title, old.body);
END;

CREATE TRIGGER IF NOT EXISTS pulls_fts_update AFTER UPDATE ON pulls BEGIN
  INSERT INTO pulls_fts (pulls_fts, rowid, title, body)
  VALUES ('delete', old.id, old.title, old.body);
  INSERT INTO pulls_fts (rowid, title, body) VALUES (new.id, new.title, new.body);
END;

CREATE TABLE IF NOT EXISTS repo_counters (
  repo_id    INTEGER NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL,
  next_value INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (repo_id, kind)
);

CREATE TABLE IF NOT EXISTS orgs (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  name         TEXT NOT NULL UNIQUE COLLATE NOCASE,
  display_name TEXT NOT NULL,
  description  TEXT NOT NULL DEFAULT '',
  avatar_hue   INTEGER NOT NULL DEFAULT 0,
  created_by   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS org_members (
  org_id     INTEGER NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role       TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('owner','admin','member')),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (org_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_org_members_user ON org_members(user_id);

CREATE TABLE IF NOT EXISTS stars (
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  repo_id    INTEGER NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, repo_id)
);
CREATE INDEX IF NOT EXISTS idx_stars_repo ON stars(repo_id);

CREATE TABLE IF NOT EXISTS watches (
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  repo_id    INTEGER NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, repo_id)
);
CREATE INDEX IF NOT EXISTS idx_watches_repo ON watches(repo_id);

CREATE TABLE IF NOT EXISTS notifications (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind            TEXT NOT NULL,
  repo_id         INTEGER REFERENCES repos(id) ON DELETE CASCADE,
  repo_full_name  TEXT NOT NULL DEFAULT '',
  subject_type    TEXT NOT NULL DEFAULT '',
  subject_id      INTEGER,
  subject_number  INTEGER,
  subject_title   TEXT NOT NULL DEFAULT '',
  actor_id        INTEGER REFERENCES users(id) ON DELETE SET NULL,
  actor_username  TEXT NOT NULL DEFAULT '',
  dedupe_key      TEXT NOT NULL DEFAULT '',
  read_at         INTEGER,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, read_at, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_notifications_unread ON notifications(user_id) WHERE read_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_notifications_dedupe
  ON notifications(user_id, dedupe_key) WHERE dedupe_key <> '';

CREATE TABLE IF NOT EXISTS code_blobs (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  repo_id  INTEGER NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  path     TEXT NOT NULL,
  language TEXT NOT NULL DEFAULT '',
  content  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_code_blobs_repo ON code_blobs(repo_id);

CREATE VIRTUAL TABLE IF NOT EXISTS code_fts USING fts5(
  path,
  content,
  content = 'code_blobs',
  content_rowid = 'id',
  tokenize = 'unicode61'
);

CREATE TRIGGER IF NOT EXISTS code_fts_insert AFTER INSERT ON code_blobs BEGIN
  INSERT INTO code_fts (rowid, path, content) VALUES (new.id, new.path, new.content);
END;

CREATE TRIGGER IF NOT EXISTS code_fts_delete AFTER DELETE ON code_blobs BEGIN
  INSERT INTO code_fts (code_fts, rowid, path, content)
  VALUES ('delete', old.id, old.path, old.content);
END;

CREATE TRIGGER IF NOT EXISTS code_fts_update AFTER UPDATE ON code_blobs BEGIN
  INSERT INTO code_fts (code_fts, rowid, path, content)
  VALUES ('delete', old.id, old.path, old.content);
  INSERT INTO code_fts (rowid, path, content) VALUES (new.id, new.path, new.content);
END;

CREATE TABLE IF NOT EXISTS code_index_state (
  repo_id       INTEGER PRIMARY KEY REFERENCES repos(id) ON DELETE CASCADE,
  sha           TEXT NOT NULL DEFAULT '',
  files         INTEGER NOT NULL DEFAULT 0,
  bytes         INTEGER NOT NULL DEFAULT 0,
  skipped       INTEGER NOT NULL DEFAULT 0,
  truncated     INTEGER NOT NULL DEFAULT 0,
  indexed_at    INTEGER NOT NULL,
  last_error    TEXT
);

CREATE TABLE IF NOT EXISTS ci_runs (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  repo_id       INTEGER NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  workflow_name TEXT NOT NULL,
  job_id        TEXT NOT NULL,
  ref_name      TEXT NOT NULL,
  sha           TEXT NOT NULL,
  status        TEXT NOT NULL CHECK (status IN ('queued','running','success','failure')),
  exit_code     INTEGER,
  pull_id       INTEGER REFERENCES pulls(id) ON DELETE SET NULL,
  started_at    INTEGER NOT NULL,
  finished_at   INTEGER
);
CREATE INDEX IF NOT EXISTS idx_ci_runs_repo ON ci_runs(repo_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_ci_runs_sha ON ci_runs(repo_id, sha);

CREATE TABLE IF NOT EXISTS ci_run_logs (
  run_id  INTEGER NOT NULL REFERENCES ci_runs(id) ON DELETE CASCADE,
  seq     INTEGER NOT NULL,
  text    TEXT NOT NULL,
  PRIMARY KEY (run_id, seq)
);

CREATE TABLE IF NOT EXISTS recovery_codes (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash  TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_recovery_codes_user ON recovery_codes(user_id);

CREATE TABLE IF NOT EXISTS passkeys (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  credential_id TEXT NOT NULL UNIQUE,
  public_key    TEXT NOT NULL,
  sign_count    INTEGER NOT NULL DEFAULT 0,
  label         TEXT NOT NULL DEFAULT '',
  created_at    INTEGER NOT NULL,
  last_used_at  INTEGER
);
CREATE INDEX IF NOT EXISTS idx_passkeys_user ON passkeys(user_id);

CREATE TABLE IF NOT EXISTS webauthn_challenges (
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL,
  challenge  TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, kind)
);

CREATE TABLE IF NOT EXISTS releases (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  repo_id     INTEGER NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  tag_name    TEXT NOT NULL,
  name        TEXT NOT NULL DEFAULT '',
  body        TEXT NOT NULL DEFAULT '',
  prerelease  INTEGER NOT NULL DEFAULT 0,
  draft       INTEGER NOT NULL DEFAULT 0,
  author_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  UNIQUE (repo_id, tag_name)
);
CREATE INDEX IF NOT EXISTS idx_releases_repo ON releases(repo_id);

CREATE TABLE IF NOT EXISTS release_assets (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  release_id   INTEGER NOT NULL REFERENCES releases(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  size         INTEGER NOT NULL,
  content_type TEXT NOT NULL DEFAULT 'application/octet-stream',
  sha256       TEXT NOT NULL,
  downloads    INTEGER NOT NULL DEFAULT 0,
  created_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_release_assets_release ON release_assets(release_id);

CREATE TABLE IF NOT EXISTS discord_users (
  discord_id   TEXT PRIMARY KEY,
  username     TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS web_sessions (
  session_id      TEXT PRIMARY KEY,
  discord_user_id TEXT NOT NULL REFERENCES discord_users(discord_id),
  created_at      INTEGER NOT NULL,
  expires_at      INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_web_sessions_user
  ON web_sessions(discord_user_id);

CREATE TABLE IF NOT EXISTS service_links (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  discord_user_id     TEXT NOT NULL REFERENCES discord_users(discord_id),
  service             TEXT NOT NULL CHECK (service IN ('spotify','youtube')),
  access_token_enc    BLOB NOT NULL,
  refresh_token_enc   BLOB,
  key_id              TEXT NOT NULL,
  scope               TEXT,
  token_expires_at    INTEGER,
  status              TEXT NOT NULL DEFAULT 'active'
                        CHECK (status IN ('active','needs_relink')),
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL,
  UNIQUE (discord_user_id, service)
);

CREATE TABLE IF NOT EXISTS oauth_states (
  state           TEXT PRIMARY KEY,
  discord_user_id TEXT,
  service         TEXT NOT NULL,
  code_verifier   TEXT,
  redirect_after  TEXT,
  created_at      INTEGER NOT NULL,
  expires_at      INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS import_jobs (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  discord_user_id TEXT NOT NULL REFERENCES discord_users(discord_id),
  guild_id        TEXT NOT NULL,
  service         TEXT NOT NULL,
  playlist_id     TEXT NOT NULL,
  playlist_name   TEXT,
  total_count     INTEGER NOT NULL DEFAULT 0,
  matched_count   INTEGER NOT NULL DEFAULT 0,
  failed_count    INTEGER NOT NULL DEFAULT 0,
  status          TEXT NOT NULL DEFAULT 'running'
                    CHECK (status IN ('running','completed','partial','failed')),
  created_at      INTEGER NOT NULL,
  completed_at    INTEGER
);

CREATE INDEX IF NOT EXISTS idx_import_jobs_user
  ON import_jobs(discord_user_id, created_at);

CREATE TABLE IF NOT EXISTS import_tracks (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id        INTEGER NOT NULL REFERENCES import_jobs(id) ON DELETE CASCADE,
  position      INTEGER NOT NULL,
  source_title  TEXT NOT NULL,
  source_artist TEXT,
  source_url    TEXT,
  matched_url   TEXT,
  matched_title TEXT,
  match_status  TEXT NOT NULL DEFAULT 'matched'
                  CHECK (match_status IN ('matched','failed','replaced'))
);

CREATE INDEX IF NOT EXISTS idx_import_tracks_job
  ON import_tracks(job_id, position);

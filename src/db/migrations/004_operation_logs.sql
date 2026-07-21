CREATE TABLE IF NOT EXISTS operation_logs (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id        TEXT NOT NULL,
  discord_user_id TEXT,
  username        TEXT,
  source          TEXT NOT NULL CHECK (source IN ('command','control','admin')),
  action          TEXT NOT NULL,
  detail          TEXT,
  success         INTEGER NOT NULL DEFAULT 1,
  created_at      INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_operation_logs_guild
  ON operation_logs(guild_id, created_at DESC);

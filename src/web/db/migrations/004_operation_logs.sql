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

-- Indexed on id (not created_at): the admin log listing paginates and sorts
-- by id DESC (see routes/admin.js), and id is already a strictly increasing
-- proxy for insertion order.
CREATE INDEX IF NOT EXISTS idx_operation_logs_guild
  ON operation_logs(guild_id, id DESC);

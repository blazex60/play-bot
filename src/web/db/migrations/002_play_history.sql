CREATE TABLE IF NOT EXISTS play_history (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id        TEXT NOT NULL,
  discord_user_id TEXT NOT NULL REFERENCES discord_users(discord_id),
  video_id        TEXT,
  channel         TEXT,
  track_title     TEXT NOT NULL,
  track_url       TEXT NOT NULL,
  played_at       INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_play_history_user
  ON play_history(discord_user_id, played_at);
CREATE INDEX IF NOT EXISTS idx_play_history_guild_video
  ON play_history(guild_id, video_id);

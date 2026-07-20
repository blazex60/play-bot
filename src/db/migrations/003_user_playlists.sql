CREATE TABLE IF NOT EXISTS user_playlists (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  discord_user_id TEXT NOT NULL REFERENCES discord_users(discord_id),
  name            TEXT NOT NULL,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_user_playlists_user
  ON user_playlists(discord_user_id, updated_at);

CREATE TABLE IF NOT EXISTS user_playlist_tracks (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  playlist_id  INTEGER NOT NULL REFERENCES user_playlists(id) ON DELETE CASCADE,
  position     INTEGER NOT NULL,
  title        TEXT NOT NULL,
  webpage_url  TEXT NOT NULL,
  duration     INTEGER,
  thumbnail    TEXT,
  video_id     TEXT,
  channel      TEXT,
  added_at     INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_user_playlist_tracks_playlist
  ON user_playlist_tracks(playlist_id, position);

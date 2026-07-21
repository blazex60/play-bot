import Database from 'better-sqlite3'
import { createWebConfig } from './config.js'

export function createMemoryDb() {
  const db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  db.exec(`
    CREATE TABLE discord_users (
      discord_id TEXT PRIMARY KEY,
      username TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      last_seen_at INTEGER NOT NULL
    );
    CREATE TABLE web_sessions (
      session_id TEXT PRIMARY KEY,
      discord_user_id TEXT NOT NULL REFERENCES discord_users(discord_id),
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    );
    CREATE TABLE oauth_states (
      state TEXT PRIMARY KEY,
      discord_user_id TEXT,
      service TEXT NOT NULL,
      code_verifier TEXT,
      redirect_after TEXT,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    );
    CREATE TABLE service_links (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      discord_user_id TEXT NOT NULL REFERENCES discord_users(discord_id),
      service TEXT NOT NULL CHECK (service IN ('spotify','youtube')),
      access_token_enc BLOB NOT NULL,
      refresh_token_enc BLOB,
      key_id TEXT NOT NULL,
      scope TEXT,
      token_expires_at INTEGER,
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','needs_relink')),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE (discord_user_id, service)
    );
    CREATE TABLE play_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      guild_id TEXT NOT NULL,
      discord_user_id TEXT NOT NULL REFERENCES discord_users(discord_id),
      video_id TEXT,
      channel TEXT,
      track_title TEXT NOT NULL,
      track_url TEXT NOT NULL,
      played_at INTEGER NOT NULL
    );
    CREATE TABLE user_playlists (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      discord_user_id TEXT NOT NULL REFERENCES discord_users(discord_id),
      name TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX idx_user_playlists_user
      ON user_playlists(discord_user_id, updated_at);
    CREATE TABLE user_playlist_tracks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      playlist_id INTEGER NOT NULL REFERENCES user_playlists(id) ON DELETE CASCADE,
      position INTEGER NOT NULL,
      title TEXT NOT NULL,
      webpage_url TEXT NOT NULL,
      duration INTEGER,
      thumbnail TEXT,
      video_id TEXT,
      channel TEXT,
      added_at INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX idx_user_playlist_tracks_playlist
      ON user_playlist_tracks(playlist_id, position);
    CREATE TABLE operation_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      guild_id TEXT NOT NULL,
      discord_user_id TEXT,
      username TEXT,
      source TEXT NOT NULL CHECK (source IN ('command','control','admin')),
      action TEXT NOT NULL,
      detail TEXT,
      success INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX idx_operation_logs_guild
      ON operation_logs(guild_id, id DESC);
  `)
  return db
}

export function createTestConfig(overrides = {}) {
  return createWebConfig({
    NODE_ENV: 'test',
    PUBLIC_BASE_URL: 'https://music.example.test',
    WEB_SESSION_SECRET: 'a'.repeat(32),
    BOT_API_TOKEN: 'bot-secret',
    DISCORD_CLIENT_ID: 'discord-client',
    DISCORD_CLIENT_SECRET: 'discord-secret',
    GOOGLE_CLIENT_ID: 'google-client',
    GOOGLE_CLIENT_SECRET: 'google-secret',
    ...overrides,
  })
}

export function fetchJsonSequence(responses) {
  const calls = []
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url: url.toString(), options })
    const next = responses.shift()
    if (!next) {
      throw new Error(`Unexpected fetch call: ${url}`)
    }
    return {
      ok: next.ok ?? true,
      status: next.status ?? 200,
      text: async () => JSON.stringify(next.body ?? {}),
    }
  }
  fetchImpl.calls = calls
  return fetchImpl
}

import Database from 'better-sqlite3'
import { createWebConfig } from './config.js'

export function createMemoryDb() {
  const db = new Database(':memory:')
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
    SPOTIFY_CLIENT_ID: 'spotify-client',
    SPOTIFY_CLIENT_SECRET: 'spotify-secret',
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

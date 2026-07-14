import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { closeDatabase, configureDatabasePathForTest, getDatabase } from './index.js'
import { runMigrations } from './migrate.js'
import { decrypt } from './crypto.js'
import {
  configureTokenStoreForTest,
  getValidAccessToken,
  upsertServiceLink,
} from './tokenStore.js'

const KEY = Buffer.alloc(32, 9).toString('base64')

let tempDir

beforeEach(async () => {
  process.env.MUSICBOT_TOKEN_ENC_KEY = KEY
  process.env.SPOTIFY_CLIENT_ID = 'spotify-client'
  process.env.SPOTIFY_CLIENT_SECRET = 'spotify-secret'
  tempDir = await mkdtemp(join(tmpdir(), 'musicbot-token-store-'))
  configureDatabasePathForTest(join(tempDir, 'musicbot.db'))
  runMigrations()
  getDatabase().prepare(`
    INSERT INTO discord_users (discord_id, username, created_at, last_seen_at)
    VALUES (?, ?, ?, ?)
  `).run('user-1', 'User 1', Date.now(), Date.now())
})

afterEach(async () => {
  configureTokenStoreForTest()
  closeDatabase()
  await rm(tempDir, { recursive: true, force: true })
})

test('getValidAccessToken: returns active unexpired token without refresh', async () => {
  upsertServiceLink({
    userId: 'user-1',
    service: 'spotify',
    accessToken: 'access-live',
    refreshToken: 'refresh-live',
    tokenExpiresAt: Date.now() + 600_000,
  })

  let calls = 0
  configureTokenStoreForTest({
    fetch: async () => {
      calls += 1
      throw new Error('refresh should not run')
    },
  })

  assert.equal(await getValidAccessToken('user-1', 'spotify'), 'access-live')
  assert.equal(calls, 0)
})

test('getValidAccessToken: concurrent expired reads share one refresh', async () => {
  upsertServiceLink({
    userId: 'user-1',
    service: 'spotify',
    accessToken: 'access-old',
    refreshToken: 'refresh-old',
    tokenExpiresAt: Date.now() - 1,
  })

  let calls = 0
  configureTokenStoreForTest({
    fetch: async () => {
      calls += 1
      await new Promise(resolve => setTimeout(resolve, 10))
      return {
        ok: true,
        async json() {
          return {
            access_token: 'access-new',
            refresh_token: 'refresh-new',
            expires_in: 3600,
            scope: 'playlist-read-private',
          }
        },
      }
    },
  })

  const [left, right] = await Promise.all([
    getValidAccessToken('user-1', 'spotify'),
    getValidAccessToken('user-1', 'spotify'),
  ])

  assert.equal(left, 'access-new')
  assert.equal(right, 'access-new')
  assert.equal(calls, 1)

  const row = getDatabase().prepare(`
    SELECT access_token_enc, refresh_token_enc, status
    FROM service_links
    WHERE discord_user_id = ? AND service = ?
  `).get('user-1', 'spotify')

  assert.equal(row.status, 'active')
  assert.equal(decrypt(row.access_token_enc), 'access-new')
  assert.equal(decrypt(row.refresh_token_enc), 'refresh-new')
})

test('getValidAccessToken: decrypt failure marks link needs_relink', async () => {
  upsertServiceLink({
    userId: 'user-1',
    service: 'spotify',
    accessToken: 'access-live',
    refreshToken: 'refresh-live',
    tokenExpiresAt: Date.now() + 600_000,
  })

  getDatabase().prepare(`
    UPDATE service_links
    SET access_token_enc = ?
    WHERE discord_user_id = ? AND service = ?
  `).run(Buffer.from('tampered'), 'user-1', 'spotify')

  assert.equal(await getValidAccessToken('user-1', 'spotify'), null)

  const row = getDatabase().prepare(`
    SELECT status FROM service_links
    WHERE discord_user_id = ? AND service = ?
  `).get('user-1', 'spotify')
  assert.equal(row.status, 'needs_relink')
})

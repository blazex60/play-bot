import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildWebServer } from '../index.js'
import { createMemoryDb, createTestConfig } from '../testSupport.js'

async function setup(t) {
  const db = createMemoryDb()
  t.after(() => db.close())
  const config = createTestConfig()
  const app = await buildWebServer({ config, db, fetchImpl: async () => { throw new Error('unexpected fetch') }, logger: false, startCleanup: false })
  t.after(() => app.close())
  return { db, config, app }
}

function authHeaders(config) {
  return { authorization: `Bearer ${config.botApi.token}` }
}

test('POST /internal/play-history requires the bot API bearer token', async (t) => {
  const { app } = await setup(t)
  const response = await app.inject({
    method: 'POST',
    url: '/internal/play-history',
    payload: { guildId: 'g1', discordUserId: 'u1', trackTitle: 'T', trackUrl: 'https://example.com/t' },
  })
  assert.equal(response.statusCode, 401)
})

test('POST /internal/play-history upserts discord_users and inserts a play_history row', async (t) => {
  const { app, db, config } = await setup(t)
  const response = await app.inject({
    method: 'POST',
    url: '/internal/play-history',
    headers: authHeaders(config),
    payload: {
      guildId: 'g1',
      discordUserId: 'u1',
      username: 'lemitsu',
      trackTitle: 'Song A',
      trackUrl: 'https://example.com/a',
      videoId: 'vid-a',
      channel: 'Channel A',
    },
  })
  assert.equal(response.statusCode, 200)

  const user = db.prepare('SELECT * FROM discord_users WHERE discord_id = ?').get('u1')
  assert.equal(user.username, 'lemitsu')

  const rows = db.prepare('SELECT * FROM play_history WHERE discord_user_id = ?').all('u1')
  assert.equal(rows.length, 1)
  assert.equal(rows[0].guild_id, 'g1')
  assert.equal(rows[0].video_id, 'vid-a')
  assert.equal(rows[0].channel, 'Channel A')
  assert.equal(rows[0].track_title, 'Song A')
})

test('POST /internal/play-history refreshes username on repeat plays without duplicating discord_users', async (t) => {
  const { app, db, config } = await setup(t)
  await app.inject({
    method: 'POST',
    url: '/internal/play-history',
    headers: authHeaders(config),
    payload: { guildId: 'g1', discordUserId: 'u1', username: 'old-name', trackTitle: 'A', trackUrl: 'https://example.com/a' },
  })
  await app.inject({
    method: 'POST',
    url: '/internal/play-history',
    headers: authHeaders(config),
    payload: { guildId: 'g1', discordUserId: 'u1', username: 'new-name', trackTitle: 'B', trackUrl: 'https://example.com/b' },
  })

  const users = db.prepare('SELECT * FROM discord_users WHERE discord_id = ?').all('u1')
  assert.equal(users.length, 1)
  assert.equal(users[0].username, 'new-name')

  const rows = db.prepare('SELECT * FROM play_history WHERE discord_user_id = ?').all('u1')
  assert.equal(rows.length, 2)
})

test('GET /internal/play-history/recent returns rows scoped per user, newest first', async (t) => {
  const { app, config } = await setup(t)
  const record = (discordUserId, trackTitle, videoId) =>
    app.inject({
      method: 'POST',
      url: '/internal/play-history',
      headers: authHeaders(config),
      payload: { guildId: 'g1', discordUserId, username: discordUserId, trackTitle, trackUrl: `https://example.com/${videoId}`, videoId },
    })

  await record('u1', 'First', 'v1')
  await record('u1', 'Second', 'v2')
  await record('u2', 'Other user track', 'v3')

  const response = await app.inject({
    method: 'GET',
    url: '/internal/play-history/recent?guildId=g1&userIds=u1,u2',
    headers: authHeaders(config),
  })
  assert.equal(response.statusCode, 200)
  const body = response.json()
  assert.equal(body.u1.length, 2)
  assert.equal(body.u1[0].videoId, 'v2', 'most recent play should be first')
  assert.equal(body.u2.length, 1)
  assert.equal(body.u2[0].videoId, 'v3')
})

test('POST /internal/play-history rejects a payload missing required fields', async (t) => {
  const { app, config } = await setup(t)
  const response = await app.inject({
    method: 'POST',
    url: '/internal/play-history',
    headers: authHeaders(config),
    payload: { guildId: 'g1', discordUserId: 'u1' }, // missing trackTitle/trackUrl
  })
  assert.equal(response.statusCode, 400)
})

test('GET /internal/play-history/recent requires the bot API bearer token', async (t) => {
  const { app } = await setup(t)
  const response = await app.inject({
    method: 'GET',
    url: '/internal/play-history/recent?guildId=g1&userIds=u1',
  })
  assert.equal(response.statusCode, 401)
})

test('GET /internal/play-history/recent rejects a request missing required query fields', async (t) => {
  const { app, config } = await setup(t)
  const response = await app.inject({
    method: 'GET',
    url: '/internal/play-history/recent?guildId=g1', // missing userIds
    headers: authHeaders(config),
  })
  assert.equal(response.statusCode, 400)
})

test('POST /internal/operation-log requires the bot API bearer token', async (t) => {
  const { app } = await setup(t)
  const response = await app.inject({
    method: 'POST',
    url: '/internal/operation-log',
    payload: { guildId: 'g1', source: 'command', action: 'skip' },
  })
  assert.equal(response.statusCode, 401)
})

test('POST /internal/operation-log upserts discord_users and inserts an operation_logs row', async (t) => {
  const { app, db, config } = await setup(t)
  const response = await app.inject({
    method: 'POST',
    url: '/internal/operation-log',
    headers: authHeaders(config),
    payload: {
      guildId: 'g1',
      discordUserId: 'u1',
      username: 'lemitsu',
      source: 'command',
      action: 'skip',
      detail: null,
      success: true,
    },
  })
  assert.equal(response.statusCode, 200)

  const user = db.prepare('SELECT * FROM discord_users WHERE discord_id = ?').get('u1')
  assert.equal(user.username, 'lemitsu')

  const rows = db.prepare('SELECT * FROM operation_logs WHERE discord_user_id = ?').all('u1')
  assert.equal(rows.length, 1)
  assert.equal(rows[0].guild_id, 'g1')
  assert.equal(rows[0].source, 'command')
  assert.equal(rows[0].action, 'skip')
  assert.equal(rows[0].success, 1)
})

test('POST /internal/operation-log records a blocked/failed command with success: false, still upserting the discord_users row', async (t) => {
  const { app, db, config } = await setup(t)
  const response = await app.inject({
    method: 'POST',
    url: '/internal/operation-log',
    headers: authHeaders(config),
    payload: { guildId: 'g1', discordUserId: 'u2', source: 'command', action: 'skip', detail: 'blocked', success: false },
  })
  assert.equal(response.statusCode, 200)
  const rows = db.prepare('SELECT * FROM operation_logs WHERE discord_user_id = ?').all('u2')
  assert.equal(rows.length, 1)
  assert.equal(rows[0].success, 0)
  assert.equal(rows[0].detail, 'blocked')
  const user = db.prepare('SELECT * FROM discord_users WHERE discord_id = ?').get('u2')
  assert.ok(user, 'discord_users is upserted regardless of success, same as play-history')
})

test('POST /internal/operation-log rejects a source outside the operation_logs CHECK constraint', async (t) => {
  const { app, config } = await setup(t)
  const response = await app.inject({
    method: 'POST',
    url: '/internal/operation-log',
    headers: authHeaders(config),
    payload: { guildId: 'g1', discordUserId: 'u1', source: 'bogus', action: 'skip' },
  })
  assert.equal(response.statusCode, 400)
  assert.equal(response.json().error, 'invalid_source')
})

test('POST /internal/operation-log rejects a payload missing required fields', async (t) => {
  const { app, config } = await setup(t)
  const response = await app.inject({
    method: 'POST',
    url: '/internal/operation-log',
    headers: authHeaders(config),
    payload: { guildId: 'g1' }, // missing source/action
  })
  assert.equal(response.statusCode, 400)
})

test('GET /internal/play-history/recent clamps a negative limit instead of returning unlimited rows', async (t) => {
  const { app, config } = await setup(t)
  const record = (n) =>
    app.inject({
      method: 'POST',
      url: '/internal/play-history',
      headers: authHeaders(config),
      payload: { guildId: 'g1', discordUserId: 'u1', trackTitle: `T${n}`, trackUrl: `https://example.com/${n}`, videoId: `v${n}` },
    })
  for (let i = 0; i < 201; i += 1) await record(i)

  const response = await app.inject({
    method: 'GET',
    url: '/internal/play-history/recent?guildId=g1&userIds=u1&limit=-1',
    headers: authHeaders(config),
  })
  assert.equal(response.statusCode, 200)
  assert.equal(response.json().u1.length, 200, 'a negative limit should fall back to the default cap, not become unlimited')
})

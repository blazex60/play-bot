import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildWebServer } from '../index.js'
import { createMemoryDb, createTestConfig } from '../testSupport.js'
import { ANALYSIS_VERSION } from '../../../audio/trackAnalysis.js'

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

test('PUT/GET /internal/track-analysis stores and returns analysis JSON', async (t) => {
  const { app, config } = await setup(t)
  const analysis = {
    version: ANALYSIS_VERSION,
    durationSec: 180,
    tailShape: 'fade-out',
    bpm: 128,
    confidence: 0.7,
    recommendedOverlapSec: 2,
    vocalConfidence: 0.85,
    lastVocalEndSec: 176,
  }

  const missing = await app.inject({
    method: 'GET',
    url: '/internal/track-analysis/vid-mix-1',
    headers: authHeaders(config),
  })
  assert.equal(missing.statusCode, 404)

  const put = await app.inject({
    method: 'PUT',
    url: '/internal/track-analysis/vid-mix-1',
    headers: authHeaders(config),
    payload: { analysis },
  })
  assert.equal(put.statusCode, 200)

  const get = await app.inject({
    method: 'GET',
    url: '/internal/track-analysis/vid-mix-1',
    headers: authHeaders(config),
  })
  assert.equal(get.statusCode, 200)
  assert.equal(get.json().analysis.bpm, 128)
  assert.equal(get.json().analysis.tailShape, 'fade-out')
})

test('GET /internal/track-analysis treats version 1 rows as a cache miss', async (t) => {
  const { app, config } = await setup(t)
  const put = await app.inject({
    method: 'PUT',
    url: '/internal/track-analysis/vid-stale',
    headers: authHeaders(config),
    payload: {
      analysis: {
        version: 1,
        durationSec: 120,
        tailShape: 'fade-out',
        bpm: 100,
        confidence: 0.4,
      },
    },
  })
  assert.equal(put.statusCode, 200)

  const get = await app.inject({
    method: 'GET',
    url: '/internal/track-analysis/vid-stale',
    headers: authHeaders(config),
  })
  assert.equal(get.statusCode, 404)
})

test('POST /internal/optimize-order returns a valid permutation', async (t) => {
  const { app, config } = await setup(t)
  const response = await app.inject({
    method: 'POST',
    url: '/internal/optimize-order',
    headers: authHeaders(config),
    payload: {
      anchorVideoId: 'anchor',
      tracks: [
        { videoId: 'a', title: 'Fast', duration: 180 },
        { videoId: 'b', title: 'Faster', duration: 180 },
        { videoId: 'c', title: 'Slow', duration: 180 },
      ],
    },
  })
  assert.equal(response.statusCode, 200)
  const body = response.json()
  assert.equal(body.order.length, 3)
  assert.deepEqual([...body.order].sort(), [0, 1, 2])
  assert.equal(body.source, 'algorithm')
})

test('POST /internal/optimize-order keeps algorithm order when Gemini refine is slow', async (t) => {
  const db = createMemoryDb()
  t.after(() => db.close())
  const config = createTestConfig()
  const hangingGemini = {
    refineOrder: () => new Promise(() => {}),
  }
  const app = await buildWebServer({
    config,
    db,
    gemini: hangingGemini,
    fetchImpl: async () => { throw new Error('unexpected fetch') },
    logger: false,
    startCleanup: false,
  })
  t.after(() => app.close())

  const response = await app.inject({
    method: 'POST',
    url: '/internal/optimize-order',
    headers: authHeaders(config),
    payload: {
      guildId: 'g-slow',
      tracks: [
        { videoId: 'a', title: 'A', duration: 120 },
        { videoId: 'b', title: 'B', duration: 120 },
      ],
    },
  })
  assert.equal(response.statusCode, 200)
  const body = response.json()
  assert.equal(body.source, 'algorithm')
  assert.deepEqual([...body.order].sort(), [0, 1])
})

test('POST /internal/optimize-order skips Gemini when rate-limited', async (t) => {
  const db = createMemoryDb()
  t.after(() => db.close())
  const config = createTestConfig()
  let refineCalls = 0
  const gemini = {
    async refineOrder() {
      refineCalls += 1
      return [1, 0]
    },
  }
  const { createRefineRateLimiter } = await import('../services/gemini.js')
  const refineLimiter = createRefineRateLimiter({ cooldownMs: 60_000 })
  assert.equal(refineLimiter.tryBegin('g-limited'), true)

  const Fastify = (await import('fastify')).default
  const { internalRoutes } = await import('./internal.js')
  const dedicated = Fastify({ logger: false })
  await dedicated.register(internalRoutes, {
    db,
    token: config.botApi.token,
    gemini,
    refineLimiter,
  })
  t.after(() => dedicated.close())

  const response = await dedicated.inject({
    method: 'POST',
    url: '/internal/optimize-order',
    headers: authHeaders(config),
    payload: {
      guildId: 'g-limited',
      tracks: [
        { videoId: 'a', title: 'A', duration: 120 },
        { videoId: 'b', title: 'B', duration: 120 },
      ],
    },
  })
  assert.equal(response.statusCode, 200)
  assert.equal(response.json().source, 'algorithm')
  assert.equal(refineCalls, 0)
})

test('PUT /internal/track-analysis normalizes analyzedAt milliseconds to seconds', async (t) => {
  const { app, config, db } = await setup(t)
  const ms = Date.UTC(2026, 0, 15, 12, 0, 0)

  const put = await app.inject({
    method: 'PUT',
    url: '/internal/track-analysis/vid-ms',
    headers: authHeaders(config),
    payload: {
      analysis: {
        version: 1,
        durationSec: 90,
        confidence: 0.5,
        analyzedAt: ms,
      },
    },
  })
  assert.equal(put.statusCode, 200)

  const row = db.prepare('SELECT analyzed_at AS analyzedAt FROM track_analysis WHERE video_id = ?').get('vid-ms')
  assert.equal(row.analyzedAt, Math.floor(ms / 1000))
})

test('PUT /internal/track-analysis writes vocal columns on createMemoryDb without migrations', async (t) => {
  const db = createMemoryDb()
  t.after(() => db.close())
  const config = createTestConfig()
  const Fastify = (await import('fastify')).default
  const { internalRoutes } = await import('./internal.js')
  const dedicated = Fastify({ logger: false })
  await dedicated.register(internalRoutes, { db, token: config.botApi.token })
  t.after(() => dedicated.close())

  const put = await dedicated.inject({
    method: 'PUT',
    url: '/internal/track-analysis/vid-vocal',
    headers: authHeaders(config),
    payload: {
      analysis: {
        version: 2,
        durationSec: 90,
        lastVocalEndSec: 80,
        vocalGaps: [{ startSec: 82, endSec: 90 }],
        analysisSource: 'demucs',
      },
    },
  })
  assert.equal(put.statusCode, 200)
  const row = db.prepare(
    'SELECT last_vocal_end_sec AS lastVocalEndSec, analysis_source AS analysisSource FROM track_analysis WHERE video_id = ?',
  ).get('vid-vocal')
  assert.equal(row.lastVocalEndSec, 80)
  assert.equal(row.analysisSource, 'demucs')
})

test('PUT /internal/track-analysis maps a write failure through bindRouteError instead of a bare 500', async (t) => {
  const config = createTestConfig()
  const Fastify = (await import('fastify')).default
  const { internalRoutes } = await import('./internal.js')
  const throwingDb = {
    prepare() {
      throw new Error('disk full')
    },
  }
  const dedicated = Fastify({ logger: false })
  await dedicated.register(internalRoutes, { db: throwingDb, token: config.botApi.token })
  t.after(() => dedicated.close())

  const put = await dedicated.inject({
    method: 'PUT',
    url: '/internal/track-analysis/vid-fail',
    headers: authHeaders(config),
    payload: { analysis: { version: 3, durationSec: 90 } },
  })
  assert.equal(put.statusCode, 500)
  // bindRouteError's shape ({ error, message }), not Fastify's default
  // uncaught-error shape ({ statusCode, error: 'Internal Server Error' }).
  assert.equal(put.json().error, 'disk full')
})

function fakeGenerateGemini(tracks = [{ title: 'Song A', artist: 'Artist' }]) {
  return {
    available: true,
    async generateTrackList() {
      return { playlistName: 'Generated Mix', tracks }
    },
  }
}

test('POST /internal/generate-playlist returns 503 when Gemini is the no-key stub', async (t) => {
  const db = createMemoryDb()
  t.after(() => db.close())
  const config = createTestConfig()
  const Fastify = (await import('fastify')).default
  const { internalRoutes } = await import('./internal.js')
  const { createGeminiClient } = await import('../services/gemini.js')
  const dedicated = Fastify({ logger: false })
  await dedicated.register(internalRoutes, {
    db,
    token: config.botApi.token,
    gemini: createGeminiClient({}),
  })
  t.after(() => dedicated.close())

  const response = await dedicated.inject({
    method: 'POST',
    url: '/internal/generate-playlist',
    headers: authHeaders(config),
    payload: { discordUserId: 'u1', username: 'tester', prompt: '夏' },
  })
  assert.equal(response.statusCode, 503)
  assert.equal(response.json().error, 'gemini_unavailable')
})

test('POST /internal/generate-playlist serializes generation_failed via bindRouteError', async (t) => {
  const db = createMemoryDb()
  t.after(() => db.close())
  const config = createTestConfig()
  const Fastify = (await import('fastify')).default
  const { internalRoutes } = await import('./internal.js')
  const dedicated = Fastify({ logger: false })
  await dedicated.register(internalRoutes, {
    db,
    token: config.botApi.token,
    gemini: fakeGenerateGemini([{ title: 'missing' }]),
    searchYoutube: async () => [],
  })
  t.after(() => dedicated.close())

  const response = await dedicated.inject({
    method: 'POST',
    url: '/internal/generate-playlist',
    headers: authHeaders(config),
    payload: { discordUserId: 'u1', username: 'tester', prompt: '夏' },
  })
  assert.equal(response.statusCode, 422)
  assert.equal(response.json().error, 'generation_failed')
  assert.ok(response.json().message)
})

test('POST /internal/generate-playlist persists a generated playlist', async (t) => {
  const db = createMemoryDb()
  t.after(() => db.close())
  const config = createTestConfig()
  const Fastify = (await import('fastify')).default
  const { internalRoutes } = await import('./internal.js')
  const { createGenerateRateLimiter } = await import('../services/gemini.js')
  const dedicated = Fastify({ logger: false })
  await dedicated.register(internalRoutes, {
    db,
    token: config.botApi.token,
    gemini: fakeGenerateGemini([{ title: '夜に駆ける' }]),
    generateLimiter: createGenerateRateLimiter({ cooldownMs: 0, maxConcurrent: 4 }),
    searchYoutube: async () => [{ id: 'vid-a', title: '夜に駆ける' }],
  })
  t.after(() => dedicated.close())

  const response = await dedicated.inject({
    method: 'POST',
    url: '/internal/generate-playlist',
    headers: authHeaders(config),
    payload: { discordUserId: 'u1', username: 'tester', prompt: 'YOASOBI', targetCount: 3, idempotencyKey: 'k1' },
  })
  assert.equal(response.statusCode, 200)
  const playlist = response.json().playlist
  assert.equal(playlist.tracks.length, 1)
  assert.equal(playlist.tracks[0].videoId, 'vid-a')

  const replay = await dedicated.inject({
    method: 'POST',
    url: '/internal/generate-playlist',
    headers: authHeaders(config),
    payload: { discordUserId: 'u1', username: 'tester', prompt: 'YOASOBI', targetCount: 3, idempotencyKey: 'k1' },
  })
  assert.equal(replay.statusCode, 200)
  assert.equal(replay.json().playlist.id, playlist.id)
})

test('POST /internal/generate-playlist returns 429 when rate-limited', async (t) => {
  const db = createMemoryDb()
  t.after(() => db.close())
  const config = createTestConfig()
  const Fastify = (await import('fastify')).default
  const { internalRoutes } = await import('./internal.js')
  const { createGenerateRateLimiter } = await import('../services/gemini.js')
  const generateLimiter = createGenerateRateLimiter({ cooldownMs: 60_000, maxConcurrent: 1 })
  assert.equal(generateLimiter.tryBegin('u1'), true)

  const dedicated = Fastify({ logger: false })
  await dedicated.register(internalRoutes, {
    db,
    token: config.botApi.token,
    gemini: fakeGenerateGemini(),
    generateLimiter,
  })
  t.after(() => dedicated.close())

  const response = await dedicated.inject({
    method: 'POST',
    url: '/internal/generate-playlist',
    headers: authHeaders(config),
    payload: { discordUserId: 'u1', username: 'tester', prompt: '夏' },
  })
  assert.equal(response.statusCode, 429)
  assert.equal(response.json().error, 'rate_limited')
  generateLimiter.end('u1')
})

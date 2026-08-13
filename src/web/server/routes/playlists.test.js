import assert from 'node:assert/strict'
import { test } from 'node:test'
import Fastify from 'fastify'
import { playlistsRoutes } from './playlists.js'
import { createMemoryDb } from '../testSupport.js'

function fakeBotClient({ permission = { basic: true, extended: false }, commandAllowed = true, state = { active: false }, enqueueResult } = {}) {
  const calls = []
  return {
    calls,
    permission: async () => permission,
    state: async () => state,
    async enqueueImport(guildId, payload) {
      calls.push({ type: 'enqueueImport', guildId, payload })
      return enqueueResult ?? { enqueuedCount: payload.tracks.length, matchedCount: payload.tracks.length, failedCount: 0 }
    },
    async request(method, path) {
      if (path.startsWith('/command-permission')) return { allowed: commandAllowed }
      throw new Error(`unexpected botClient.request call: ${method} ${path}`)
    },
  }
}

async function buildTestApp({ db, botClient, searchYoutube, resolveMetadata, gemini, generateLimiter, userId = 'user-1' } = {}) {
  const app = Fastify({ logger: false })
  app.addHook('preHandler', async (request) => {
    request.user = { discordId: userId, username: 'tester' }
  })
  await app.register(playlistsRoutes, { db, botClient, searchYoutube, resolveMetadata, gemini, generateLimiter })
  return app
}

function seedUser(db, discordId = 'user-1') {
  db.prepare(`INSERT INTO discord_users (discord_id, username, created_at, last_seen_at) VALUES (?, ?, 1, 1)`).run(discordId, discordId)
}

async function setup(t, options = {}) {
  const db = createMemoryDb()
  t.after(() => db.close())
  seedUser(db, options.userId)
  const app = await buildTestApp({ db, ...options })
  t.after(() => app.close())
  return { db, app }
}

test('POST /api/playlists/mine creates an empty playlist, and GET /mine lists it', async (t) => {
  const { app } = await setup(t)

  const created = await app.inject({ method: 'POST', url: '/api/playlists/mine', payload: { name: 'My Mix' } })
  assert.equal(created.statusCode, 200)
  const playlist = created.json()
  assert.equal(playlist.name, 'My Mix')
  assert.equal(playlist.trackCount, 0)

  const listed = await app.inject({ method: 'GET', url: '/api/playlists/mine' })
  assert.equal(listed.statusCode, 200)
  assert.deepEqual(listed.json().playlists.map((p) => p.name), ['My Mix'])
})

test('POST /api/playlists/mine rejects a blank name', async (t) => {
  const { app } = await setup(t)
  const response = await app.inject({ method: 'POST', url: '/api/playlists/mine', payload: { name: '  ' } })
  assert.equal(response.statusCode, 400)
})

test('GET /api/playlists/mine/:id 404s for a playlist owned by another user', async (t) => {
  const { db, app } = await setup(t)
  seedUser(db, 'other-user')
  const otherApp = await buildTestApp({ db, userId: 'other-user' })
  t.after(() => otherApp.close())

  const created = await otherApp.inject({ method: 'POST', url: '/api/playlists/mine', payload: { name: 'Not Yours' } })
  const { id } = created.json()

  const response = await app.inject({ method: 'GET', url: `/api/playlists/mine/${id}` })
  assert.equal(response.statusCode, 404)
})

test('PATCH renames a playlist and DELETE removes it', async (t) => {
  const { app } = await setup(t)
  const created = await app.inject({ method: 'POST', url: '/api/playlists/mine', payload: { name: 'Old Name' } })
  const { id } = created.json()

  const renamed = await app.inject({ method: 'PATCH', url: `/api/playlists/mine/${id}`, payload: { name: 'New Name' } })
  assert.equal(renamed.statusCode, 200)
  assert.equal(renamed.json().name, 'New Name')

  const deleted = await app.inject({ method: 'DELETE', url: `/api/playlists/mine/${id}` })
  assert.equal(deleted.statusCode, 200)

  const getAfterDelete = await app.inject({ method: 'GET', url: `/api/playlists/mine/${id}` })
  assert.equal(getAfterDelete.statusCode, 404)
})

test('adding a track by explicit track object, then removing and moving tracks', async (t) => {
  const { app } = await setup(t)
  const created = await app.inject({ method: 'POST', url: '/api/playlists/mine', payload: { name: 'Mix' } })
  const { id } = created.json()

  const addA = await app.inject({
    method: 'POST',
    url: `/api/playlists/mine/${id}/tracks`,
    payload: { track: { title: 'Track A', webpageUrl: 'https://www.youtube.com/watch?v=aaaaaaaaaaa' } },
  })
  assert.equal(addA.statusCode, 200)
  const addB = await app.inject({
    method: 'POST',
    url: `/api/playlists/mine/${id}/tracks`,
    payload: { track: { title: 'Track B', webpageUrl: 'https://www.youtube.com/watch?v=bbbbbbbbbbb' } },
  })
  assert.equal(addB.statusCode, 200)
  const tracksAfterAdd = addB.json().tracks
  assert.deepEqual(tracksAfterAdd.map((t) => t.title), ['Track A', 'Track B'])

  const moved = await app.inject({
    method: 'POST',
    url: `/api/playlists/mine/${id}/tracks/move`,
    payload: { fromIndex: 0, toIndex: 1 },
  })
  assert.equal(moved.statusCode, 200)
  assert.equal(moved.json().ok, true)
  assert.deepEqual(moved.json().tracks.map((t) => t.title), ['Track B', 'Track A'])

  const trackIdToRemove = moved.json().tracks[0].id
  const removed = await app.inject({ method: 'DELETE', url: `/api/playlists/mine/${id}/tracks/${trackIdToRemove}` })
  assert.equal(removed.statusCode, 200)
  assert.deepEqual(removed.json().tracks.map((t) => t.title), ['Track A'])
})

test('POST /api/playlists/mine/:id/tracks rejects a track object missing a valid webpageUrl', async (t) => {
  const { app } = await setup(t)
  const created = await app.inject({ method: 'POST', url: '/api/playlists/mine', payload: { name: 'Mix' } })
  const { id } = created.json()

  const response = await app.inject({
    method: 'POST',
    url: `/api/playlists/mine/${id}/tracks`,
    payload: { track: { title: 'Bad Track', webpageUrl: 'not-a-url' } },
  })
  assert.equal(response.statusCode, 400)
})

test('POST /api/playlists/mine/:id/search returns matched YouTube results via the injected searchYoutube', async (t) => {
  const searchYoutube = async (query) => [
    { id: 'vid1', title: `Result for ${query}`, url: 'https://youtu.be/vid1', duration: 120, channel: 'Chan' },
  ]
  const { app } = await setup(t, { searchYoutube })
  const created = await app.inject({ method: 'POST', url: '/api/playlists/mine', payload: { name: 'Mix' } })
  const { id } = created.json()

  const response = await app.inject({ method: 'POST', url: `/api/playlists/mine/${id}/search`, payload: { query: 'lofi' } })
  assert.equal(response.statusCode, 200)
  assert.deepEqual(response.json().results.map((r) => r.title), ['Result for lofi'])
})

test('POST /api/playlists/mine/:id/tracks resolves a track by URL via the injected resolveMetadata', async (t) => {
  const resolveMetadata = async (url, { requestedBy, requestedById }) => ({
    title: 'Resolved Track',
    webpageUrl: url,
    duration: 200,
    requestedBy,
    requestedById,
    thumbnail: null,
    videoId: 'resolved-1',
    channel: 'Chan',
  })
  const { app } = await setup(t, { resolveMetadata })
  const created = await app.inject({ method: 'POST', url: '/api/playlists/mine', payload: { name: 'Mix' } })
  const { id } = created.json()

  const response = await app.inject({
    method: 'POST',
    url: `/api/playlists/mine/${id}/tracks`,
    payload: { url: 'https://www.youtube.com/watch?v=resolved1' },
  })
  assert.equal(response.statusCode, 200)
  assert.deepEqual(response.json().tracks.map((t) => t.title), ['Resolved Track'])
})

test('POST /api/playlists/mine/:id/queue enqueues to the bot without a bot-permission check when no session is active', async (t) => {
  const botClient = fakeBotClient({ state: { active: false } })
  const { app } = await setup(t, { botClient })
  const created = await app.inject({ method: 'POST', url: '/api/playlists/mine', payload: { name: 'Mix' } })
  const { id } = created.json()
  await app.inject({
    method: 'POST',
    url: `/api/playlists/mine/${id}/tracks`,
    payload: { track: { title: 'Track A', webpageUrl: 'https://www.youtube.com/watch?v=aaaaaaaaaaa' } },
  })

  const response = await app.inject({
    method: 'POST',
    url: `/api/playlists/mine/${id}/queue`,
    payload: { guildId: 'guild-1' },
  })
  assert.equal(response.statusCode, 200)
  assert.equal(response.json().ok, true)
  assert.equal(response.json().enqueuedCount, 1)
  assert.equal(botClient.calls[0].guildId, 'guild-1')
})

test('POST /api/playlists/mine/:id/queue requires bot-permission (VC co-presence) when a session is already active', async (t) => {
  const botClient = fakeBotClient({ state: { active: true }, permission: { basic: false, extended: false } })
  const { app } = await setup(t, { botClient })
  const created = await app.inject({ method: 'POST', url: '/api/playlists/mine', payload: { name: 'Mix' } })
  const { id } = created.json()
  await app.inject({
    method: 'POST',
    url: `/api/playlists/mine/${id}/tracks`,
    payload: { track: { title: 'Track A', webpageUrl: 'https://www.youtube.com/watch?v=aaaaaaaaaaa' } },
  })

  const response = await app.inject({
    method: 'POST',
    url: `/api/playlists/mine/${id}/queue`,
    payload: { guildId: 'guild-1' },
  })
  assert.equal(response.statusCode, 403)
  assert.equal(botClient.calls.length, 0, 'must not enqueue when the bot-permission check fails')
})

test('POST /api/playlists/mine/:id/queue rejects an empty playlist', async (t) => {
  const botClient = fakeBotClient()
  const { app } = await setup(t, { botClient })
  const created = await app.inject({ method: 'POST', url: '/api/playlists/mine', payload: { name: 'Empty' } })
  const { id } = created.json()

  const response = await app.inject({
    method: 'POST',
    url: `/api/playlists/mine/${id}/queue`,
    payload: { guildId: 'guild-1' },
  })
  assert.equal(response.statusCode, 400)
  assert.equal(response.json().error, 'playlist_empty')
})

test('POST /api/playlists/mine/generate returns 503 when Gemini is unavailable', async (t) => {
  const { createGeminiClient } = await import('../services/gemini.js')
  const { app } = await setup(t, { gemini: createGeminiClient({}) })
  const response = await app.inject({
    method: 'POST',
    url: '/api/playlists/mine/generate',
    payload: { prompt: '夏のJ-POP' },
  })
  assert.equal(response.statusCode, 503)
  assert.equal(response.json().error, 'gemini_unavailable')
})

test('POST /api/playlists/mine/generate saves a playlist from Gemini suggestions', async (t) => {
  const { createGenerateRateLimiter } = await import('../services/gemini.js')
  const gemini = {
    available: true,
    async generateTrackList() {
      return { playlistName: 'Summer', tracks: [{ title: '夜に駆ける' }] }
    },
  }
  const searchYoutube = async () => [{ id: 'vid-gen', title: '夜に駆ける' }]
  const { app } = await setup(t, {
    gemini,
    searchYoutube,
    generateLimiter: createGenerateRateLimiter({ cooldownMs: 0, maxConcurrent: 4 }),
  })

  const response = await app.inject({
    method: 'POST',
    url: '/api/playlists/mine/generate',
    payload: { prompt: 'YOASOBI 夏', count: 3 },
  })
  assert.equal(response.statusCode, 200)
  assert.equal(response.json().playlist.name, 'Summer')
  assert.equal(response.json().playlist.tracks[0].videoId, 'vid-gen')
})

test('POST /api/playlists/mine/generate returns 429 when rate-limited', async (t) => {
  const { createGenerateRateLimiter } = await import('../services/gemini.js')
  const generateLimiter = createGenerateRateLimiter({ cooldownMs: 60_000, maxConcurrent: 1 })
  assert.equal(generateLimiter.tryBegin('user-1'), true)
  const { app } = await setup(t, {
    gemini: { available: true, generateTrackList: async () => ({ tracks: [{ title: 'A' }] }) },
    generateLimiter,
  })
  const response = await app.inject({
    method: 'POST',
    url: '/api/playlists/mine/generate',
    payload: { prompt: 'rate limit me' },
  })
  assert.equal(response.statusCode, 429)
  assert.equal(response.json().error, 'rate_limited')
  generateLimiter.end('user-1')
})

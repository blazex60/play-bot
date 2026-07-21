import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildWebServer } from './index.js'
import { createMemoryDb, createTestConfig } from './testSupport.js'

function createRoutedFetch({ discordToken, discordUser, botResponses = {} }) {
  const calls = []
  const requests = []
  const fetchImpl = async (url, options = {}) => {
    const href = url.toString()
    calls.push(href)
    requests.push({ href, options })
    if (href === 'https://discord.com/api/oauth2/token') {
      return { ok: true, status: 200, text: async () => JSON.stringify(discordToken) }
    }
    if (href === 'https://discord.com/api/users/@me') {
      return { ok: true, status: 200, text: async () => JSON.stringify(discordUser) }
    }
    const parsed = new URL(href)
    const canned = botResponses[parsed.pathname]
    if (canned) {
      return {
        ok: canned.ok ?? true,
        status: canned.status ?? 200,
        text: async () => JSON.stringify(canned.body ?? {}),
      }
    }
    throw new Error(`Unexpected fetch call in test: ${href}`)
  }
  fetchImpl.calls = calls
  fetchImpl.requests = requests
  return fetchImpl
}

async function loginAndGetCookie(app) {
  const authorize = await app.inject({ method: 'GET', url: '/auth/discord?redirect=/' })
  const state = new URL(authorize.headers.location).searchParams.get('state')
  const callback = await app.inject({ method: 'GET', url: `/auth/discord/callback?code=abc&state=${state}` })
  assert.equal(callback.statusCode, 302, 'login callback should redirect after establishing a session')
  return callback.headers['set-cookie']
}

test('buildWebServer runs migrations automatically so a fresh DB has the full schema', async (t) => {
  const db = createMemoryDb()
  t.after(() => db.close())
  const config = createTestConfig()
  const fetchImpl = createRoutedFetch({ discordToken: {}, discordUser: {}, botResponses: {} })

  const app = await buildWebServer({ config, db, fetchImpl, logger: false, startCleanup: false })
  t.after(() => app.close())

  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
    .all()
    .map((row) => row.name)

  for (const expected of ['schema_migrations', 'service_links', 'import_jobs', 'import_tracks', 'user_playlists', 'user_playlist_tracks']) {
    assert.ok(tables.includes(expected), `migrations should create ${expected} even though testSupport's memory db pre-creates only 3 tables`)
  }
})

test('dashboard API routes are registered and require authentication (regression: buildWebServer previously never mounted them)', async (t) => {
  const db = createMemoryDb()
  t.after(() => db.close())
  const config = createTestConfig()
  const fetchImpl = createRoutedFetch({ discordToken: {}, discordUser: {}, botResponses: {} })
  const app = await buildWebServer({ config, db, fetchImpl, logger: false, startCleanup: false })
  t.after(() => app.close())

  /** @type {{ method: 'GET' | 'POST', url: string }[]} */
  const protectedRoutes = [
    { method: 'GET', url: '/api/state/g1' },
    { method: 'GET', url: '/api/links' },
    { method: 'GET', url: '/api/permission?guildId=g1' },
    { method: 'POST', url: '/api/guilds/g1/control/pause' },
    { method: 'POST', url: '/api/guilds/g1/queue/remove' },
    { method: 'POST', url: '/api/import/g1' },
    { method: 'GET', url: '/api/import/jobs/1/tracks' },
    { method: 'GET', url: '/api/playlists/mine' },
    { method: 'POST', url: '/api/playlists/mine' },
    { method: 'GET', url: '/api/playlists/mine/1' },
    { method: 'PATCH', url: '/api/playlists/mine/1' },
    { method: 'DELETE', url: '/api/playlists/mine/1' },
    { method: 'POST', url: '/api/playlists/mine/1/search' },
    { method: 'POST', url: '/api/playlists/mine/1/tracks' },
    { method: 'DELETE', url: '/api/playlists/mine/1/tracks/1' },
    { method: 'POST', url: '/api/playlists/mine/1/tracks/move' },
    { method: 'POST', url: '/api/playlists/mine/1/queue' },
    { method: 'GET', url: '/api/admin/g1/permissions' },
    { method: 'POST', url: '/api/admin/g1/permissions/default' },
    { method: 'POST', url: '/api/admin/g1/permissions/user' },
    { method: 'GET', url: '/api/admin/g1/visibility' },
    { method: 'POST', url: '/api/admin/g1/visibility' },
    { method: 'GET', url: '/api/admin/g1/logs' },
  ]

  for (const route of protectedRoutes) {
    const response = await app.inject({ method: route.method, url: route.url })
    assert.notEqual(response.statusCode, 404, `${route.method} ${route.url} must be registered (not 404)`)
    assert.equal(response.statusCode, 401, `${route.method} ${route.url} must require authentication when no session cookie is sent`)
  }
})

test('authenticated session can read state/links/permission and issue control+queue commands end-to-end', async (t) => {
  const db = createMemoryDb()
  t.after(() => db.close())
  const config = createTestConfig()
  const fetchImpl = createRoutedFetch({
    discordToken: { access_token: 'discord-access' },
    discordUser: { id: 'u1', username: 'lemitsu' },
    botResponses: {
      '/state/g1': { body: { current: null, upcoming: [], playerStatus: 'idle', loopMode: 'off' } },
      '/permission': { body: { basic: true, extended: false } },
      '/control/g1/pause': { body: { ok: true } },
      '/queue/g1/remove': { body: { ok: true } },
    },
  })
  const app = await buildWebServer({ config, db, fetchImpl, logger: false, startCleanup: false })
  t.after(() => app.close())

  const cookie = await loginAndGetCookie(app)

  const state = await app.inject({ method: 'GET', url: '/api/state/g1', headers: { cookie } })
  assert.equal(state.statusCode, 200)
  assert.equal(state.json().playerStatus, 'idle')

  const links = await app.inject({ method: 'GET', url: '/api/links', headers: { cookie } })
  assert.equal(links.statusCode, 200)
  assert.deepEqual(
    links.json().services.map((s) => s.service).sort(),
    ['youtube']
  )

  const permission = await app.inject({ method: 'GET', url: '/api/permission?guildId=g1', headers: { cookie } })
  assert.equal(permission.statusCode, 200)
  assert.equal(permission.json().basic, true)

  const control = await app.inject({
    method: 'POST',
    url: '/api/guilds/g1/control/pause',
    headers: { cookie },
  })
  assert.equal(control.statusCode, 200, 'control route must reach the bot API via botClient.request (callBot contract)')
  const controlRequest = fetchImpl.requests.find((r) => r.href.endsWith('/control/g1/pause'))
  assert.equal(
    JSON.parse(controlRequest.options.body).userId,
    'u1',
    'control route must inject the authenticated session user id (regression: dashboard controls got userId_required since the client never sent one)'
  )

  const queue = await app.inject({
    method: 'POST',
    url: '/api/guilds/g1/queue/remove',
    headers: { cookie },
    payload: { index: 0 },
  })
  assert.equal(queue.statusCode, 200, 'queue route must reach the bot API via botClient.request (callBot contract)')
  const queueRequest = fetchImpl.requests.find((r) => r.href.endsWith('/queue/g1/remove'))
  assert.equal(JSON.parse(queueRequest.options.body).userId, 'u1', 'queue route must inject the authenticated session user id')
  assert.equal(JSON.parse(queueRequest.options.body).index, 0, 'queue route must still forward the rest of the request body')
})

test('/api/state/:guildId requires bot permission for that guild (regression: was reachable by any authenticated session for any guild)', async (t) => {
  const db = createMemoryDb()
  t.after(() => db.close())
  const config = createTestConfig()
  const fetchImpl = createRoutedFetch({
    discordToken: { access_token: 'discord-access' },
    discordUser: { id: 'u1', username: 'lemitsu' },
    botResponses: {
      '/permission': { body: { basic: false, extended: false } },
    },
  })
  const app = await buildWebServer({ config, db, fetchImpl, logger: false, startCleanup: false })
  t.after(() => app.close())
  const cookie = await loginAndGetCookie(app)

  const state = await app.inject({ method: 'GET', url: '/api/state/some-other-guild', headers: { cookie } })
  assert.equal(state.statusCode, 403, 'a session user with no permission in the guild must not read its playback state')
})

test('/api/import/jobs/:jobId/tracks only returns tracks for the requesting user\'s own job (regression: IDOR across import jobs)', async (t) => {
  const db = createMemoryDb()
  t.after(() => db.close())
  const config = createTestConfig()
  const fetchImpl = createRoutedFetch({
    discordToken: { access_token: 'discord-access' },
    discordUser: { id: 'u1', username: 'lemitsu' },
    botResponses: {},
  })
  const app = await buildWebServer({ config, db, fetchImpl, logger: false, startCleanup: false })
  t.after(() => app.close())
  const cookie = await loginAndGetCookie(app)

  db.prepare(`
    INSERT INTO discord_users (discord_id, username, created_at, last_seen_at)
    VALUES ('other-user', 'someone-else', ?, ?)
  `).run(Date.now(), Date.now())
  const job = db.prepare(`
    INSERT INTO import_jobs (discord_user_id, guild_id, service, playlist_id, playlist_name, created_at)
    VALUES ('other-user', 'g1', 'youtube', 'pl1', 'Other users playlist', ?)
  `).run(Date.now())

  const response = await app.inject({
    method: 'GET',
    url: `/api/import/jobs/${job.lastInsertRowid}/tracks`,
    headers: { cookie },
  })
  assert.equal(response.statusCode, 404, 'must not expose another user\'s import job tracks')
})

test('/api/permission ignores a client-supplied userId and always uses the session user', async (t) => {
  const db = createMemoryDb()
  t.after(() => db.close())
  const config = createTestConfig()
  const fetchImpl = createRoutedFetch({
    discordToken: { access_token: 'discord-access' },
    discordUser: { id: 'u1', username: 'lemitsu' },
    botResponses: {
      '/permission': { body: { basic: true } },
    },
  })
  const app = await buildWebServer({ config, db, fetchImpl, logger: false, startCleanup: false })
  t.after(() => app.close())
  const cookie = await loginAndGetCookie(app)

  await app.inject({ method: 'GET', url: '/api/permission?guildId=g1&userId=someone-else', headers: { cookie } })

  const permissionCall = fetchImpl.calls.find((url) => url.includes('/permission'))
  assert.ok(permissionCall.includes('userId=u1'), 'must query permission for the authenticated session user, not the query-string userId')
  assert.ok(!permissionCall.includes('someone-else'))
})


test('authenticated user can disconnect a linked OAuth service and tokens are removed', async (t) => {
  const db = createMemoryDb()
  t.after(() => db.close())
  const config = createTestConfig()
  const fetchImpl = createRoutedFetch({
    discordToken: { access_token: 'discord-access' },
    discordUser: { id: 'u1', username: 'lemitsu' },
    botResponses: {},
  })
  const app = await buildWebServer({ config, db, fetchImpl, logger: false, startCleanup: false })
  t.after(() => app.close())
  const cookie = await loginAndGetCookie(app)
  db.prepare(`
    INSERT INTO service_links (
      discord_user_id,
      service,
      access_token_enc,
      refresh_token_enc,
      key_id,
      status,
      created_at,
      updated_at
    )
    VALUES (?, ?, ?, ?, ?, 'active', ?, ?)
  `).run('u1', 'youtube', Buffer.from('access'), Buffer.from('refresh'), 'test-key', Date.now(), Date.now())

  const response = await app.inject({
    method: 'DELETE',
    url: '/api/links/youtube',
    headers: { cookie },
  })

  assert.equal(response.statusCode, 200)
  assert.deepEqual(response.json(), {
    service: 'youtube',
    linked: false,
    status: 'unlinked',
    tokenExpiresAt: null,
    updatedAt: null,
  })
  const remaining = db.prepare(`
    SELECT COUNT(*) AS count
    FROM service_links
    WHERE discord_user_id = ? AND service = ?
  `).get('u1', 'youtube')
  assert.equal(remaining.count, 0)
})

test('disconnect rejects unknown OAuth services', async (t) => {
  const db = createMemoryDb()
  t.after(() => db.close())
  const config = createTestConfig()
  const fetchImpl = createRoutedFetch({
    discordToken: { access_token: 'discord-access' },
    discordUser: { id: 'u1', username: 'lemitsu' },
    botResponses: {},
  })
  const app = await buildWebServer({ config, db, fetchImpl, logger: false, startCleanup: false })
  t.after(() => app.close())
  const cookie = await loginAndGetCookie(app)

  const response = await app.inject({
    method: 'DELETE',
    url: '/api/links/apple',
    headers: { cookie },
  })

  assert.equal(response.statusCode, 404)
  assert.equal(response.json().error, 'unknown_service')
})

test('authenticated user can create, edit, reorder, and queue a saved playlist', async (t) => {
  const db = createMemoryDb()
  t.after(() => db.close())
  const config = createTestConfig()
  const fetchImpl = createRoutedFetch({
    discordToken: { access_token: 'discord-access' },
    discordUser: { id: 'u1', username: 'lemitsu' },
    botResponses: {
      '/state/g1': { body: { active: true, current: null, upcoming: [], playerStatus: 'idle', loopMode: 'off' } },
      '/permission': { body: { basic: true, extended: false } },
      '/import/g1/enqueue': { body: { ok: true, enqueuedCount: 2, matchedCount: 2, failedCount: 0 } },
    },
  })
  const app = await buildWebServer({ config, db, fetchImpl, logger: false, startCleanup: false })
  t.after(() => app.close())
  const cookie = await loginAndGetCookie(app)

  const createResponse = await app.inject({
    method: 'POST',
    url: '/api/playlists/mine',
    headers: { cookie },
    payload: { name: '作業用BGM' },
  })
  assert.equal(createResponse.statusCode, 200)
  const playlist = createResponse.json()
  assert.equal(playlist.name, '作業用BGM')
  assert.equal(playlist.trackCount, 0)

  const list = await app.inject({ method: 'GET', url: '/api/playlists/mine', headers: { cookie } })
  assert.equal(list.statusCode, 200)
  assert.equal(list.json().playlists.length, 1)

  const rejectedTrack = await app.inject({
    method: 'POST',
    url: `/api/playlists/mine/${playlist.id}/tracks`,
    headers: { cookie },
    payload: { track: { title: 'Malicious', webpageUrl: 'javascript:alert(1)' } },
  })
  assert.equal(rejectedTrack.statusCode, 400, 'must reject a track.webpageUrl that is not an http(s) URL (regression: unvalidated URL could be stored and later fed to yt-dlp)')

  const addFirst = await app.inject({
    method: 'POST',
    url: `/api/playlists/mine/${playlist.id}/tracks`,
    headers: { cookie },
    payload: { track: { title: 'Track A', webpageUrl: 'https://www.youtube.com/watch?v=aaaaaaaaaaa', videoId: 'aaaaaaaaaaa' } },
  })
  assert.equal(addFirst.statusCode, 200)
  assert.equal(addFirst.json().tracks.length, 1)

  const addSecond = await app.inject({
    method: 'POST',
    url: `/api/playlists/mine/${playlist.id}/tracks`,
    headers: { cookie },
    payload: { track: { title: 'Track B', webpageUrl: 'https://www.youtube.com/watch?v=bbbbbbbbbbb', videoId: 'bbbbbbbbbbb' } },
  })
  assert.equal(addSecond.statusCode, 200)
  assert.deepEqual(addSecond.json().tracks.map((track) => track.title), ['Track A', 'Track B'])

  const move = await app.inject({
    method: 'POST',
    url: `/api/playlists/mine/${playlist.id}/tracks/move`,
    headers: { cookie },
    payload: { fromIndex: 0, toIndex: 1 },
  })
  assert.equal(move.statusCode, 200)
  assert.deepEqual(move.json().tracks.map((track) => track.title), ['Track B', 'Track A'])

  const detail = await app.inject({ method: 'GET', url: `/api/playlists/mine/${playlist.id}`, headers: { cookie } })
  assert.equal(detail.statusCode, 200)
  assert.equal(detail.json().tracks.length, 2)

  const rename = await app.inject({
    method: 'PATCH',
    url: `/api/playlists/mine/${playlist.id}`,
    headers: { cookie },
    payload: { name: '深夜作業用' },
  })
  assert.equal(rename.statusCode, 200)
  assert.equal(rename.json().name, '深夜作業用')

  const removeTrackId = move.json().tracks[0].id
  const remove = await app.inject({
    method: 'DELETE',
    url: `/api/playlists/mine/${playlist.id}/tracks/${removeTrackId}`,
    headers: { cookie },
  })
  assert.equal(remove.statusCode, 200)
  assert.deepEqual(remove.json().tracks.map((track) => track.title), ['Track A'])

  const queue = await app.inject({
    method: 'POST',
    url: `/api/playlists/mine/${playlist.id}/queue`,
    headers: { cookie },
    payload: { guildId: 'g1' },
  })
  assert.equal(queue.statusCode, 200, 'queueing must reach the bot API via botClient.enqueueImport')
  assert.equal(queue.json().enqueuedCount, 2)
  const enqueueRequest = fetchImpl.requests.find((r) => r.href.endsWith('/import/g1/enqueue'))
  assert.ok(enqueueRequest, 'must call the bot enqueue endpoint')
  assert.equal(JSON.parse(enqueueRequest.options.body).userId, 'u1', 'must inject the authenticated session user id')

  const del = await app.inject({ method: 'DELETE', url: `/api/playlists/mine/${playlist.id}`, headers: { cookie } })
  assert.equal(del.statusCode, 200)
  const listAfterDelete = await app.inject({ method: 'GET', url: '/api/playlists/mine', headers: { cookie } })
  assert.equal(listAfterDelete.json().playlists.length, 0)
})

test('queueing a saved playlist into a guild with no active bot session skips the permission check (regression: a user starting playback for the first time was wrongly 403d)', async (t) => {
  const db = createMemoryDb()
  t.after(() => db.close())
  const config = createTestConfig()
  const fetchImpl = createRoutedFetch({
    discordToken: { access_token: 'discord-access' },
    discordUser: { id: 'u1', username: 'lemitsu' },
    botResponses: {
      // No '/permission' entry: if the route calls it, createRoutedFetch throws
      // "Unexpected fetch call", failing this test loudly.
      '/state/g2': { body: { active: false, autoplayMode: 'off', personalize: false } },
      '/import/g2/enqueue': { body: { ok: true, enqueuedCount: 1, matchedCount: 1, failedCount: 0 } },
    },
  })
  const app = await buildWebServer({ config, db, fetchImpl, logger: false, startCleanup: false })
  t.after(() => app.close())
  const cookie = await loginAndGetCookie(app)

  const createResponse = await app.inject({
    method: 'POST',
    url: '/api/playlists/mine',
    headers: { cookie },
    payload: { name: 'Solo BGM' },
  })
  const playlist = createResponse.json()

  await app.inject({
    method: 'POST',
    url: `/api/playlists/mine/${playlist.id}/tracks`,
    headers: { cookie },
    payload: { track: { title: 'Track A', webpageUrl: 'https://www.youtube.com/watch?v=aaaaaaaaaaa', videoId: 'aaaaaaaaaaa' } },
  })

  const queue = await app.inject({
    method: 'POST',
    url: `/api/playlists/mine/${playlist.id}/queue`,
    headers: { cookie },
    payload: { guildId: 'g2' },
  })
  assert.equal(queue.statusCode, 200, 'must not require bot permission when there is no live session to protect')
  assert.equal(queue.json().enqueuedCount, 1)
})

test('/api/playlists/mine/:id only exposes the requesting user\'s own playlist (regression: IDOR across saved playlists)', async (t) => {
  const db = createMemoryDb()
  t.after(() => db.close())
  const config = createTestConfig()
  const fetchImpl = createRoutedFetch({
    discordToken: { access_token: 'discord-access' },
    discordUser: { id: 'u1', username: 'lemitsu' },
    botResponses: {},
  })
  const app = await buildWebServer({ config, db, fetchImpl, logger: false, startCleanup: false })
  t.after(() => app.close())
  const cookie = await loginAndGetCookie(app)

  db.prepare(`
    INSERT INTO discord_users (discord_id, username, created_at, last_seen_at)
    VALUES ('other-user', 'someone-else', ?, ?)
  `).run(Date.now(), Date.now())
  const otherPlaylist = db.prepare(`
    INSERT INTO user_playlists (discord_user_id, name, created_at, updated_at)
    VALUES ('other-user', 'Other users playlist', ?, ?)
  `).run(Date.now(), Date.now())

  const response = await app.inject({
    method: 'GET',
    url: `/api/playlists/mine/${otherPlaylist.lastInsertRowid}`,
    headers: { cookie },
  })
  assert.equal(response.statusCode, 404, 'must not expose another user\'s saved playlist')

  const deleteResponse = await app.inject({
    method: 'DELETE',
    url: `/api/playlists/mine/${otherPlaylist.lastInsertRowid}`,
    headers: { cookie },
  })
  assert.equal(deleteResponse.statusCode, 404, 'must not allow deleting another user\'s saved playlist')
  assert.equal(
    db.prepare('SELECT COUNT(*) AS count FROM user_playlists WHERE id = ?').get(otherPlaylist.lastInsertRowid).count,
    1,
    'the other user\'s playlist row must still exist'
  )
})

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildWebServer } from './index.js'
import { createMemoryDb, createTestConfig } from './testSupport.js'

function createRoutedFetch({ discordToken, discordUser, botResponses = {} }) {
  const calls = []
  const fetchImpl = async (url, _options = {}) => {
    const href = url.toString()
    calls.push(href)
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

  for (const expected of ['schema_migrations', 'service_links', 'import_jobs', 'import_tracks']) {
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

  const protectedRoutes = [
    { method: 'GET', url: '/api/state/g1' },
    { method: 'GET', url: '/api/links' },
    { method: 'GET', url: '/api/permission?guildId=g1' },
    { method: 'POST', url: '/api/guilds/g1/control/pause' },
    { method: 'POST', url: '/api/guilds/g1/queue/remove' },
    { method: 'POST', url: '/api/import/g1' },
    { method: 'GET', url: '/api/import/jobs/1/tracks' },
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
    ['spotify', 'youtube']
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

  const queue = await app.inject({
    method: 'POST',
    url: '/api/guilds/g1/queue/remove',
    headers: { cookie },
    payload: { index: 0 },
  })
  assert.equal(queue.statusCode, 200, 'queue route must reach the bot API via botClient.request (callBot contract)')
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

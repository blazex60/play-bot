import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildWebServer } from '../index.js'
import { createMemoryDb, createTestConfig } from '../testSupport.js'

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
  return callback.headers['set-cookie']
}

test('admin routes reject a session without extended (admin role) permission', async (t) => {
  const db = createMemoryDb()
  t.after(() => db.close())
  const config = createTestConfig()
  const fetchImpl = createRoutedFetch({
    discordToken: { access_token: 'discord-access' },
    discordUser: { id: 'u1', username: 'lemitsu' },
    botResponses: { '/permission': { body: { basic: true, extended: false } } },
  })
  const app = await buildWebServer({ config, db, fetchImpl, logger: false, startCleanup: false })
  t.after(() => app.close())
  const cookie = await loginAndGetCookie(app)

  const response = await app.inject({ method: 'GET', url: '/api/admin/g1/permissions', headers: { cookie } })
  assert.equal(response.statusCode, 403, 'a VC-only (basic) permission must not grant admin access')
})

test('admin permissions route returns the command matrix plus guild-scoped known users', async (t) => {
  const db = createMemoryDb()
  t.after(() => db.close())
  const config = createTestConfig()
  const fetchImpl = createRoutedFetch({
    discordToken: { access_token: 'discord-access' },
    discordUser: { id: 'admin-1', username: 'admin-user' },
    botResponses: {
      '/permission': { body: { basic: true, extended: true } },
      '/admin/g1/permissions': { body: { commands: ['skip', 'play'], defaults: { skip: 'deny' }, overrides: {} } },
    },
  })
  const app = await buildWebServer({ config, db, fetchImpl, logger: false, startCleanup: false })
  t.after(() => app.close())
  const cookie = await loginAndGetCookie(app)

  db.prepare(`INSERT INTO discord_users (discord_id, username, created_at, last_seen_at) VALUES ('known-1', 'knownUser', ?, ?)`).run(Date.now(), Date.now())
  db.prepare(`
    INSERT INTO play_history (guild_id, discord_user_id, track_title, track_url, played_at)
    VALUES ('g1', 'known-1', 'Song', 'https://example.com/song', ?)
  `).run(Date.now())
  db.prepare(`INSERT INTO discord_users (discord_id, username, created_at, last_seen_at) VALUES ('other-guild-user', 'otherGuild', ?, ?)`).run(Date.now(), Date.now())
  db.prepare(`
    INSERT INTO play_history (guild_id, discord_user_id, track_title, track_url, played_at)
    VALUES ('g2', 'other-guild-user', 'Song', 'https://example.com/song', ?)
  `).run(Date.now())

  const response = await app.inject({ method: 'GET', url: '/api/admin/g1/permissions', headers: { cookie } })
  assert.equal(response.statusCode, 200)
  const body = response.json()
  assert.deepEqual(body.defaults, { skip: 'deny' })
  assert.deepEqual(body.knownUsers, [{ discordId: 'known-1', username: 'knownUser' }])

  const adminCall = fetchImpl.requests.find((r) => r.href.includes('/admin/g1/permissions'))
  assert.ok(adminCall.href.includes('adminUserId=admin-1'), 'must forward the authenticated session user id to the bot API')
})

test('admin can set a default command permission and the change is logged to operation_logs', async (t) => {
  const db = createMemoryDb()
  t.after(() => db.close())
  const config = createTestConfig()
  const fetchImpl = createRoutedFetch({
    discordToken: { access_token: 'discord-access' },
    discordUser: { id: 'admin-1', username: 'admin-user' },
    botResponses: {
      '/permission': { body: { basic: true, extended: true } },
      '/admin/g1/permissions/default': { body: { ok: true } },
    },
  })
  const app = await buildWebServer({ config, db, fetchImpl, logger: false, startCleanup: false })
  t.after(() => app.close())
  const cookie = await loginAndGetCookie(app)

  const response = await app.inject({
    method: 'POST',
    url: '/api/admin/g1/permissions/default',
    headers: { cookie },
    payload: { command: 'skip', value: 'deny' },
  })
  assert.equal(response.statusCode, 200)

  const logs = db.prepare(`SELECT * FROM operation_logs WHERE guild_id = 'g1'`).all()
  assert.equal(logs.length, 1)
  assert.equal(logs[0].source, 'admin')
  assert.equal(logs[0].action, 'set_default_permission')
  assert.deepEqual(JSON.parse(logs[0].detail), { command: 'skip', value: 'deny' })
})

test('admin can set a per-user command permission override', async (t) => {
  const db = createMemoryDb()
  t.after(() => db.close())
  const config = createTestConfig()
  const fetchImpl = createRoutedFetch({
    discordToken: { access_token: 'discord-access' },
    discordUser: { id: 'admin-1', username: 'admin-user' },
    botResponses: {
      '/permission': { body: { basic: true, extended: true } },
      '/admin/g1/permissions/user': { body: { ok: true } },
    },
  })
  const app = await buildWebServer({ config, db, fetchImpl, logger: false, startCleanup: false })
  t.after(() => app.close())
  const cookie = await loginAndGetCookie(app)

  const response = await app.inject({
    method: 'POST',
    url: '/api/admin/g1/permissions/user',
    headers: { cookie },
    payload: { userId: 'user-2', command: 'skip', value: 'allow' },
  })
  assert.equal(response.statusCode, 200)
  const call = fetchImpl.requests.find((r) => r.href.includes('/admin/g1/permissions/user'))
  assert.deepEqual(JSON.parse(call.options.body), { adminUserId: 'admin-1', userId: 'user-2', command: 'skip', value: 'allow' })
})

test('admin visibility routes read and write effective per-command reply visibility', async (t) => {
  const db = createMemoryDb()
  t.after(() => db.close())
  const config = createTestConfig()
  const fetchImpl = createRoutedFetch({
    discordToken: { access_token: 'discord-access' },
    discordUser: { id: 'admin-1', username: 'admin-user' },
    botResponses: {
      '/permission': { body: { basic: true, extended: true } },
      '/admin/g1/visibility': { body: { ok: true, skip: 'public', nowplaying: 'personal' } },
    },
  })
  const app = await buildWebServer({ config, db, fetchImpl, logger: false, startCleanup: false })
  t.after(() => app.close())
  const cookie = await loginAndGetCookie(app)

  const getResponse = await app.inject({ method: 'GET', url: '/api/admin/g1/visibility', headers: { cookie } })
  assert.equal(getResponse.statusCode, 200)
  assert.equal(getResponse.json().skip, 'public')

  const postResponse = await app.inject({
    method: 'POST',
    url: '/api/admin/g1/visibility',
    headers: { cookie },
    payload: { command: 'nowplaying', value: 'public' },
  })
  assert.equal(postResponse.statusCode, 200)
  const logs = db.prepare(`SELECT * FROM operation_logs WHERE action = 'set_command_visibility'`).all()
  assert.equal(logs.length, 1)
})

test('admin logs route returns paginated operation_logs rows for the guild, newest first', async (t) => {
  const db = createMemoryDb()
  t.after(() => db.close())
  const config = createTestConfig()
  const fetchImpl = createRoutedFetch({
    discordToken: { access_token: 'discord-access' },
    discordUser: { id: 'admin-1', username: 'admin-user' },
    botResponses: { '/permission': { body: { basic: true, extended: true } } },
  })
  const app = await buildWebServer({ config, db, fetchImpl, logger: false, startCleanup: false })
  t.after(() => app.close())
  const cookie = await loginAndGetCookie(app)

  for (let i = 0; i < 3; i += 1) {
    db.prepare(`
      INSERT INTO operation_logs (guild_id, discord_user_id, username, source, action, detail, success, created_at)
      VALUES ('g1', 'user-1', 'user', 'command', ?, NULL, 1, ?)
    `).run(`action-${i}`, 1000 + i)
  }
  db.prepare(`
    INSERT INTO operation_logs (guild_id, discord_user_id, username, source, action, detail, success, created_at)
    VALUES ('g2', 'user-1', 'user', 'command', 'other-guild-action', NULL, 1, 2000)
  `).run()

  const response = await app.inject({ method: 'GET', url: '/api/admin/g1/logs', headers: { cookie } })
  assert.equal(response.statusCode, 200)
  const { logs } = response.json()
  assert.equal(logs.length, 3)
  assert.deepEqual(logs.map((row) => row.action), ['action-2', 'action-1', 'action-0'])
})

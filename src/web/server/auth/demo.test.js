import assert from 'node:assert/strict'
import { test } from 'node:test'
import cookie from '@fastify/cookie'
import Fastify from 'fastify'
import { registerDemoAuthRoutes } from './demo.js'
import { createRequireAuth } from '../middleware/requireAuth.js'
import { createMemoryDb, createTestConfig } from '../testSupport.js'

async function buildApp({ db, config }) {
  const app = Fastify()
  await app.register(cookie, { secret: config.session.secret, hook: 'onRequest' })
  const requireAuth = createRequireAuth({ db, config })
  app.get('/api/me', { preHandler: requireAuth }, async (request) => ({ user: request.user }))
  registerDemoAuthRoutes(app, { db, config })
  return app
}

test('Demo login returns 404 when disabled', async (t) => {
  const db = createMemoryDb()
  t.after(() => db.close())
  const config = createTestConfig()
  const app = await buildApp({ db, config })
  t.after(() => app.close())

  const response = await app.inject({
    method: 'POST',
    url: '/auth/demo/login',
    payload: { password: 'whatever' },
  })
  assert.equal(response.statusCode, 404)
  assert.equal(response.json().error, 'not_found')
})

test('Demo login with correct password creates a user/session and authenticates protected routes', async (t) => {
  const db = createMemoryDb()
  t.after(() => db.close())
  const config = createTestConfig({ DEMO_LOGIN_ENABLED: 'true', DEMO_LOGIN_PASSWORD: 'test-secret' })
  const app = await buildApp({ db, config })
  t.after(() => app.close())

  const response = await app.inject({
    method: 'POST',
    url: '/auth/demo/login',
    payload: { password: 'test-secret' },
  })
  assert.equal(response.statusCode, 302)
  assert.equal(response.headers.location, '/dashboard')
  assert.match(response.headers['set-cookie'], /musicbot_session=/)

  assert.deepEqual(
    db.prepare('SELECT discord_id, username FROM discord_users').get(),
    { discord_id: 'google-review-demo', username: 'Google Reviewer' }
  )
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM web_sessions').get().count, 1)

  const me = await app.inject({
    method: 'GET',
    url: '/api/me',
    headers: { cookie: response.headers['set-cookie'] },
  })
  assert.equal(me.statusCode, 200)
  assert.equal(me.json().user.discordId, 'google-review-demo')
})

test('Demo login clears the previous demo session, pending OAuth states, and service links, but leaves other users alone', async (t) => {
  const db = createMemoryDb()
  t.after(() => db.close())
  const config = createTestConfig({ DEMO_LOGIN_ENABLED: 'true', DEMO_LOGIN_PASSWORD: 'test-secret' })
  const app = await buildApp({ db, config })
  t.after(() => app.close())

  db.prepare(`
    INSERT INTO discord_users (discord_id, username, created_at, last_seen_at)
    VALUES (?, ?, ?, ?), (?, ?, ?, ?)
  `).run(
    'google-review-demo', 'Google Reviewer', Date.now(), Date.now(),
    'other-user', 'Other User', Date.now(), Date.now()
  )
  db.prepare(`
    INSERT INTO web_sessions (session_id, discord_user_id, created_at, expires_at)
    VALUES (?, ?, ?, ?), (?, ?, ?, ?)
  `).run(
    'stale-demo-session', 'google-review-demo', Date.now(), Date.now() + 1000,
    'other-user-session', 'other-user', Date.now(), Date.now() + 1000
  )
  db.prepare(`
    INSERT INTO service_links (
      discord_user_id, service, access_token_enc, refresh_token_enc, key_id, scope,
      token_expires_at, status, created_at, updated_at
    ) VALUES
      (?, 'youtube', x'00', x'00', 'key-1', 'scope', NULL, 'active', ?, ?),
      (?, 'youtube', x'00', x'00', 'key-1', 'scope', NULL, 'active', ?, ?)
  `).run(
    'google-review-demo', Date.now(), Date.now(),
    'other-user', Date.now(), Date.now()
  )
  db.prepare(`
    INSERT INTO oauth_states (state, discord_user_id, service, code_verifier, redirect_after, created_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?, ?)
  `).run(
    'demo-pending-state', 'google-review-demo', 'youtube', 'verifier', '/callback/youtube', Date.now(), Date.now() + 600_000,
    'other-user-pending-state', 'other-user', 'youtube', 'verifier', '/callback/youtube', Date.now(), Date.now() + 600_000
  )

  const response = await app.inject({
    method: 'POST',
    url: '/auth/demo/login',
    payload: { password: 'test-secret' },
  })
  assert.equal(response.statusCode, 302)

  assert.equal(
    db.prepare('SELECT COUNT(*) AS count FROM service_links WHERE discord_user_id = ?')
      .get('google-review-demo').count,
    0
  )
  assert.equal(
    db.prepare("SELECT COUNT(*) AS count FROM web_sessions WHERE session_id = 'stale-demo-session'")
      .get().count,
    0
  )
  assert.equal(
    db.prepare("SELECT COUNT(*) AS count FROM web_sessions WHERE discord_user_id = 'google-review-demo'")
      .get().count,
    1
  )
  assert.equal(
    db.prepare('SELECT COUNT(*) AS count FROM oauth_states WHERE discord_user_id = ?')
      .get('google-review-demo').count,
    0
  )

  assert.equal(
    db.prepare('SELECT COUNT(*) AS count FROM service_links WHERE discord_user_id = ?')
      .get('other-user').count,
    1
  )
  assert.equal(
    db.prepare("SELECT session_id FROM web_sessions WHERE discord_user_id = 'other-user'")
      .get().session_id,
    'other-user-session'
  )
  assert.equal(
    db.prepare('SELECT COUNT(*) AS count FROM oauth_states WHERE discord_user_id = ?')
      .get('other-user').count,
    1
  )
})

test('Disabling demo login at startup deletes existing demo sessions, pending OAuth states, and service links, but leaves other users alone', async (t) => {
  const db = createMemoryDb()
  t.after(() => db.close())

  db.prepare(`
    INSERT INTO discord_users (discord_id, username, created_at, last_seen_at)
    VALUES (?, ?, ?, ?), (?, ?, ?, ?)
  `).run(
    'google-review-demo', 'Google Reviewer', Date.now(), Date.now(),
    'other-user', 'Other User', Date.now(), Date.now()
  )
  db.prepare(`
    INSERT INTO web_sessions (session_id, discord_user_id, created_at, expires_at)
    VALUES (?, ?, ?, ?), (?, ?, ?, ?)
  `).run(
    'stale-session', 'google-review-demo', Date.now(), Date.now() + 1000,
    'other-user-session', 'other-user', Date.now(), Date.now() + 1000
  )
  db.prepare(`
    INSERT INTO service_links (
      discord_user_id, service, access_token_enc, refresh_token_enc, key_id, scope,
      token_expires_at, status, created_at, updated_at
    ) VALUES
      (?, 'youtube', x'00', x'00', 'key-1', 'scope', NULL, 'active', ?, ?),
      (?, 'youtube', x'00', x'00', 'key-1', 'scope', NULL, 'active', ?, ?)
  `).run(
    'google-review-demo', Date.now(), Date.now(),
    'other-user', Date.now(), Date.now()
  )
  db.prepare(`
    INSERT INTO oauth_states (state, discord_user_id, service, code_verifier, redirect_after, created_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?, ?)
  `).run(
    'demo-pending-state', 'google-review-demo', 'youtube', 'verifier', '/callback/youtube', Date.now(), Date.now() + 600_000,
    'other-user-pending-state', 'other-user', 'youtube', 'verifier', '/callback/youtube', Date.now(), Date.now() + 600_000
  )

  const config = createTestConfig()
  const app = await buildApp({ db, config })
  t.after(() => app.close())

  assert.equal(
    db.prepare('SELECT COUNT(*) AS count FROM web_sessions WHERE discord_user_id = ?')
      .get('google-review-demo').count,
    0
  )
  assert.equal(
    db.prepare('SELECT COUNT(*) AS count FROM service_links WHERE discord_user_id = ?')
      .get('google-review-demo').count,
    0
  )
  assert.equal(
    db.prepare('SELECT COUNT(*) AS count FROM oauth_states WHERE discord_user_id = ?')
      .get('google-review-demo').count,
    0
  )

  assert.equal(
    db.prepare('SELECT COUNT(*) AS count FROM web_sessions WHERE discord_user_id = ?')
      .get('other-user').count,
    1
  )
  assert.equal(
    db.prepare('SELECT COUNT(*) AS count FROM service_links WHERE discord_user_id = ?')
      .get('other-user').count,
    1
  )
  assert.equal(
    db.prepare('SELECT COUNT(*) AS count FROM oauth_states WHERE discord_user_id = ?')
      .get('other-user').count,
    1
  )
})

test('Demo login with wrong password returns 401', async (t) => {
  const db = createMemoryDb()
  t.after(() => db.close())
  const config = createTestConfig({ DEMO_LOGIN_ENABLED: 'true', DEMO_LOGIN_PASSWORD: 'test-secret' })
  const app = await buildApp({ db, config })
  t.after(() => app.close())

  const response = await app.inject({
    method: 'POST',
    url: '/auth/demo/login',
    payload: { password: 'wrong' },
  })
  assert.equal(response.statusCode, 401)
  assert.equal(response.json().error, 'invalid_password')
})

test('Demo login locks out an IP after 5 failed attempts', async (t) => {
  const db = createMemoryDb()
  t.after(() => db.close())
  const config = createTestConfig({ DEMO_LOGIN_ENABLED: 'true', DEMO_LOGIN_PASSWORD: 'test-secret' })
  const app = await buildApp({ db, config })
  t.after(() => app.close())

  for (let i = 0; i < 5; i += 1) {
    const response = await app.inject({
      method: 'POST',
      url: '/auth/demo/login',
      payload: { password: 'wrong' },
    })
    assert.equal(response.statusCode, 401)
  }

  const sixth = await app.inject({
    method: 'POST',
    url: '/auth/demo/login',
    payload: { password: 'wrong' },
  })
  assert.equal(sixth.statusCode, 429)
  assert.equal(sixth.json().error, 'too_many_attempts')

  const evenWithCorrectPassword = await app.inject({
    method: 'POST',
    url: '/auth/demo/login',
    payload: { password: 'test-secret' },
  })
  assert.equal(evenWithCorrectPassword.statusCode, 429)
})

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

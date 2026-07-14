import assert from 'node:assert/strict'
import { test } from 'node:test'
import cookie from '@fastify/cookie'
import Fastify from 'fastify'
import { registerDiscordAuthRoutes } from './discord.js'
import { createRequireAuth } from '../middleware/requireAuth.js'
import { createMemoryDb, createTestConfig, fetchJsonSequence } from '../testSupport.js'

async function buildApp({ db, config, fetchImpl }) {
  const app = Fastify()
  await app.register(cookie, { secret: config.session.secret, hook: 'onRequest' })
  const requireAuth = createRequireAuth({ db, config })
  app.get('/api/me', { preHandler: requireAuth }, async (request) => ({ user: request.user }))
  registerDiscordAuthRoutes(app, { db, config, fetchImpl })
  return app
}

test('Discord OAuth callback upserts user, creates signed session cookie, and authenticates protected routes', async (t) => {
  const db = createMemoryDb()
  t.after(() => db.close())
  const config = createTestConfig()
  const fetchImpl = fetchJsonSequence([
    { body: { access_token: 'discord-access' } },
    { body: { id: 'u123', username: 'lemitsu', global_name: 'Lemitsu' } },
  ])
  const app = await buildApp({ db, config, fetchImpl })
  t.after(() => app.close())

  const authorize = await app.inject({ method: 'GET', url: '/auth/discord?redirect=/dashboard' })
  assert.equal(authorize.statusCode, 302)
  const location = new URL(authorize.headers.location)
  assert.equal(location.origin + location.pathname, config.oauth.discord.authorizeUrl)
  assert.equal(location.searchParams.get('redirect_uri'), config.oauth.discord.redirectUri)

  const state = location.searchParams.get('state')
  const callback = await app.inject({
    method: 'GET',
    url: `/auth/discord/callback?code=abc&state=${state}`,
  })
  assert.equal(callback.statusCode, 302)
  assert.equal(callback.headers.location, '/dashboard')
  assert.match(callback.headers['set-cookie'], /musicbot_session=/)

  assert.deepEqual(
    db.prepare('SELECT discord_id, username FROM discord_users').get(),
    { discord_id: 'u123', username: 'Lemitsu' }
  )
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM web_sessions').get().count, 1)

  const me = await app.inject({
    method: 'GET',
    url: '/api/me',
    headers: { cookie: callback.headers['set-cookie'] },
  })
  assert.equal(me.statusCode, 200)
  assert.equal(me.json().user.discordId, 'u123')
  assert.equal(fetchImpl.calls.length, 2)
})

test('Discord callback rejects scheme-relative redirect targets (open redirect)', async (t) => {
  const db = createMemoryDb()
  t.after(() => db.close())
  const config = createTestConfig()
  const evilRedirects = ['//evil.example', '/\\evil.example', 'https://evil.example']
  // Each loop iteration drives a full token+userinfo exchange, so the sequence
  // needs one token/user pair per iteration.
  const fetchImpl = fetchJsonSequence(
    evilRedirects.flatMap(() => [
      { body: { access_token: 'discord-access' } },
      { body: { id: 'u123', username: 'lemitsu' } },
    ])
  )
  const app = await buildApp({ db, config, fetchImpl })
  t.after(() => app.close())

  for (const evilRedirect of evilRedirects) {
    const authorize = await app.inject({
      method: 'GET',
      url: `/auth/discord?redirect=${encodeURIComponent(evilRedirect)}`,
    })
    const state = new URL(authorize.headers.location).searchParams.get('state')
    const callback = await app.inject({
      method: 'GET',
      url: `/auth/discord/callback?code=abc&state=${state}`,
    })
    assert.equal(callback.statusCode, 302)
    assert.equal(callback.headers.location, '/', `redirect=${evilRedirect} must fall back to '/'`)
  }
})

test('Discord callback rejects missing or consumed state', async (t) => {
  const db = createMemoryDb()
  t.after(() => db.close())
  const config = createTestConfig()
  const app = await buildApp({
    db,
    config,
    fetchImpl: fetchJsonSequence([]),
  })
  t.after(() => app.close())

  const response = await app.inject({
    method: 'GET',
    url: '/auth/discord/callback?code=abc&state=missing',
  })
  assert.equal(response.statusCode, 400)
  assert.equal(response.json().error, 'invalid_oauth_state')
})

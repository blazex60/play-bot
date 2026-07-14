import assert from 'node:assert/strict'
import { test } from 'node:test'
import Fastify from 'fastify'
import { registerYoutubeAuthRoutes } from './youtube.js'
import { createMemoryDb, createTestConfig, fetchJsonSequence } from '../testSupport.js'

function testRequireAuth(request, _reply, done) {
  request.user = { discordId: 'u123', username: 'Lemitsu' }
  done()
}

test('YouTube OAuth requests offline consent and stores Google tokens', async (t) => {
  const db = createMemoryDb()
  t.after(() => db.close())
  const config = createTestConfig()
  const stored = []
  const app = Fastify()
  registerYoutubeAuthRoutes(app, {
    db,
    config,
    requireAuth: testRequireAuth,
    fetchImpl: fetchJsonSequence([
      {
        body: {
          access_token: 'youtube-access',
          refresh_token: 'youtube-refresh',
          expires_in: 1800,
          scope: 'https://www.googleapis.com/auth/youtube.readonly',
        },
      },
    ]),
    storeTokens: async (tokens) => stored.push(tokens),
  })
  t.after(() => app.close())

  const authorize = await app.inject({ method: 'GET', url: '/auth/youtube' })
  assert.equal(authorize.statusCode, 302)
  const location = new URL(authorize.headers.location)
  assert.equal(location.origin + location.pathname, config.oauth.youtube.authorizeUrl)
  assert.equal(location.searchParams.get('access_type'), 'offline')
  assert.equal(location.searchParams.get('prompt'), 'consent')

  const state = location.searchParams.get('state')
  const callback = await app.inject({
    method: 'GET',
    url: `/auth/youtube/callback?code=abc&state=${state}`,
  })
  assert.equal(callback.statusCode, 302)
  assert.equal(callback.headers.location, '/callback/youtube')
  assert.equal(stored.length, 1)
  assert.equal(stored[0].userId, 'u123')
  assert.equal(stored[0].service, 'youtube')
  assert.equal(stored[0].accessToken, 'youtube-access')
  assert.equal(stored[0].refreshToken, 'youtube-refresh')
})

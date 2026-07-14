import assert from 'node:assert/strict'
import { test } from 'node:test'
import Fastify from 'fastify'
import { registerSpotifyAuthRoutes } from './spotify.js'
import { createMemoryDb, createTestConfig, fetchJsonSequence } from '../testSupport.js'

function testRequireAuth(request, _reply, done) {
  request.user = { discordId: 'u123', username: 'Lemitsu' }
  done()
}

test('Spotify OAuth stores provider tokens for the logged-in Discord user', async (t) => {
  const db = createMemoryDb()
  t.after(() => db.close())
  const config = createTestConfig()
  const stored = []
  const app = Fastify()
  registerSpotifyAuthRoutes(app, {
    db,
    config,
    requireAuth: testRequireAuth,
    fetchImpl: fetchJsonSequence([
      {
        body: {
          access_token: 'spotify-access',
          refresh_token: 'spotify-refresh',
          expires_in: 3600,
          scope: 'playlist-read-private',
        },
      },
    ]),
    storeTokens: async (tokens) => stored.push(tokens),
  })
  t.after(() => app.close())

  const authorize = await app.inject({ method: 'GET', url: '/auth/spotify' })
  assert.equal(authorize.statusCode, 302)
  const location = new URL(authorize.headers.location)
  assert.equal(location.origin + location.pathname, config.oauth.spotify.authorizeUrl)
  assert.equal(location.searchParams.get('scope'), config.oauth.spotify.scope)

  const state = location.searchParams.get('state')
  const callback = await app.inject({
    method: 'GET',
    url: `/auth/spotify/callback?code=abc&state=${state}`,
  })
  assert.equal(callback.statusCode, 302)
  assert.equal(callback.headers.location, '/callback/spotify')
  assert.equal(stored.length, 1)
  assert.equal(stored[0].userId, 'u123')
  assert.equal(stored[0].service, 'spotify')
  assert.equal(stored[0].accessToken, 'spotify-access')
  assert.equal(stored[0].refreshToken, 'spotify-refresh')
  assert.equal(stored[0].scope, 'playlist-read-private')
  assert.equal(typeof stored[0].tokenExpiresAt, 'number')
})

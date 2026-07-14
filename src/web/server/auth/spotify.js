import {
  appendParams,
  basicAuthHeader,
  consumeOauthState,
  fetchJson,
  insertOauthState,
  tokenExpiresAt,
} from './oauth.js'

async function defaultStoreTokens(tokens) {
  const tokenStore = await import('../../../db/tokenStore.js')
  return tokenStore.upsertServiceLink(tokens)
}

export function registerSpotifyAuthRoutes(
  app,
  {
    db,
    config,
    requireAuth,
    fetchImpl = globalThis.fetch,
    storeTokens = defaultStoreTokens,
  } = {}
) {
  const spotify = config.oauth.spotify

  app.get('/auth/spotify', { preHandler: requireAuth }, async (request, reply) => {
    const state = insertOauthState({
      db,
      service: 'spotify',
      discordUserId: request.user.discordId,
      redirectAfter: '/callback/spotify',
      ttlSeconds: config.oauth.stateTtlSeconds,
    })
    return reply.redirect(appendParams(spotify.authorizeUrl, {
      client_id: spotify.clientId,
      redirect_uri: spotify.redirectUri,
      response_type: 'code',
      scope: spotify.scope,
      state,
    }))
  })

  app.get('/auth/spotify/callback', async (request, reply) => {
    const code = request.query?.code
    const state = request.query?.state
    if (!code || !state) {
      return reply.code(400).send({ error: 'missing_oauth_callback_params' })
    }
    const consumed = consumeOauthState({ db, service: 'spotify', state })
    if (!consumed.ok) {
      return reply.code(400).send({ error: consumed.error })
    }

    const token = await fetchJson(fetchImpl, spotify.tokenUrl, {
      method: 'POST',
      headers: {
        authorization: basicAuthHeader(spotify.clientId, spotify.clientSecret),
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: spotify.redirectUri,
      }),
    })
    await storeTokens({
      userId: consumed.row.discord_user_id,
      service: 'spotify',
      accessToken: token.access_token,
      refreshToken: token.refresh_token,
      scope: token.scope,
      tokenExpiresAt: tokenExpiresAt(token),
    })
    return reply.redirect(consumed.row.redirect_after || '/')
  })
}

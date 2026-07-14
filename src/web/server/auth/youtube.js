import {
  appendParams,
  consumeOauthState,
  fetchJson,
  insertOauthState,
  tokenExpiresAt,
} from './oauth.js'

async function defaultStoreTokens(tokens) {
  const tokenStore = await import('../../../db/tokenStore.js')
  return tokenStore.upsertServiceLink(tokens)
}

export function registerYoutubeAuthRoutes(
  app,
  {
    db,
    config,
    requireAuth,
    fetchImpl = globalThis.fetch,
    storeTokens = defaultStoreTokens,
  } = {}
) {
  const youtube = config.oauth.youtube

  app.get('/auth/youtube', { preHandler: requireAuth }, async (request, reply) => {
    const state = insertOauthState({
      db,
      service: 'youtube',
      discordUserId: request.user.discordId,
      redirectAfter: '/callback/youtube',
      ttlSeconds: config.oauth.stateTtlSeconds,
    })
    return reply.redirect(appendParams(youtube.authorizeUrl, {
      access_type: 'offline',
      client_id: youtube.clientId,
      include_granted_scopes: 'true',
      prompt: 'consent',
      redirect_uri: youtube.redirectUri,
      response_type: 'code',
      scope: youtube.scope,
      state,
    }))
  })

  app.get('/auth/youtube/callback', async (request, reply) => {
    const code = request.query?.code
    const state = request.query?.state
    if (!code || !state) {
      return reply.code(400).send({ error: 'missing_oauth_callback_params' })
    }
    const consumed = consumeOauthState({ db, service: 'youtube', state })
    if (!consumed.ok) {
      return reply.code(400).send({ error: consumed.error })
    }

    const token = await fetchJson(fetchImpl, youtube.tokenUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: youtube.clientId,
        client_secret: youtube.clientSecret,
        grant_type: 'authorization_code',
        code,
        redirect_uri: youtube.redirectUri,
      }),
    })
    await storeTokens({
      userId: consumed.row.discord_user_id,
      service: 'youtube',
      accessToken: token.access_token,
      refreshToken: token.refresh_token,
      scope: token.scope,
      tokenExpiresAt: tokenExpiresAt(token),
    })
    return reply.redirect(consumed.row.redirect_after || '/')
  })
}

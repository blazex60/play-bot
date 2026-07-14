import {
  appendParams,
  consumeOauthState,
  fetchJson,
  insertOauthState,
  randomToken,
} from './oauth.js'

function redirectAfterFromRequest(request) {
  const value = request.query?.redirect
  if (typeof value !== 'string' || value.length === 0) return '/'
  // Reject scheme-relative ("//evil.example") and backslash ("/\evil.example")
  // forms that some browsers treat as protocol-relative URLs, to prevent an
  // open redirect after Discord OAuth completes.
  if (!value.startsWith('/') || value.startsWith('//') || value.startsWith('/\\')) return '/'
  return value
}

export function registerDiscordAuthRoutes(app, { db, config, fetchImpl = globalThis.fetch } = {}) {
  const discord = config.oauth.discord
  const upsertUser = db.prepare(`
    INSERT INTO discord_users (discord_id, username, created_at, last_seen_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(discord_id) DO UPDATE SET
      username = excluded.username,
      last_seen_at = excluded.last_seen_at
  `)
  const createSession = db.prepare(`
    INSERT INTO web_sessions (session_id, discord_user_id, created_at, expires_at)
    VALUES (?, ?, ?, ?)
  `)
  const deleteSession = db.prepare('DELETE FROM web_sessions WHERE session_id = ?')

  app.get('/auth/discord', async (request, reply) => {
    const state = insertOauthState({
      db,
      service: 'discord',
      redirectAfter: redirectAfterFromRequest(request),
      ttlSeconds: config.oauth.stateTtlSeconds,
    })
    return reply.redirect(appendParams(discord.authorizeUrl, {
      client_id: discord.clientId,
      redirect_uri: discord.redirectUri,
      response_type: 'code',
      scope: discord.scope,
      state,
    }))
  })

  app.get('/auth/discord/callback', async (request, reply) => {
    const code = request.query?.code
    const state = request.query?.state
    if (!code || !state) {
      return reply.code(400).send({ error: 'missing_oauth_callback_params' })
    }

    const consumed = consumeOauthState({ db, service: 'discord', state })
    if (!consumed.ok) {
      return reply.code(400).send({ error: consumed.error })
    }

    const token = await fetchJson(fetchImpl, discord.tokenUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: discord.clientId,
        client_secret: discord.clientSecret,
        grant_type: 'authorization_code',
        code,
        redirect_uri: discord.redirectUri,
      }),
    })
    const user = await fetchJson(fetchImpl, discord.userUrl, {
      headers: { authorization: `Bearer ${token.access_token}` },
    })
    const createdAt = Date.now()
    const username = user.global_name ?? user.username ?? user.id
    upsertUser.run(user.id, username, createdAt, createdAt)

    const sessionId = randomToken()
    createSession.run(
      sessionId,
      user.id,
      createdAt,
      createdAt + config.session.ttlSeconds * 1000
    )
    reply.setCookie(config.session.cookieName, sessionId, {
      httpOnly: true,
      secure: config.session.secure,
      sameSite: 'lax',
      path: '/',
      signed: true,
      maxAge: config.session.ttlSeconds,
    })
    return reply.redirect(consumed.row.redirect_after || '/')
  })

  app.post('/auth/logout', async (request, reply) => {
    const rawCookie = request.cookies?.[config.session.cookieName]
    const unsigned = rawCookie && request.unsignCookie
      ? request.unsignCookie(rawCookie)
      : { valid: true, value: rawCookie }
    if (unsigned?.valid && unsigned.value) {
      deleteSession.run(unsigned.value)
    }
    reply.clearCookie(config.session.cookieName, { path: '/' })
    return reply.send({ ok: true })
  })
}

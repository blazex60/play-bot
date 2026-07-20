import { createHash, timingSafeEqual } from 'node:crypto'
import { createUserSession } from './oauth.js'

const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000
const RATE_LIMIT_MAX_ATTEMPTS = 5

function digest(value) {
  return createHash('sha256').update(String(value)).digest()
}

function passwordMatches(submitted, expected) {
  return timingSafeEqual(digest(submitted), digest(expected))
}

export function registerDemoAuthRoutes(app, { db, config } = {}) {
  const upsertUser = db.prepare(`
    INSERT INTO discord_users (discord_id, username, created_at, last_seen_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(discord_id) DO UPDATE SET
      username = excluded.username,
      last_seen_at = excluded.last_seen_at
  `)

  const deleteSessionsByUserId = db.prepare('DELETE FROM web_sessions WHERE discord_user_id = ?')
  const deleteServiceLinksByUserId = db.prepare('DELETE FROM service_links WHERE discord_user_id = ?')
  const deleteOauthStatesByUserId = db.prepare('DELETE FROM oauth_states WHERE discord_user_id = ?')
  // user_playlist_tracks cascades via ON DELETE CASCADE.
  const deletePlaylistsByUserId = db.prepare('DELETE FROM user_playlists WHERE discord_user_id = ?')

  if (!config.demoLogin.enabled) {
    deleteSessionsByUserId.run(config.demoLogin.discordId)
    deleteServiceLinksByUserId.run(config.demoLogin.discordId)
    deleteOauthStatesByUserId.run(config.demoLogin.discordId)
    deletePlaylistsByUserId.run(config.demoLogin.discordId)
  }

  const failuresByIp = new Map()

  function isRateLimited(ip, now) {
    const entry = failuresByIp.get(ip)
    if (!entry) return false
    if (now - entry.windowStart > RATE_LIMIT_WINDOW_MS) {
      failuresByIp.delete(ip)
      return false
    }
    return entry.count >= RATE_LIMIT_MAX_ATTEMPTS
  }

  function recordFailure(ip, now) {
    const entry = failuresByIp.get(ip)
    if (!entry || now - entry.windowStart > RATE_LIMIT_WINDOW_MS) {
      failuresByIp.set(ip, { count: 1, windowStart: now })
      return
    }
    entry.count += 1
  }

  function resetFailures(ip) {
    failuresByIp.delete(ip)
  }

  function pruneStaleFailures(now) {
    for (const [ip, entry] of failuresByIp) {
      if (now - entry.windowStart > RATE_LIMIT_WINDOW_MS) {
        failuresByIp.delete(ip)
      }
    }
  }

  const pruneTimer = setInterval(() => {
    pruneStaleFailures(Date.now())
  }, RATE_LIMIT_WINDOW_MS).unref()

  app.addHook('onClose', async () => {
    clearInterval(pruneTimer)
  })

  app.post('/auth/demo/login', async (request, reply) => {
    if (!config.demoLogin.enabled) {
      return reply.code(404).send({ error: 'not_found' })
    }

    const ip = request.ip
    const now = Date.now()
    if (isRateLimited(ip, now)) {
      return reply.code(429).send({ error: 'too_many_attempts' })
    }

    const password = request.body?.password
    if (typeof password !== 'string' || !passwordMatches(password, config.demoLogin.password)) {
      recordFailure(ip, now)
      return reply.code(401).send({ error: 'invalid_password' })
    }

    resetFailures(ip)
    upsertUser.run(config.demoLogin.discordId, config.demoLogin.username, now, now)
    // The demo account is a single fixed ID shared by every reviewer, so a new
    // login must not inherit a previous reviewer's session, in-flight OAuth
    // consent, linked YouTube account, or saved playlists.
    deleteSessionsByUserId.run(config.demoLogin.discordId)
    deleteServiceLinksByUserId.run(config.demoLogin.discordId)
    deleteOauthStatesByUserId.run(config.demoLogin.discordId)
    deletePlaylistsByUserId.run(config.demoLogin.discordId)
    createUserSession({ db, config, reply, discordId: config.demoLogin.discordId, now })
    return reply.redirect('/dashboard')
  })
}

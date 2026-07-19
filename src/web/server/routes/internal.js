import { nowUnix } from './route-utils.js'

function getBearerToken(request) {
  const header = request.headers.authorization
  if (typeof header !== 'string') return null
  const [scheme, token] = header.split(' ')
  if (scheme !== 'Bearer' || !token) return null
  return token
}

function upsertDiscordUser(db, { discordId, username }) {
  const now = nowUnix()
  db.prepare(`
    INSERT INTO discord_users (discord_id, username, created_at, last_seen_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(discord_id) DO UPDATE SET username = excluded.username, last_seen_at = excluded.last_seen_at
  `).run(discordId, username ?? discordId, now, now)
}

// Bot process -> Web process channel for play history, mirroring the
// Web -> Bot direction (src/botApi.js). Guarded by the same BOT_API_TOKEN
// shared secret rather than the cookie-session requireAuth middleware, since
// the caller here is the bot process, not a browser.
export async function internalRoutes(app, { db, token } = {}) {
  app.addHook('onRequest', async (request, reply) => {
    if (!token || getBearerToken(request) !== token) {
      return reply.code(401).send({ error: 'unauthorized' })
    }
  })

  app.post('/internal/play-history', async (request, reply) => {
    if (!db) throw new Error('db is required for internal routes')
    const { guildId, discordUserId, username, trackTitle, trackUrl, videoId, channel } = request.body ?? {}
    if (!guildId || !discordUserId || !trackTitle || !trackUrl) {
      return reply.code(400).send({ error: 'missing_fields' })
    }
    upsertDiscordUser(db, { discordId: discordUserId, username })
    db.prepare(`
      INSERT INTO play_history (guild_id, discord_user_id, video_id, channel, track_title, track_url, played_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(guildId, discordUserId, videoId ?? null, channel ?? null, trackTitle, trackUrl, nowUnix())
    return reply.send({ ok: true })
  })

  app.get('/internal/play-history/recent', async (request, reply) => {
    if (!db) throw new Error('db is required for internal routes')
    const { guildId, userIds, limit } = request.query ?? {}
    if (!guildId || !userIds) {
      return reply.code(400).send({ error: 'missing_fields' })
    }
    const ids = String(userIds).split(',').map((id) => id.trim()).filter(Boolean)
    const rowLimit = Math.min(Number.parseInt(limit, 10) || 200, 500)
    const stmt = db.prepare(`
      SELECT video_id as videoId, channel, played_at as playedAt
      FROM play_history
      WHERE guild_id = ? AND discord_user_id = ?
      ORDER BY played_at DESC, id DESC
      LIMIT ?
    `)
    const result = {}
    for (const userId of ids) {
      result[userId] = stmt.all(guildId, userId, rowLimit)
    }
    return reply.send(result)
  })
}

export function createRequireAuth({ db, config }) {
  if (!db) {
    throw new Error('db is required')
  }
  if (!config?.session?.cookieName) {
    throw new Error('session cookie config is required')
  }

  const findSession = db.prepare(`
    SELECT
      web_sessions.session_id AS session_id,
      web_sessions.discord_user_id AS discord_id,
      discord_users.username AS username,
      web_sessions.expires_at AS expires_at
    FROM web_sessions
    JOIN discord_users ON discord_users.discord_id = web_sessions.discord_user_id
    WHERE web_sessions.session_id = ?
  `)

  return async function requireAuth(request, reply) {
    const rawCookie = request.cookies?.[config.session.cookieName]
    const unsigned = rawCookie && request.unsignCookie
      ? request.unsignCookie(rawCookie)
      : { valid: true, value: rawCookie }
    if (!unsigned?.valid || !unsigned.value) {
      return reply.code(401).send({ error: 'auth_required' })
    }

    const row = findSession.get(unsigned.value)
    if (!row || row.expires_at < Date.now()) {
      return reply.code(401).send({ error: 'auth_required' })
    }

    request.user = {
      discordId: row.discord_id,
      username: row.username,
      sessionId: row.session_id,
    }
  }
}

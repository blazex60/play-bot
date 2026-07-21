export function getSessionUser(request) {
  const user = request.user ?? request.session?.user ?? request.auth?.user
  const discordId = user?.discordId ?? user?.discord_id ?? user?.id
  if (!discordId) {
    const error = new Error('Authentication required')
    error.statusCode = 401
    throw error
  }
  return { ...user, discordId }
}

export async function callBot(botClient, method, path, body) {
  if (typeof botClient?.request === 'function') return botClient.request(method, path, body)
  if (method === 'GET' && typeof botClient?.get === 'function') return botClient.get(path)
  if (method === 'POST' && typeof botClient?.post === 'function') return botClient.post(path, body)
  throw new Error('botClient must expose request(method, path, body), get(path), or post(path, body)')
}

export async function requireBotPermission({ botClient, guildId, userId }) {
  const permission = typeof botClient?.getPermission === 'function'
    ? await botClient.getPermission({ guildId, userId })
    : await callBot(botClient, 'GET', `/permission?guildId=${encodeURIComponent(guildId)}&userId=${encodeURIComponent(userId)}`)

  if (!permission?.basic && !permission?.extended) {
    const error = new Error('Forbidden')
    error.statusCode = 403
    throw error
  }

  return permission
}

// The admin dashboard (command permissions, visibility, operation logs)
// requires the stronger `extended` (guild admin role) permission — unlike
// requireBotPermission above, being in the same voice channel is not enough.
export async function requireAdminPermission({ botClient, guildId, userId }) {
  const permission = typeof botClient?.getPermission === 'function'
    ? await botClient.getPermission({ guildId, userId })
    : await callBot(botClient, 'GET', `/permission?guildId=${encodeURIComponent(guildId)}&userId=${encodeURIComponent(userId)}`)

  if (!permission?.extended) {
    const error = new Error('Forbidden')
    error.statusCode = 403
    throw error
  }

  return permission
}

// A user denied a command via the admin permission matrix must not be able
// to perform its equivalent action from the dashboard either (e.g. denied
// /pause but clicking the Pause button) — requireBotPermission above only
// checks VC-membership/admin-role, not the per-command allow/deny matrix.
export async function requireCommandPermission({ botClient, guildId, userId, command }) {
  const result = await callBot(botClient, 'GET', `/command-permission?guildId=${encodeURIComponent(guildId)}&userId=${encodeURIComponent(userId)}&command=${encodeURIComponent(command)}`)
  if (!result?.allowed) {
    const error = new Error('Forbidden')
    error.statusCode = 403
    throw error
  }
  return result
}

export function bindRouteError(reply, error) {
  const statusCode = error.statusCode ?? error.status ?? 500
  return reply.code(statusCode).send({
    error: error.code ?? error.message ?? 'internal_error',
    message: error.publicMessage ?? error.message,
  })
}

export function nowUnix() {
  return Math.floor(Date.now() / 1000)
}

function upsertDiscordUserForLog(db, discordId, username) {
  const now = nowUnix()
  db.prepare(`
    INSERT INTO discord_users (discord_id, username, created_at, last_seen_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(discord_id) DO UPDATE SET username = excluded.username, last_seen_at = excluded.last_seen_at
  `).run(discordId, username ?? discordId, now, now)
}

// Best-effort operation log write shared by the Bot->Web internal channel and
// the dashboard's own control/admin routes. Never throws: a logging failure
// must not block the underlying action it's recording.
export function recordOperationLog(db, { guildId, discordUserId, username, source, action, detail, success = true }) {
  try {
    if (discordUserId) upsertDiscordUserForLog(db, discordUserId, username)
    db.prepare(`
      INSERT INTO operation_logs (guild_id, discord_user_id, username, source, action, detail, success, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(guildId, discordUserId ?? null, username ?? null, source, action, detail ?? null, success ? 1 : 0, nowUnix())
  } catch (error) {
    console.error('[operationLog] failed to record:', error.message)
  }
}

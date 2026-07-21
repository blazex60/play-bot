import { bindRouteError, callBot, getSessionUser, requireAdminPermission, recordOperationLog } from './route-utils.js'

const DEFAULT_LOG_LIMIT = 50
const MAX_LOG_LIMIT = 200

function knownUsersForGuild(db, guildId) {
  return db.prepare(`
    SELECT DISTINCT discord_users.discord_id AS discordId, discord_users.username AS username
    FROM play_history
    JOIN discord_users ON discord_users.discord_id = play_history.discord_user_id
    WHERE play_history.guild_id = ?
    ORDER BY discord_users.username
  `).all(guildId)
}

export async function adminRoutes(app, { db, botClient } = {}) {
  if (!db) throw new Error('db is required for admin routes')
  if (!botClient) throw new Error('botClient is required for admin routes')

  app.get('/api/admin/:guildId/permissions', async (request, reply) => {
    try {
      const user = getSessionUser(request)
      const { guildId } = request.params
      await requireAdminPermission({ botClient, guildId, userId: user.discordId })
      const permissions = await callBot(botClient, 'GET', `/admin/${encodeURIComponent(guildId)}/permissions?adminUserId=${encodeURIComponent(user.discordId)}`)
      return reply.send({ ...permissions, knownUsers: knownUsersForGuild(db, guildId) })
    } catch (error) {
      return bindRouteError(reply, error)
    }
  })

  app.post('/api/admin/:guildId/permissions/default', async (request, reply) => {
    const { guildId } = request.params
    let user
    try {
      user = getSessionUser(request)
      await requireAdminPermission({ botClient, guildId, userId: user.discordId })
      const { command, value } = request.body ?? {}
      const result = await callBot(botClient, 'POST', `/admin/${encodeURIComponent(guildId)}/permissions/default`, { adminUserId: user.discordId, command, value })
      recordOperationLog(db, {
        guildId,
        discordUserId: user.discordId,
        username: user.username,
        source: 'admin',
        action: 'set_default_permission',
        detail: JSON.stringify({ command, value }),
        success: true,
      })
      return reply.send(result ?? { ok: true })
    } catch (error) {
      if (user) {
        recordOperationLog(db, {
          guildId,
          discordUserId: user.discordId,
          username: user.username,
          source: 'admin',
          action: 'set_default_permission',
          detail: error.message,
          success: false,
        })
      }
      return bindRouteError(reply, error)
    }
  })

  app.post('/api/admin/:guildId/permissions/user', async (request, reply) => {
    const { guildId } = request.params
    let user
    try {
      user = getSessionUser(request)
      await requireAdminPermission({ botClient, guildId, userId: user.discordId })
      const { userId, command, value } = request.body ?? {}
      const result = await callBot(botClient, 'POST', `/admin/${encodeURIComponent(guildId)}/permissions/user`, { adminUserId: user.discordId, userId, command, value })
      recordOperationLog(db, {
        guildId,
        discordUserId: user.discordId,
        username: user.username,
        source: 'admin',
        action: 'set_user_permission',
        detail: JSON.stringify({ userId, command, value }),
        success: true,
      })
      return reply.send(result ?? { ok: true })
    } catch (error) {
      if (user) {
        recordOperationLog(db, {
          guildId,
          discordUserId: user.discordId,
          username: user.username,
          source: 'admin',
          action: 'set_user_permission',
          detail: error.message,
          success: false,
        })
      }
      return bindRouteError(reply, error)
    }
  })

  app.get('/api/admin/:guildId/visibility', async (request, reply) => {
    try {
      const user = getSessionUser(request)
      const { guildId } = request.params
      await requireAdminPermission({ botClient, guildId, userId: user.discordId })
      const visibility = await callBot(botClient, 'GET', `/admin/${encodeURIComponent(guildId)}/visibility?adminUserId=${encodeURIComponent(user.discordId)}`)
      return reply.send(visibility)
    } catch (error) {
      return bindRouteError(reply, error)
    }
  })

  app.post('/api/admin/:guildId/visibility', async (request, reply) => {
    const { guildId } = request.params
    let user
    try {
      user = getSessionUser(request)
      await requireAdminPermission({ botClient, guildId, userId: user.discordId })
      const { command, value } = request.body ?? {}
      const result = await callBot(botClient, 'POST', `/admin/${encodeURIComponent(guildId)}/visibility`, { adminUserId: user.discordId, command, value })
      recordOperationLog(db, {
        guildId,
        discordUserId: user.discordId,
        username: user.username,
        source: 'admin',
        action: 'set_command_visibility',
        detail: JSON.stringify({ command, value }),
        success: true,
      })
      return reply.send(result ?? { ok: true })
    } catch (error) {
      if (user) {
        recordOperationLog(db, {
          guildId,
          discordUserId: user.discordId,
          username: user.username,
          source: 'admin',
          action: 'set_command_visibility',
          detail: error.message,
          success: false,
        })
      }
      return bindRouteError(reply, error)
    }
  })

  app.get('/api/admin/:guildId/logs', async (request, reply) => {
    try {
      const user = getSessionUser(request)
      const { guildId } = request.params
      await requireAdminPermission({ botClient, guildId, userId: user.discordId })

      const parsedLimit = Number.parseInt(request.query?.limit, 10)
      const limit = Math.min(Number.isInteger(parsedLimit) && parsedLimit > 0 ? parsedLimit : DEFAULT_LOG_LIMIT, MAX_LOG_LIMIT)
      const beforeId = Number.parseInt(request.query?.before, 10)

      const rows = Number.isInteger(beforeId)
        ? db.prepare(`
            SELECT * FROM operation_logs
            WHERE guild_id = ? AND id < ?
            ORDER BY id DESC
            LIMIT ?
          `).all(guildId, beforeId, limit)
        : db.prepare(`
            SELECT * FROM operation_logs
            WHERE guild_id = ?
            ORDER BY id DESC
            LIMIT ?
          `).all(guildId, limit)

      return reply.send({
        logs: rows.map((row) => ({
          id: row.id,
          discordUserId: row.discord_user_id,
          username: row.username,
          source: row.source,
          action: row.action,
          detail: row.detail,
          success: Boolean(row.success),
          createdAt: row.created_at,
        })),
      })
    } catch (error) {
      return bindRouteError(reply, error)
    }
  })
}

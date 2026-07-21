import { bindRouteError, callBot, getSessionUser, requireBotPermission, recordOperationLog } from './route-utils.js'

const CONTROL_ACTIONS = new Set(['pause', 'resume', 'skip', 'stop', 'autoplay'])

export async function controlRoutes(app, { botClient, db } = {}) {
  app.post('/api/guilds/:guildId/control/:action', async (request, reply) => {
    try {
      const user = getSessionUser(request)
      const { guildId, action } = request.params
      if (!CONTROL_ACTIONS.has(action)) return reply.code(404).send({ error: 'unknown_control_action' })
      if (!botClient) throw new Error('botClient is required for control routes')

      await requireBotPermission({ botClient, guildId, userId: user.discordId })
      // The bot API requires body.userId on every control action; always use
      // the authenticated session user rather than trusting a client-
      // supplied value, matching /api/permission's convention.
      const result = await callBot(botClient, 'POST', `/control/${encodeURIComponent(guildId)}/${action}`, { ...request.body, userId: user.discordId })
      if (db) {
        recordOperationLog(db, {
          guildId,
          discordUserId: user.discordId,
          username: user.username,
          source: 'control',
          action,
          detail: JSON.stringify(request.body ?? {}),
          success: true,
        })
      }
      return reply.send(result ?? { ok: true })
    } catch (error) {
      return bindRouteError(reply, error)
    }
  })
}

import { bindRouteError, callBot, getSessionUser, requireBotPermission, recordOperationLog } from './route-utils.js'

const QUEUE_ACTIONS = new Set(['remove', 'move'])

export async function queueRoutes(app, { botClient, db } = {}) {
  app.post('/api/guilds/:guildId/queue/:action', async (request, reply) => {
    try {
      const user = getSessionUser(request)
      const { guildId, action } = request.params
      if (!QUEUE_ACTIONS.has(action)) return reply.code(404).send({ error: 'unknown_queue_action' })
      if (!botClient) throw new Error('botClient is required for queue routes')

      await requireBotPermission({ botClient, guildId, userId: user.discordId })
      // Same as control.js: the bot API requires body.userId, and it must
      // come from the authenticated session, not the client-supplied body.
      const result = await callBot(botClient, 'POST', `/queue/${encodeURIComponent(guildId)}/${action}`, { ...request.body, userId: user.discordId })
      if (db) {
        recordOperationLog(db, {
          guildId,
          discordUserId: user.discordId,
          username: user.username,
          source: 'control',
          action: `queue:${action}`,
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

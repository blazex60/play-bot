import { bindRouteError, callBot, getSessionUser, requireBotPermission, recordOperationLog } from './route-utils.js'

const QUEUE_ACTIONS = new Set(['remove', 'move'])

export async function queueRoutes(app, { botClient, db } = {}) {
  app.post('/api/guilds/:guildId/queue/:action', async (request, reply) => {
    const { guildId, action } = request.params
    let user
    try {
      user = getSessionUser(request)
      if (!QUEUE_ACTIONS.has(action)) {
        if (db) {
          recordOperationLog(db, {
            guildId,
            discordUserId: user.discordId,
            username: user.username,
            source: 'control',
            action: `queue:${action}`,
            detail: 'unknown_queue_action',
            success: false,
          })
        }
        return reply.code(404).send({ error: 'unknown_queue_action' })
      }
      if (!botClient) throw new Error('botClient is required for queue routes')

      await requireBotPermission({ botClient, guildId, userId: user.discordId })
      // Same as control.js: the bot API requires body.userId, and it must
      // come from the authenticated session, not the client-supplied body.
      const result = await callBot(botClient, 'POST', `/queue/${encodeURIComponent(guildId)}/${action}`, { ...request.body, userId: user.discordId })
      const responseBody = result ?? { ok: true }
      if (db) {
        recordOperationLog(db, {
          guildId,
          discordUserId: user.discordId,
          username: user.username,
          source: 'control',
          action: `queue:${action}`,
          // Log the effective payload, not the raw client body — see
          // control.js for why (a client-supplied userId could otherwise
          // contradict discordUserId in the log).
          detail: JSON.stringify({ ...(request.body ?? {}), userId: user.discordId }),
          // remove/move report ok: false for an out-of-range index without
          // throwing, so the bot API's own result decides success.
          success: responseBody.ok !== false,
        })
      }
      return reply.send(responseBody)
    } catch (error) {
      if (db && user) {
        recordOperationLog(db, {
          guildId,
          discordUserId: user.discordId,
          username: user.username,
          source: 'control',
          action: `queue:${action}`,
          detail: error.message,
          success: false,
        })
      }
      return bindRouteError(reply, error)
    }
  })
}

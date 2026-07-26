import { requireBotPermission, requireCommandPermission, withAuditedBotAction } from './route-utils.js'

const QUEUE_ACTIONS = new Set(['remove', 'move'])

export async function queueRoutes(app, { botClient, db } = {}) {
  app.post('/api/guilds/:guildId/queue/:action', (request, reply) => withAuditedBotAction(request, reply, {
    db,
    source: 'control',
    action: (req) => `queue:${req.params.action}`,
    guard: async ({ request, user }) => {
      const { guildId, action } = request.params
      if (!QUEUE_ACTIONS.has(action)) {
        const error = new Error('unknown_queue_action')
        error.statusCode = 404
        throw error
      }
      if (!botClient) throw new Error('botClient is required for queue routes')
      await requireBotPermission({ botClient, guildId, userId: user.discordId })
      // Both queue actions (remove/move) fall under the 'queue' command
      // permission — the same one gating /queue and its editor buttons.
      await requireCommandPermission({ botClient, guildId, userId: user.discordId, command: 'queue' })
    },
    run: async ({ request, user }) => {
      const { guildId, action } = request.params
      // Same as control.js: the bot API requires body.userId, and it must
      // come from the authenticated session, not the client-supplied body.
      const result = await botClient.queue(guildId, action, { ...request.body, userId: user.discordId })
      return result ?? { ok: true }
    },
    // Log the effective payload, not the raw client body — see control.js
    // for why (a client-supplied userId could otherwise contradict
    // discordUserId in the log).
    buildDetail: ({ request, user }) => JSON.stringify({ ...(request.body ?? {}), userId: user.discordId }),
    // remove/move report ok: false for an out-of-range index without
    // throwing, so the bot API's own result decides success.
  }))
}

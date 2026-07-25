import { requireBotPermission, requireCommandPermission, withAuditedBotAction } from './route-utils.js'

const CONTROL_ACTIONS = new Set(['pause', 'resume', 'skip', 'stop', 'autoplay'])

export async function controlRoutes(app, { botClient, db } = {}) {
  app.post('/api/guilds/:guildId/control/:action', (request, reply) => withAuditedBotAction(request, reply, {
    db,
    source: 'control',
    action: (req) => req.params.action,
    guard: async ({ request, user }) => {
      const { guildId, action } = request.params
      if (!CONTROL_ACTIONS.has(action)) {
        const error = new Error('unknown_control_action')
        error.statusCode = 404
        throw error
      }
      if (!botClient) throw new Error('botClient is required for control routes')
      await requireBotPermission({ botClient, guildId, userId: user.discordId })
      // Control action names match their equivalent slash command 1:1
      // (pause/resume/skip/stop/autoplay), so the same admin-configured
      // per-command permission matrix applies here.
      await requireCommandPermission({ botClient, guildId, userId: user.discordId, command: action })
    },
    run: async ({ request, user }) => {
      const { guildId, action } = request.params
      // The bot API requires body.userId on every control action; always use
      // the authenticated session user rather than trusting a client-
      // supplied value, matching /api/permission's convention.
      const result = await botClient.control(guildId, action, { ...request.body, userId: user.discordId })
      return result ?? { ok: true }
    },
    // Log the effective payload (post userId-override), not the raw client
    // body — a client could otherwise set its own userId in the body and
    // have it logged even though it was never honored.
    buildDetail: ({ request, user }) => JSON.stringify({ ...(request.body ?? {}), userId: user.discordId }),
    // pause/resume can report ok: false (e.g. "not currently playing")
    // without throwing, so the bot API's own result decides success, not
    // just whether botClient.control resolved.
  }))
}

import { bindRouteError, callBot, getSessionUser, requireBotPermission, requireCommandPermission, recordOperationLog } from './route-utils.js'

const CONTROL_ACTIONS = new Set(['pause', 'resume', 'skip', 'stop', 'autoplay'])

export async function controlRoutes(app, { botClient, db } = {}) {
  app.post('/api/guilds/:guildId/control/:action', async (request, reply) => {
    const { guildId, action } = request.params
    let user
    try {
      user = getSessionUser(request)
      if (!CONTROL_ACTIONS.has(action)) {
        if (db) {
          recordOperationLog(db, {
            guildId,
            discordUserId: user.discordId,
            username: user.username,
            source: 'control',
            action,
            detail: 'unknown_control_action',
            success: false,
          })
        }
        return reply.code(404).send({ error: 'unknown_control_action' })
      }
      if (!botClient) throw new Error('botClient is required for control routes')

      await requireBotPermission({ botClient, guildId, userId: user.discordId })
      // Control action names match their equivalent slash command 1:1
      // (pause/resume/skip/stop/autoplay), so the same admin-configured
      // per-command permission matrix applies here.
      await requireCommandPermission({ botClient, guildId, userId: user.discordId, command: action })
      // The bot API requires body.userId on every control action; always use
      // the authenticated session user rather than trusting a client-
      // supplied value, matching /api/permission's convention.
      const result = await callBot(botClient, 'POST', `/control/${encodeURIComponent(guildId)}/${action}`, { ...request.body, userId: user.discordId })
      const responseBody = result ?? { ok: true }
      if (db) {
        recordOperationLog(db, {
          guildId,
          discordUserId: user.discordId,
          username: user.username,
          source: 'control',
          action,
          // Log the effective payload (post userId-override), not the raw
          // client body — a client could otherwise set its own userId in
          // the body and have it logged even though it was never honored.
          detail: JSON.stringify({ ...(request.body ?? {}), userId: user.discordId }),
          // pause/resume can report ok: false (e.g. "not currently playing")
          // without throwing, so the bot API's own result decides success,
          // not just whether callBot resolved.
          success: responseBody.ok !== false,
        })
      }
      return reply.send(responseBody)
    } catch (error) {
      // Denied permission / bot API failure land here — record it so the
      // audit trail also captures failed attempts, not only successful ones.
      if (db && user) {
        recordOperationLog(db, {
          guildId,
          discordUserId: user.discordId,
          username: user.username,
          source: 'control',
          action,
          detail: error.message,
          success: false,
        })
      }
      return bindRouteError(reply, error)
    }
  })
}

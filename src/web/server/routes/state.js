import { bindRouteError, getSessionUser } from './route-utils.js'

export async function stateRoutes(app, { botClient } = {}) {
  app.get('/api/state/:guildId', async (request, reply) => {
    try {
      getSessionUser(request)
      if (!botClient) throw new Error('botClient is required for state routes')
      const state = await botClient.state(request.params.guildId)
      return reply.send(state)
    } catch (error) {
      return bindRouteError(reply, error)
    }
  })

  app.get('/api/permission', async (request, reply) => {
    try {
      const user = getSessionUser(request)
      const { guildId } = request.query ?? {}
      if (!guildId) return reply.code(400).send({ error: 'missing_guild_id' })
      if (!botClient) throw new Error('botClient is required for permission route')
      // Always resolve permission for the authenticated session user, never a
      // client-supplied userId, to prevent querying another user's permission.
      const permission = await botClient.permission({ guildId, userId: user.discordId })
      return reply.send(permission)
    } catch (error) {
      return bindRouteError(reply, error)
    }
  })
}

import { listSpotifyPlaylists } from '../services/spotify.js'
import { listYoutubePlaylists } from '../services/youtube.js'
import { bindRouteError, getSessionUser } from './route-utils.js'

const SERVICES = ['spotify', 'youtube']

function serviceStatus(db, userId, service) {
  const row = db.prepare(`
    SELECT service, status, token_expires_at, updated_at
    FROM service_links
    WHERE discord_user_id = ? AND service = ?
  `).get(userId, service)

  return {
    service,
    linked: row?.status === 'active',
    status: row?.status ?? 'unlinked',
    tokenExpiresAt: row?.token_expires_at ?? null,
    updatedAt: row?.updated_at ?? null,
  }
}

export async function linksRoutes(app, { db, services, authBasePath = '/auth' } = {}) {
  app.get('/api/links', async (request, reply) => {
    try {
      const user = getSessionUser(request)
      if (!db) throw new Error('db is required for links routes')
      return reply.send({ services: SERVICES.map((service) => serviceStatus(db, user.discordId, service)) })
    } catch (error) {
      return bindRouteError(reply, error)
    }
  })

  app.get('/api/links/:service/playlists', async (request, reply) => {
    try {
      const user = getSessionUser(request)
      const { service } = request.params
      if (service === 'spotify') {
        const playlists = await (services?.spotify?.listPlaylists ?? listSpotifyPlaylists)(user.discordId)
        return reply.send({ playlists })
      }
      if (service === 'youtube') {
        const playlists = await (services?.youtube?.listPlaylists ?? listYoutubePlaylists)(user.discordId)
        return reply.send({ playlists })
      }
      return reply.code(404).send({ error: 'unknown_service' })
    } catch (error) {
      return bindRouteError(reply, error)
    }
  })

  app.post('/api/links/:service/relink', async (request, reply) => {
    try {
      getSessionUser(request)
      const { service } = request.params
      if (!SERVICES.includes(service)) return reply.code(404).send({ error: 'unknown_service' })
      return reply.send({ redirectUrl: `${authBasePath}/${service}` })
    } catch (error) {
      return bindRouteError(reply, error)
    }
  })
}

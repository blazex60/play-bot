import { resolveImportTracks, toImportTrackRow } from '../matching.js'
import { listSpotifyPlaylistTracks } from '../services/spotify.js'
import { listYoutubePlaylistTracks } from '../services/youtube.js'
import { bindRouteError, callBot, getSessionUser, nowUnix, requireBotPermission } from './route-utils.js'

function insertImportJob(db, { userId, guildId, service, playlistId, playlistName, totalCount }) {
  const result = db.prepare(`
    INSERT INTO import_jobs
      (discord_user_id, guild_id, service, playlist_id, playlist_name, total_count, status, created_at)
    VALUES
      (?, ?, ?, ?, ?, ?, 'running', ?)
  `).run(userId, guildId, service, playlistId, playlistName ?? null, totalCount, nowUnix())
  return Number(result.lastInsertRowid)
}

function insertImportTrack(db, jobId, row) {
  db.prepare(`
    INSERT INTO import_tracks
      (job_id, position, source_title, source_artist, source_url, matched_url, matched_title, match_status)
    VALUES
      (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    jobId,
    row.position,
    row.source_title,
    row.source_artist,
    row.source_url,
    row.matched_url,
    row.matched_title,
    row.match_status
  )
}

function completeImportJob(db, jobId, { matchedCount, failedCount, status }) {
  db.prepare(`
    UPDATE import_jobs
    SET matched_count = ?, failed_count = ?, status = ?, completed_at = ?
    WHERE id = ?
  `).run(matchedCount, failedCount, status, nowUnix(), jobId)
}

function failImportJob(db, jobId, { matchedCount = 0, failedCount = 0 } = {}) {
  completeImportJob(db, jobId, { matchedCount, failedCount, status: 'failed' })
}

async function listPlaylistTracks({ service, userId, playlistId, services }) {
  if (service === 'spotify') {
    return (services?.spotify?.listPlaylistTracks ?? listSpotifyPlaylistTracks)(userId, playlistId)
  }
  if (service === 'youtube') {
    return (services?.youtube?.listPlaylistTracks ?? listYoutubePlaylistTracks)(userId, playlistId)
  }
  const error = new Error(`Unsupported import service: ${service}`)
  error.statusCode = 400
  throw error
}

async function enqueueImport(botClient, guildId, payload) {
  if (typeof botClient?.enqueueImport === 'function') {
    return botClient.enqueueImport(guildId, payload)
  }
  return callBot(botClient, 'POST', `/import/${encodeURIComponent(guildId)}/enqueue`, payload)
}

export async function importRoutes(app, { db, botClient, services, searchYoutube } = {}) {
  app.post('/api/import/:guildId', async (request, reply) => {
    let jobId = null
    try {
      const user = getSessionUser(request)
      const { guildId } = request.params
      const { service, playlistId, playlistName } = request.body ?? {}

      if (!db) throw new Error('db is required for import routes')
      if (!botClient) throw new Error('botClient is required for import routes')
      if (!service || !playlistId) {
        return reply.code(400).send({ error: 'missing_import_request' })
      }

      await requireBotPermission({ botClient, guildId, userId: user.discordId })

      const providerTracks = await listPlaylistTracks({ service, userId: user.discordId, playlistId, services })
      jobId = insertImportJob(db, {
        userId: user.discordId,
        guildId,
        service,
        playlistId,
        playlistName,
        totalCount: providerTracks.length,
      })

      const resolved = await resolveImportTracks({
        service,
        tracks: providerTracks,
        requestedBy: user.discordId,
        searchYoutube,
      })

      const matchedTracks = []
      resolved.forEach((result, index) => {
        insertImportTrack(db, jobId, toImportTrackRow(result, index))
        if (result.track) matchedTracks.push(result.track)
      })

      const botResponse = await enqueueImport(botClient, guildId, {
        userId: user.discordId,
        jobId,
        tracks: matchedTracks,
      }).catch((error) => {
        if (error.statusCode === 409 || error.status === 409 || error.code === 'user_not_in_voice') {
          error.statusCode = 409
          error.publicMessage = '先にVCに参加してください'
        }
        throw error
      })

      const matchedCount = botResponse?.matchedCount ?? botResponse?.matched_count ?? matchedTracks.length
      const failedCount = botResponse?.failedCount ?? botResponse?.failed_count ?? (providerTracks.length - matchedCount)
      const status = failedCount > 0 ? 'partial' : 'completed'
      completeImportJob(db, jobId, { matchedCount, failedCount, status })

      return reply.send({ jobId, status, matchedCount, failedCount })
    } catch (error) {
      if (jobId !== null) {
        failImportJob(db, jobId)
      }
      return bindRouteError(reply, error)
    }
  })
}

import { resolveYoutubeTrack, toImportTrackRow } from '../matching.js'
import { searchYoutube as defaultSearchYoutube } from '../../../search.js'
import { bindRouteError, callBot, getSessionUser, requireBotPermission } from './route-utils.js'

function getImportTrack(db, trackId) {
  return db.prepare(`
    SELECT it.*, ij.guild_id, ij.discord_user_id, ij.service
    FROM import_tracks it
    JOIN import_jobs ij ON ij.id = it.job_id
    WHERE it.id = ?
  `).get(trackId)
}

function updateImportTrack(db, trackId, row, status = 'replaced') {
  db.prepare(`
    UPDATE import_tracks
    SET matched_url = ?, matched_title = ?, match_status = ?
    WHERE id = ?
  `).run(row.matched_url, row.matched_title, status, trackId)
}

async function enqueueReplacement(botClient, guildId, payload) {
  if (typeof botClient?.enqueueImport === 'function') {
    return botClient.enqueueImport(guildId, payload)
  }
  return callBot(botClient, 'POST', `/import/${encodeURIComponent(guildId)}/enqueue`, payload)
}

export async function importEditRoutes(app, { db, botClient, searchYoutube } = {}) {
  const search = searchYoutube ?? defaultSearchYoutube
  app.get('/api/import/jobs/:jobId/tracks', async (request, reply) => {
    try {
      const user = getSessionUser(request)
      if (!db) throw new Error('db is required for import edit routes')
      const job = db.prepare('SELECT discord_user_id FROM import_jobs WHERE id = ?').get(request.params.jobId)
      if (!job || job.discord_user_id !== user.discordId) {
        return reply.code(404).send({ error: 'import_job_not_found' })
      }
      const rows = db.prepare('SELECT * FROM import_tracks WHERE job_id = ? ORDER BY position ASC').all(request.params.jobId)
      return reply.send({ tracks: rows })
    } catch (error) {
      return bindRouteError(reply, error)
    }
  })

  app.post('/api/import/tracks/:trackId/search', async (request, reply) => {
    try {
      getSessionUser(request)
      const { query } = request.body ?? {}
      if (!query) return reply.code(400).send({ error: 'missing_query' })
      const results = await search(query)
      return reply.send({ results })
    } catch (error) {
      return bindRouteError(reply, error)
    }
  })

  app.post('/api/import/tracks/:trackId/replace', async (request, reply) => {
    try {
      const user = getSessionUser(request)
      if (!db) throw new Error('db is required for import edit routes')
      if (!botClient) throw new Error('botClient is required for import edit routes')

      const existing = getImportTrack(db, request.params.trackId)
      if (!existing) return reply.code(404).send({ error: 'import_track_not_found' })

      await requireBotPermission({ botClient, guildId: existing.guild_id, userId: user.discordId })

      const { youtubeResult } = request.body ?? {}
      if (!youtubeResult) return reply.code(400).send({ error: 'missing_youtube_result' })

      const result = resolveYoutubeTrack(youtubeResult, { requestedBy: user.username, requestedById: user.discordId })

      if (!result.track) return reply.code(404).send({ error: result.reason ?? 'no_match' })

      const row = toImportTrackRow(result, existing.position)
      updateImportTrack(db, existing.id, row)
      await enqueueReplacement(botClient, existing.guild_id, {
        userId: user.discordId,
        jobId: existing.job_id,
        tracks: [result.track],
      })

      return reply.send({ track: result.track })
    } catch (error) {
      return bindRouteError(reply, error)
    }
  })
}

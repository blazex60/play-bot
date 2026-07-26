import { createTrack } from '../../../queue.js'
import { resolveMetadata as defaultResolveMetadata, searchYoutube as defaultSearchYoutube } from '../../../search.js'
import { resolveYoutubeTrack } from '../matching.js'
import { bindRouteError, enqueueImportTracks, getSessionUser, requireBotPermission, requireCommandPermission, recordOperationLog } from './route-utils.js'
import {
  serializePlaylistRow,
  serializeTrackRow,
  listPlaylists,
  getOwnedPlaylist,
  getPlaylistTracks,
  createPlaylist,
  renamePlaylist,
  deletePlaylist,
  insertTrack,
  deleteTrack,
  moveTrack,
} from './playlists-db.js'

function parseId(value) {
  const id = Number.parseInt(value, 10)
  return Number.isInteger(id) ? id : null
}

function isHttpUrl(value) {
  try {
    return ['http:', 'https:'].includes(new URL(value).protocol)
  } catch {
    return false
  }
}

async function resolveTrackInput(body, { user, resolveMetadataFn }) {
  if (typeof body?.url === 'string' && body.url.trim()) {
    try {
      return await resolveMetadataFn(body.url.trim(), { requestedBy: user.username, requestedById: user.discordId })
    } catch (err) {
      const error = new Error(err.message)
      error.statusCode = 400
      error.code = 'track_resolve_failed'
      error.publicMessage = '動画情報の取得に失敗しました'
      throw error
    }
  }

  if (body?.track && typeof body.track === 'object') {
    const { title, webpageUrl } = body.track
    if (!title || !webpageUrl || !isHttpUrl(webpageUrl)) {
      const error = new Error('track.title and a valid http(s) track.webpageUrl are required')
      error.statusCode = 400
      error.code = 'invalid_track'
      throw error
    }
    return createTrack({
      title,
      webpageUrl,
      duration: body.track.duration ?? null,
      requestedBy: user.username,
      requestedById: user.discordId,
      thumbnail: body.track.thumbnail ?? null,
      videoId: body.track.videoId ?? null,
      channel: body.track.channel ?? null,
    })
  }

  const error = new Error('url or track is required')
  error.statusCode = 400
  error.code = 'missing_track_input'
  throw error
}

export async function playlistsRoutes(app, {
  db,
  botClient,
  searchYoutube = defaultSearchYoutube,
  resolveMetadata = defaultResolveMetadata,
} = {}) {
  app.get('/api/playlists/mine', async (request, reply) => {
    try {
      const user = getSessionUser(request)
      if (!db) throw new Error('db is required for playlist routes')
      return reply.send({ playlists: listPlaylists(db, user.discordId) })
    } catch (error) {
      return bindRouteError(reply, error)
    }
  })

  app.post('/api/playlists/mine', async (request, reply) => {
    try {
      const user = getSessionUser(request)
      if (!db) throw new Error('db is required for playlist routes')
      const name = typeof request.body?.name === 'string' ? request.body.name.trim() : ''
      if (!name) return reply.code(400).send({ error: 'name_required' })
      const id = createPlaylist(db, user.discordId, name)
      return reply.send(serializePlaylistRow({ ...getOwnedPlaylist(db, user.discordId, id), track_count: 0 }))
    } catch (error) {
      return bindRouteError(reply, error)
    }
  })

  app.get('/api/playlists/mine/:id', async (request, reply) => {
    try {
      const user = getSessionUser(request)
      if (!db) throw new Error('db is required for playlist routes')
      const playlist = getOwnedPlaylist(db, user.discordId, parseId(request.params.id))
      const tracks = getPlaylistTracks(db, playlist.id).map(serializeTrackRow)
      return reply.send({
        id: playlist.id,
        name: playlist.name,
        createdAt: playlist.created_at,
        updatedAt: playlist.updated_at,
        tracks,
      })
    } catch (error) {
      return bindRouteError(reply, error)
    }
  })

  app.patch('/api/playlists/mine/:id', async (request, reply) => {
    try {
      const user = getSessionUser(request)
      if (!db) throw new Error('db is required for playlist routes')
      const playlist = getOwnedPlaylist(db, user.discordId, parseId(request.params.id))
      const name = typeof request.body?.name === 'string' ? request.body.name.trim() : ''
      if (!name) return reply.code(400).send({ error: 'name_required' })
      renamePlaylist(db, playlist.id, name)
      return reply.send(serializePlaylistRow({ ...getOwnedPlaylist(db, user.discordId, playlist.id), track_count: getPlaylistTracks(db, playlist.id).length }))
    } catch (error) {
      return bindRouteError(reply, error)
    }
  })

  app.delete('/api/playlists/mine/:id', async (request, reply) => {
    try {
      const user = getSessionUser(request)
      if (!db) throw new Error('db is required for playlist routes')
      const playlist = getOwnedPlaylist(db, user.discordId, parseId(request.params.id))
      deletePlaylist(db, playlist.id)
      return reply.send({ ok: true })
    } catch (error) {
      return bindRouteError(reply, error)
    }
  })

  app.post('/api/playlists/mine/:id/search', async (request, reply) => {
    try {
      const user = getSessionUser(request)
      if (!db) throw new Error('db is required for playlist routes')
      getOwnedPlaylist(db, user.discordId, parseId(request.params.id))
      const query = typeof request.body?.query === 'string' ? request.body.query.trim() : ''
      if (!query) return reply.code(400).send({ error: 'query_required' })

      const entries = await searchYoutube(query)
      const results = entries
        .map((entry) => resolveYoutubeTrack(entry, { requestedBy: user.username, requestedById: user.discordId }))
        .filter((result) => result.status === 'matched')
        .map((result) => result.track)
      return reply.send({ results })
    } catch (error) {
      return bindRouteError(reply, error)
    }
  })

  app.post('/api/playlists/mine/:id/tracks', async (request, reply) => {
    try {
      const user = getSessionUser(request)
      if (!db) throw new Error('db is required for playlist routes')
      const playlist = getOwnedPlaylist(db, user.discordId, parseId(request.params.id))
      const track = await resolveTrackInput(request.body, { user, resolveMetadataFn: resolveMetadata })
      insertTrack(db, playlist.id, track)
      const tracks = getPlaylistTracks(db, playlist.id).map(serializeTrackRow)
      return reply.send({ tracks })
    } catch (error) {
      return bindRouteError(reply, error)
    }
  })

  app.delete('/api/playlists/mine/:id/tracks/:trackId', async (request, reply) => {
    try {
      const user = getSessionUser(request)
      if (!db) throw new Error('db is required for playlist routes')
      const playlist = getOwnedPlaylist(db, user.discordId, parseId(request.params.id))
      const trackId = parseId(request.params.trackId)
      if (trackId === null) return reply.code(400).send({ error: 'invalid_track_id' })
      const removed = deleteTrack(db, playlist.id, trackId)
      if (!removed) return reply.code(404).send({ error: 'track_not_found' })
      const tracks = getPlaylistTracks(db, playlist.id).map(serializeTrackRow)
      return reply.send({ tracks })
    } catch (error) {
      return bindRouteError(reply, error)
    }
  })

  app.post('/api/playlists/mine/:id/tracks/move', async (request, reply) => {
    try {
      const user = getSessionUser(request)
      if (!db) throw new Error('db is required for playlist routes')
      const playlist = getOwnedPlaylist(db, user.discordId, parseId(request.params.id))
      const fromIndex = Number.parseInt(String(request.body?.fromIndex), 10)
      const toIndex = Number.parseInt(String(request.body?.toIndex), 10)
      const ok = moveTrack(db, playlist.id, fromIndex, toIndex)
      const tracks = getPlaylistTracks(db, playlist.id).map(serializeTrackRow)
      return reply.send({ ok, tracks })
    } catch (error) {
      return bindRouteError(reply, error)
    }
  })

  app.post('/api/playlists/mine/:id/queue', async (request, reply) => {
    let user
    let guildId
    try {
      user = getSessionUser(request)
      if (!db) throw new Error('db is required for playlist routes')
      if (!botClient) throw new Error('botClient is required for playlist routes')
      const playlist = getOwnedPlaylist(db, user.discordId, parseId(request.params.id))
      guildId = typeof request.body?.guildId === 'string' ? request.body.guildId : ''
      if (!guildId) return reply.code(400).send({ error: 'guildId_required' })

      const rows = getPlaylistTracks(db, playlist.id)
      if (rows.length === 0) return reply.code(400).send({ error: 'playlist_empty' })

      // Only gate on bot-permission (VC co-presence/Admin) when the guild already
      // has a live session to protect. When there is none, /import/:guildId/enqueue
      // on the bot side self-services session creation from the requester's own
      // current voice channel (see botApi.js), so requiring permission here would
      // wrongly 403 a user who is simply starting playback for the first time.
      const state = await botClient.state(guildId)
      if (state?.active) {
        await requireBotPermission({ botClient, guildId, userId: user.discordId })
      }
      // Unlike the bot-permission check above, the 'play' command permission
      // isn't about VC co-presence — it applies whether or not a session
      // already exists, including this route's own no-session case (which
      // starts a brand new session, the same as /play would).
      await requireCommandPermission({ botClient, guildId, userId: user.discordId, command: 'play' })

      const tracks = rows.map((row) => createTrack({
        title: row.title,
        webpageUrl: row.webpage_url,
        duration: row.duration,
        requestedBy: user.username,
        requestedById: user.discordId,
        thumbnail: row.thumbnail,
        videoId: row.video_id,
        channel: row.channel,
      }))

      const botResponse = await enqueueImportTracks(botClient, guildId, {
        userId: user.discordId,
        tracks,
      }).catch((error) => {
        if (error.statusCode === 409 || error.status === 409 || error.code === 'user_not_in_voice') {
          error.statusCode = 409
          error.publicMessage = '先にVCに参加してください'
        }
        throw error
      })

      const enqueuedCount = botResponse?.enqueuedCount ?? tracks.length
      recordOperationLog(db, {
        guildId,
        discordUserId: user.discordId,
        username: user.username,
        source: 'control',
        action: 'playlist_queue',
        detail: JSON.stringify({ playlistId: playlist.id, enqueuedCount }),
        success: true,
      })

      return reply.send({ ok: true, enqueuedCount })
    } catch (error) {
      if (db && user && guildId) {
        recordOperationLog(db, {
          guildId,
          discordUserId: user.discordId,
          username: user.username,
          source: 'control',
          action: 'playlist_queue',
          detail: error.message,
          success: false,
        })
      }
      return bindRouteError(reply, error)
    }
  })
}

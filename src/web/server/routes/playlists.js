import { createTrack } from '../../../queue.js'
import { resolveMetadata as defaultResolveMetadata, searchYoutube as defaultSearchYoutube } from '../../../search.js'
import { resolveYoutubeTrack } from '../matching.js'
import { bindRouteError, callBot, getSessionUser, nowUnix, requireBotPermission } from './route-utils.js'

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

function serializePlaylistRow(row) {
  return {
    id: row.id,
    name: row.name,
    trackCount: row.track_count ?? 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function serializeTrackRow(row) {
  return {
    id: row.id,
    position: row.position,
    title: row.title,
    webpageUrl: row.webpage_url,
    duration: row.duration,
    thumbnail: row.thumbnail,
    videoId: row.video_id,
    channel: row.channel,
  }
}

function listPlaylists(db, userId) {
  const rows = db.prepare(`
    SELECT p.id, p.name, p.created_at, p.updated_at,
           (SELECT COUNT(*) FROM user_playlist_tracks t WHERE t.playlist_id = p.id) AS track_count
    FROM user_playlists p
    WHERE p.discord_user_id = ?
    ORDER BY p.updated_at DESC
  `).all(userId)
  return rows.map(serializePlaylistRow)
}

function getOwnedPlaylist(db, userId, id) {
  const row = id === null ? null : db.prepare(`
    SELECT id, discord_user_id, name, created_at, updated_at
    FROM user_playlists
    WHERE id = ?
  `).get(id)
  if (!row || row.discord_user_id !== userId) {
    const error = new Error('Playlist not found')
    error.statusCode = 404
    error.code = 'playlist_not_found'
    throw error
  }
  return row
}

function getPlaylistTracks(db, playlistId) {
  return db.prepare(`
    SELECT id, position, title, webpage_url, duration, thumbnail, video_id, channel
    FROM user_playlist_tracks
    WHERE playlist_id = ?
    ORDER BY position ASC
  `).all(playlistId)
}

function createPlaylist(db, userId, name) {
  const now = nowUnix()
  const result = db.prepare(`
    INSERT INTO user_playlists (discord_user_id, name, created_at, updated_at)
    VALUES (?, ?, ?, ?)
  `).run(userId, name, now, now)
  return Number(result.lastInsertRowid)
}

function touchPlaylist(db, id) {
  db.prepare('UPDATE user_playlists SET updated_at = ? WHERE id = ?').run(nowUnix(), id)
}

function renamePlaylist(db, id, name) {
  db.prepare('UPDATE user_playlists SET name = ?, updated_at = ? WHERE id = ?').run(name, nowUnix(), id)
}

function deletePlaylist(db, id) {
  db.prepare('DELETE FROM user_playlists WHERE id = ?').run(id)
}

function nextPosition(db, playlistId) {
  const row = db.prepare(
    'SELECT COALESCE(MAX(position), -1) AS maxPosition FROM user_playlist_tracks WHERE playlist_id = ?'
  ).get(playlistId)
  return row.maxPosition + 1
}

function insertTrack(db, playlistId, track) {
  db.prepare(`
    INSERT INTO user_playlist_tracks
      (playlist_id, position, title, webpage_url, duration, thumbnail, video_id, channel, added_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    playlistId,
    nextPosition(db, playlistId),
    track.title,
    track.webpageUrl,
    track.duration ?? null,
    track.thumbnail ?? null,
    track.videoId ?? null,
    track.channel ?? null,
    nowUnix()
  )
  touchPlaylist(db, playlistId)
}

function deleteTrack(db, playlistId, trackId) {
  const result = db.prepare('DELETE FROM user_playlist_tracks WHERE id = ? AND playlist_id = ?').run(trackId, playlistId)
  if (result.changes > 0) touchPlaylist(db, playlistId)
  return result.changes > 0
}

function moveTrack(db, playlistId, fromIndex, toIndex) {
  const rows = getPlaylistTracks(db, playlistId)
  if (
    !Number.isInteger(fromIndex) || !Number.isInteger(toIndex) ||
    fromIndex < 0 || fromIndex >= rows.length ||
    toIndex < 0 || toIndex >= rows.length
  ) {
    return false
  }
  const [moved] = rows.splice(fromIndex, 1)
  rows.splice(toIndex, 0, moved)
  const reorder = db.transaction((ordered) => {
    // Two-phase: position is UNIQUE per playlist, so reassigning final values
    // directly can collide with another row's still-current position (e.g.
    // swapping two adjacent tracks). Stage everything to negative, collision-free
    // slots first, then assign the real 0..n-1 positions.
    ordered.forEach((row, index) => {
      db.prepare('UPDATE user_playlist_tracks SET position = ? WHERE id = ?').run(-(index + 1), row.id)
    })
    ordered.forEach((row, index) => {
      db.prepare('UPDATE user_playlist_tracks SET position = ? WHERE id = ?').run(index, row.id)
    })
  })
  reorder(rows)
  touchPlaylist(db, playlistId)
  return true
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

async function enqueuePlaylistTracks(botClient, guildId, payload) {
  if (typeof botClient?.enqueueImport === 'function') {
    return botClient.enqueueImport(guildId, payload)
  }
  return callBot(botClient, 'POST', `/import/${encodeURIComponent(guildId)}/enqueue`, payload)
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
    try {
      const user = getSessionUser(request)
      if (!db) throw new Error('db is required for playlist routes')
      if (!botClient) throw new Error('botClient is required for playlist routes')
      const playlist = getOwnedPlaylist(db, user.discordId, parseId(request.params.id))
      const guildId = typeof request.body?.guildId === 'string' ? request.body.guildId : ''
      if (!guildId) return reply.code(400).send({ error: 'guildId_required' })

      const rows = getPlaylistTracks(db, playlist.id)
      if (rows.length === 0) return reply.code(400).send({ error: 'playlist_empty' })

      // Only gate on bot-permission (VC co-presence/Admin) when the guild already
      // has a live session to protect. When there is none, /import/:guildId/enqueue
      // on the bot side self-services session creation from the requester's own
      // current voice channel (see botApi.js), so requiring permission here would
      // wrongly 403 a user who is simply starting playback for the first time.
      const state = await callBot(botClient, 'GET', `/state/${encodeURIComponent(guildId)}`)
      if (state?.active) {
        await requireBotPermission({ botClient, guildId, userId: user.discordId })
      }

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

      const botResponse = await enqueuePlaylistTracks(botClient, guildId, {
        userId: user.discordId,
        tracks,
      }).catch((error) => {
        if (error.statusCode === 409 || error.status === 409 || error.code === 'user_not_in_voice') {
          error.statusCode = 409
          error.publicMessage = '先にVCに参加してください'
        }
        throw error
      })

      return reply.send({ ok: true, enqueuedCount: botResponse?.enqueuedCount ?? tracks.length })
    } catch (error) {
      return bindRouteError(reply, error)
    }
  })
}

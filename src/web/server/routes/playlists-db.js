import { nowUnix } from './route-utils.js'

export function serializePlaylistRow(row) {
  return {
    id: row.id,
    name: row.name,
    trackCount: row.track_count ?? 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export function serializeTrackRow(row) {
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

export function listPlaylists(db, userId) {
  const rows = db.prepare(`
    SELECT p.id, p.name, p.created_at, p.updated_at,
           (SELECT COUNT(*) FROM user_playlist_tracks t WHERE t.playlist_id = p.id) AS track_count
    FROM user_playlists p
    WHERE p.discord_user_id = ?
    ORDER BY p.updated_at DESC
  `).all(userId)
  return rows.map(serializePlaylistRow)
}

export function getOwnedPlaylist(db, userId, id) {
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

export function getPlaylistTracks(db, playlistId) {
  return db.prepare(`
    SELECT id, position, title, webpage_url, duration, thumbnail, video_id, channel
    FROM user_playlist_tracks
    WHERE playlist_id = ?
    ORDER BY position ASC
  `).all(playlistId)
}

export function createPlaylist(db, userId, name) {
  const now = nowUnix()
  const result = db.prepare(`
    INSERT INTO user_playlists (discord_user_id, name, created_at, updated_at)
    VALUES (?, ?, ?, ?)
  `).run(userId, name, now, now)
  return Number(result.lastInsertRowid)
}

export function touchPlaylist(db, id) {
  db.prepare('UPDATE user_playlists SET updated_at = ? WHERE id = ?').run(nowUnix(), id)
}

export function renamePlaylist(db, id, name) {
  db.prepare('UPDATE user_playlists SET name = ?, updated_at = ? WHERE id = ?').run(name, nowUnix(), id)
}

export function deletePlaylist(db, id) {
  db.prepare('DELETE FROM user_playlists WHERE id = ?').run(id)
}

function nextPosition(db, playlistId) {
  const row = db.prepare(
    'SELECT COALESCE(MAX(position), -1) AS maxPosition FROM user_playlist_tracks WHERE playlist_id = ?'
  ).get(playlistId)
  return row.maxPosition + 1
}

export function insertTrack(db, playlistId, track) {
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

export function deleteTrack(db, playlistId, trackId) {
  const result = db.prepare('DELETE FROM user_playlist_tracks WHERE id = ? AND playlist_id = ?').run(trackId, playlistId)
  if (result.changes > 0) touchPlaylist(db, playlistId)
  return result.changes > 0
}

export function moveTrack(db, playlistId, fromIndex, toIndex) {
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

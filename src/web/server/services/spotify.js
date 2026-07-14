import { getValidAccessToken } from '../../../db/tokenStore.js'

const SPOTIFY_API_BASE = 'https://api.spotify.com/v1'

async function spotifyFetch(path, { userId, fetchImpl = fetch } = {}) {
  const token = await getValidAccessToken(userId, 'spotify')
  const response = await fetchImpl(`${SPOTIFY_API_BASE}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  })

  if (!response.ok) {
    const body = await response.text().catch(() => '')
    throw new Error(`Spotify API ${response.status}: ${body || response.statusText}`)
  }

  return response.json()
}

async function collectPages(firstPath, options) {
  const items = []
  let nextPath = firstPath
  while (nextPath) {
    const page = await spotifyFetch(nextPath, options)
    items.push(...(page.items ?? []))
    nextPath = page.next ? new URL(page.next).pathname + new URL(page.next).search : null
  }
  return items
}

export async function listSpotifyPlaylists(userId, options = {}) {
  const playlists = await collectPages('/me/playlists?limit=50', { ...options, userId })
  return playlists.map((playlist) => ({
    id: playlist.id,
    name: playlist.name,
    trackCount: playlist.tracks?.total ?? 0,
    ownerName: playlist.owner?.display_name ?? null,
    externalUrl: playlist.external_urls?.spotify ?? null,
    thumbnail: playlist.images?.[0]?.url ?? null,
  }))
}

export async function listSpotifyPlaylistTracks(userId, playlistId, options = {}) {
  const encodedId = encodeURIComponent(playlistId)
  const fields = 'items(track(name,artists(name),duration_ms,external_urls)),next'
  const items = await collectPages(`/playlists/${encodedId}/tracks?limit=100&fields=${fields}`, { ...options, userId })
  return items
    .map((item) => item.track)
    .filter(Boolean)
    .map((track) => ({
      title: track.name,
      artist: track.artists?.map((artist) => artist.name).filter(Boolean).join(' '),
      artists: track.artists ?? [],
      duration: track.duration_ms ? Math.round(track.duration_ms / 1000) : null,
      sourceUrl: track.external_urls?.spotify ?? null,
    }))
}

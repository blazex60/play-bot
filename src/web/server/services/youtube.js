import { getValidAccessToken } from '../../../db/tokenStore.js'

const YOUTUBE_API_BASE = 'https://www.googleapis.com/youtube/v3'

async function youtubeFetch(path, { userId, fetchImpl = fetch } = {}) {
  const token = await getValidAccessToken(userId, 'youtube')
  const response = await fetchImpl(`${YOUTUBE_API_BASE}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  })

  if (!response.ok) {
    const body = await response.text().catch(() => '')
    throw new Error(`YouTube API ${response.status}: ${body || response.statusText}`)
  }

  return response.json()
}

async function collectPages(firstPath, options) {
  const items = []
  let pageToken = null
  do {
    const separator = firstPath.includes('?') ? '&' : '?'
    const path = pageToken ? `${firstPath}${separator}pageToken=${encodeURIComponent(pageToken)}` : firstPath
    const page = await youtubeFetch(path, options)
    items.push(...(page.items ?? []))
    pageToken = page.nextPageToken ?? null
  } while (pageToken)
  return items
}

export async function listYoutubePlaylists(userId, options = {}) {
  const playlists = await collectPages('/playlists?part=snippet,contentDetails&mine=true&maxResults=50', { ...options, userId })
  return playlists.map((playlist) => ({
    id: playlist.id,
    name: playlist.snippet?.title ?? 'Untitled playlist',
    trackCount: playlist.contentDetails?.itemCount ?? 0,
    ownerName: playlist.snippet?.channelTitle ?? null,
    externalUrl: `https://www.youtube.com/playlist?list=${playlist.id}`,
    thumbnail: playlist.snippet?.thumbnails?.high?.url ?? playlist.snippet?.thumbnails?.default?.url ?? null,
  }))
}

export async function listYoutubePlaylistTracks(userId, playlistId, options = {}) {
  const encodedId = encodeURIComponent(playlistId)
  const items = await collectPages(`/playlistItems?part=snippet,contentDetails&maxResults=50&playlistId=${encodedId}`, {
    ...options,
    userId,
  })
  return items
    .filter((item) => item.contentDetails?.videoId || item.snippet?.resourceId?.videoId)
    .map((item) => ({
      title: item.snippet?.title ?? 'Unknown',
      sourceUrl: `https://www.youtube.com/watch?v=${item.contentDetails?.videoId ?? item.snippet?.resourceId?.videoId}`,
      snippet: item.snippet,
      contentDetails: item.contentDetails,
    }))
}

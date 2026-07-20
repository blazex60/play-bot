import { createTrack } from '../../queue.js'

function pickThumbnail(entry) {
  if (entry?.thumbnail) return entry.thumbnail
  if (Array.isArray(entry?.thumbnails) && entry.thumbnails.length) {
    return entry.thumbnails[entry.thumbnails.length - 1].url ?? null
  }
  if (entry?.snippet?.thumbnails?.high?.url) return entry.snippet.thumbnails.high.url
  if (entry?.snippet?.thumbnails?.default?.url) return entry.snippet.thumbnails.default.url
  return null
}

function youtubeWatchUrl(entry) {
  const raw = entry?.webpage_url ?? entry?.webpageUrl ?? entry?.url
  if (raw && /^https?:\/\//.test(raw)) return raw

  const videoId = entry?.contentDetails?.videoId ?? entry?.snippet?.resourceId?.videoId ?? entry?.id?.videoId ?? entry?.id
  if (videoId) return `https://www.youtube.com/watch?v=${videoId}`
  return null
}

export function resolveYoutubeTrack(item, { requestedBy, requestedById = null } = {}) {
  const webpageUrl = youtubeWatchUrl(item)
  if (!webpageUrl) {
    return {
      status: 'failed',
      source: item,
      track: null,
      reason: 'missing_youtube_video_id',
    }
  }

  return {
    status: 'matched',
    source: item,
    track: createTrack({
      title: item.title ?? item.snippet?.title ?? 'Unknown',
      webpageUrl,
      duration: item.duration ?? null,
      requestedBy,
      requestedById,
      thumbnail: pickThumbnail(item),
      videoId: item.contentDetails?.videoId ?? item.snippet?.resourceId?.videoId ?? item.id?.videoId ?? item.id ?? null,
      channel: item.channel ?? item.snippet?.videoOwnerChannelTitle ?? item.snippet?.channelTitle ?? null,
    }),
  }
}

export async function resolveImportTracks({ service, tracks, requestedBy, requestedById = null }) {
  if (service === 'youtube') {
    return tracks.map((track) => resolveYoutubeTrack(track, { requestedBy, requestedById }))
  }

  throw new Error(`Unsupported import service: ${service}`)
}

export function toImportTrackRow(result, position) {
  return {
    position,
    source_title: result.source?.title ?? result.source?.name ?? result.source?.snippet?.title ?? 'Unknown',
    source_artist: result.source?.artist ?? result.source?.artists?.map((item) => item.name).filter(Boolean).join(', ') ?? null,
    source_url: result.source?.sourceUrl ?? result.source?.externalUrl ?? result.source?.webpageUrl ?? youtubeWatchUrl(result.source),
    matched_url: result.track?.webpageUrl ?? null,
    matched_title: result.track?.title ?? null,
    match_status: result.status === 'matched' ? 'matched' : 'failed',
  }
}

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildSpotifySearchQuery,
  matchSpotifyTrack,
  resolveImportTracks,
  resolveYoutubeTrack,
  toImportTrackRow,
} from './matching.js'

test('buildSpotifySearchQuery: title and artist become the YouTube query', () => {
  assert.equal(
    buildSpotifySearchQuery({ title: 'Song Title', artist: 'Artist Name' }),
    'Song Title Artist Name'
  )
})

test('matchSpotifyTrack: uses first YouTube result and returns createTrack shape', async () => {
  const calls = []
  const result = await matchSpotifyTrack(
    { title: 'Song Title', artist: 'Artist Name', sourceUrl: 'https://open.spotify.com/track/1' },
    {
      requestedBy: 'user-1',
      searchYoutube: async (query) => {
        calls.push(query)
        return [{
          id: 'youtube-id',
          title: 'Matched Video',
          duration: 123,
          thumbnail: 'https://img.example/thumb.jpg',
        }]
      },
    }
  )

  assert.deepEqual(calls, ['Song Title Artist Name'])
  assert.equal(result.status, 'matched')
  assert.deepEqual(result.track, {
    title: 'Matched Video',
    webpageUrl: 'https://www.youtube.com/watch?v=youtube-id',
    duration: 123,
    requestedBy: 'user-1',
    thumbnail: 'https://img.example/thumb.jpg',
  })
})

test('matchSpotifyTrack: no search results returns a failed result', async () => {
  const result = await matchSpotifyTrack(
    { title: 'Missing Song', artist: 'Unknown Artist' },
    { requestedBy: 'user-1', searchYoutube: async () => [] }
  )

  assert.equal(result.status, 'failed')
  assert.equal(result.track, null)
  assert.equal(result.reason, 'no_youtube_match')
})

test('resolveYoutubeTrack: playlist item resolves directly without search', () => {
  const result = resolveYoutubeTrack({
    snippet: {
      title: 'Playlist Video',
      resourceId: { videoId: 'video-1' },
      thumbnails: { default: { url: 'https://img.example/default.jpg' } },
    },
    contentDetails: { videoId: 'video-1' },
  }, { requestedBy: 'user-2' })

  assert.equal(result.status, 'matched')
  assert.deepEqual(result.track, {
    title: 'Playlist Video',
    webpageUrl: 'https://www.youtube.com/watch?v=video-1',
    duration: null,
    requestedBy: 'user-2',
    thumbnail: 'https://img.example/default.jpg',
  })
})

test('resolveImportTracks: handles YouTube playlist items as direct matches', async () => {
  const results = await resolveImportTracks({
    service: 'youtube',
    requestedBy: 'user-3',
    tracks: [{ title: 'Direct Video', contentDetails: { videoId: 'video-2' } }],
  })

  assert.equal(results.length, 1)
  assert.equal(results[0].track.webpageUrl, 'https://www.youtube.com/watch?v=video-2')
})

test('toImportTrackRow: creates DB row fields for matched and failed tracks', () => {
  const matched = toImportTrackRow({
    status: 'matched',
    source: { title: 'Source', artist: 'Artist', sourceUrl: 'https://source.example' },
    track: {
      title: 'Matched',
      webpageUrl: 'https://www.youtube.com/watch?v=matched',
      duration: 60,
      requestedBy: 'user-1',
      thumbnail: null,
    },
  }, 4)

  assert.deepEqual(matched, {
    position: 4,
    source_title: 'Source',
    source_artist: 'Artist',
    source_url: 'https://source.example',
    matched_url: 'https://www.youtube.com/watch?v=matched',
    matched_title: 'Matched',
    match_status: 'matched',
  })

  const failed = toImportTrackRow({
    status: 'failed',
    source: { title: 'Source' },
    track: null,
  }, 5)

  assert.equal(failed.match_status, 'failed')
  assert.equal(failed.matched_url, null)
})

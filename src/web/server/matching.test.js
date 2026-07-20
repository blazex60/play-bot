import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  resolveImportTracks,
  resolveYoutubeTrack,
  toImportTrackRow,
} from './matching.js'

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
    requestedById: null,
    thumbnail: 'https://img.example/default.jpg',
    videoId: 'video-1',
    channel: null,
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

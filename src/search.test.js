import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  YtdlpError,
  isPlaylistUrl,
  parseFirstJsonLine,
  parseJsonLines,
  mapEntryToTrack,
} from './search.js'

test('isPlaylistUrl: playlist URLs are detected', () => {
  assert.equal(isPlaylistUrl('https://youtube.com/playlist?list=PL123'), true)
  assert.equal(isPlaylistUrl('https://youtube.com/watch?v=abc&list=PL123'), true)
  assert.equal(isPlaylistUrl('https://youtube.com/watch?v=abc'), false)
})

test('parseJsonLines: parses newline-delimited JSON records', () => {
  assert.deepEqual(
    parseJsonLines('{"id":"a"}\n\n{"id":"b"}\n', 'test records'),
    [{ id: 'a' }, { id: 'b' }]
  )
})

test('parseFirstJsonLine: returns the first JSON record', () => {
  assert.deepEqual(
    parseFirstJsonLine('{"id":"first"}\n{"id":"second"}\n', 'test record'),
    { id: 'first' }
  )
})

test('parseJsonLines: invalid JSON throws YtdlpError with context', () => {
  assert.throws(
    () => parseJsonLines('{"id":"ok"}\nnot-json\n', 'test records'),
    err => err instanceof YtdlpError && /test records: invalid JSON on line 2/.test(err.message)
  )
})

test('mapEntryToTrack: derives watch URL from id when the entry has none', () => {
  const track = mapEntryToTrack(
    { id: 'abc123', title: 'A Song', duration: 120, channel: 'Some Channel' },
    { requestedBy: 'user', requestedById: 'discord-1' }
  )
  assert.equal(track.title, 'A Song')
  assert.equal(track.webpageUrl, 'https://www.youtube.com/watch?v=abc123')
  assert.equal(track.duration, 120)
  assert.equal(track.videoId, 'abc123')
  assert.equal(track.channel, 'Some Channel')
  assert.equal(track.requestedBy, 'user')
  assert.equal(track.requestedById, 'discord-1')
})

test('mapEntryToTrack: prefers an existing http(s) url/webpage_url over deriving one', () => {
  const track = mapEntryToTrack({ id: 'abc123', webpage_url: 'https://youtu.be/abc123' }, { requestedBy: 'user' })
  assert.equal(track.webpageUrl, 'https://youtu.be/abc123')
})

test('mapEntryToTrack: falls back to uploader when channel is absent, and defaults missing fields', () => {
  const track = mapEntryToTrack({ uploader: 'Some Uploader' }, { requestedBy: 'user' })
  assert.equal(track.channel, 'Some Uploader')
  assert.equal(track.title, 'Unknown')
  assert.equal(track.videoId, null)
  assert.equal(track.requestedById, null)
})

test('mapEntryToTrack: picks the last thumbnail when only a thumbnails array is present', () => {
  const track = mapEntryToTrack(
    { thumbnails: [{ url: 'https://example.com/small.jpg' }, { url: 'https://example.com/large.jpg' }] },
    { requestedBy: 'user' }
  )
  assert.equal(track.thumbnail, 'https://example.com/large.jpg')
})

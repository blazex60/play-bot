import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  YtdlpError,
  isPlaylistUrl,
  parseFirstJsonLine,
  parseJsonLines,
  mapEntryToTrack,
  spawnAsync,
  buildYtdlpArgs,
  ytdlpCookieArgs,
  YTDLP_EXTRACTOR_ARGS,
  YTDLP_AUDIO_FORMAT,
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

test('spawnAsync kills a hung process when timeoutMs elapses', async () => {
  const started = Date.now()
  await assert.rejects(
    () => spawnAsync('sleep', ['5'], { timeoutMs: 40 }),
    (err) => err instanceof YtdlpError && /timed out after 40ms/.test(err.message),
  )
  assert.ok(Date.now() - started < 1000)
})

test('buildYtdlpArgs: solves n-sig in Node and skips player clients that 403 googlevideo', () => {
  const args = buildYtdlpArgs('-f', YTDLP_AUDIO_FORMAT, '--no-playlist', '-o', '-', 'https://example.com/a')
  assert.equal(args[0], '--js-runtimes')
  assert.equal(args[1], 'node')
  assert.ok(args.includes('--no-cache-dir'))
  const extractorAt = args.indexOf('--extractor-args')
  assert.ok(extractorAt >= 0)
  assert.equal(args[extractorAt + 1], YTDLP_EXTRACTOR_ARGS)
  assert.match(YTDLP_EXTRACTOR_ARGS, /android_sdkless/)
  assert.match(YTDLP_EXTRACTOR_ARGS, /web_safari/)
  const formatAt = args.indexOf('-f')
  assert.ok(formatAt >= 0)
  assert.equal(args[formatAt + 1], YTDLP_AUDIO_FORMAT)
})

test('ytdlpCookieArgs: only passed when YTDLP_COOKIES_FILE is a non-empty path', () => {
  assert.deepEqual(ytdlpCookieArgs({}), [])
  assert.deepEqual(ytdlpCookieArgs({ YTDLP_COOKIES_FILE: '   ' }), [])
  assert.deepEqual(
    ytdlpCookieArgs({ YTDLP_COOKIES_FILE: '/app/data/youtube-cookies.txt' }),
    ['--cookies', '/app/data/youtube-cookies.txt'],
  )
})

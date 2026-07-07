import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  YtdlpError,
  isPlaylistUrl,
  parseFirstJsonLine,
  parseJsonLines,
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

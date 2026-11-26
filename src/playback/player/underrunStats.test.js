import { test } from 'node:test'
import assert from 'node:assert/strict'
import { UnderrunStats } from './underrunStats.js'

test('UnderrunStats: one episode per underrun run, summarized at most once per window', () => {
  let now = 0
  const stats = new UnderrunStats({ clock: () => now, flushEveryMs: 60_000 })
  stats.noteUnderrun(); now += 20; stats.noteUnderrun(); now += 20
  assert.equal(stats.noteCleared(), null, 'inside the first minute: tallied, not logged')
  now = 30_000
  stats.noteUnderrun(); now += 300
  assert.equal(stats.noteCleared(), null)
  now = 61_000
  stats.noteUnderrun(); now += 100
  assert.deepEqual(stats.noteCleared(), { episodes: 3, totalMs: 440, maxMs: 300, windowMs: 61_100 })
  now += 1000
  stats.noteUnderrun(); now += 50
  assert.equal(stats.noteCleared(), null, 'the tally restarts after a summary')
})

test('UnderrunStats: a clear without an underrun is ignored', () => {
  const stats = new UnderrunStats({ clock: () => 100_000, flushEveryMs: 0 })
  assert.equal(stats.noteCleared(), null)
})

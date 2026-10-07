import { test } from 'node:test'
import assert from 'node:assert/strict'
import { GuildQueue, createTrack, trackIdentity, LoopMode } from './queue.js'

test('createTrack: videoId/channel/requestedById default to null when omitted', () => {
  const track = createTrack({ title: 'A', webpageUrl: 'https://example.com/a', duration: 60, requestedBy: 'user' })
  assert.equal(track.videoId, null)
  assert.equal(track.channel, null)
  assert.equal(track.requestedById, null)
})

test('createTrack: videoId/channel/requestedById are carried through when provided', () => {
  const track = createTrack({
    title: 'A',
    webpageUrl: 'https://example.com/a',
    duration: 60,
    requestedBy: 'user',
    requestedById: 'discord-123',
    videoId: 'yt-abc',
    channel: 'Some Channel',
  })
  assert.equal(track.videoId, 'yt-abc')
  assert.equal(track.channel, 'Some Channel')
  assert.equal(track.requestedById, 'discord-123')
})

function makeQueueWithUpcoming(titles) {
  const queue = new GuildQueue()
  for (const title of titles) {
    queue.add(createTrack({ title, webpageUrl: `https://example.com/${title}`, duration: 60 }))
  }
  return queue
}

test('removeUpcoming: 空キューではno-op (false)', () => {
  const queue = new GuildQueue()
  assert.equal(queue.removeUpcoming(0), false)
})

test('removeUpcoming: upcomingが0件ではno-op (false)', () => {
  const queue = makeQueueWithUpcoming(['current'])
  assert.equal(queue.removeUpcoming(0), false)
})

test('removeUpcoming: 負数インデックスはno-op (false)', () => {
  const queue = makeQueueWithUpcoming(['current', 'A', 'B'])
  assert.equal(queue.removeUpcoming(-1), false)
})

test('removeUpcoming: upcoming().length以上のインデックスはno-op (false)', () => {
  const queue = makeQueueWithUpcoming(['current', 'A', 'B'])
  assert.equal(queue.removeUpcoming(2), false)
})

test('removeUpcoming: 削除後も現在再生中トラックは変化しない', () => {
  const queue = makeQueueWithUpcoming(['current', 'A', 'B', 'C'])
  const before = queue.current
  const removed = queue.removeUpcoming(1)
  assert.equal(removed, true)
  assert.equal(queue.current, before)
  assert.deepEqual(
    queue.upcoming().map((t) => t.title),
    ['A', 'C']
  )
})

test('moveUpcoming: 空キューではno-op (false)', () => {
  const queue = new GuildQueue()
  assert.equal(queue.moveUpcoming(0, 0), false)
})

test('moveUpcoming: 範囲外インデックス(負数)はno-op (false)', () => {
  const queue = makeQueueWithUpcoming(['current', 'A', 'B'])
  assert.equal(queue.moveUpcoming(-1, 0), false)
  assert.equal(queue.moveUpcoming(0, -1), false)
})

test('moveUpcoming: 範囲外インデックス(upcoming().length以上)はno-op (false)', () => {
  const queue = makeQueueWithUpcoming(['current', 'A', 'B'])
  assert.equal(queue.moveUpcoming(2, 0), false)
  assert.equal(queue.moveUpcoming(0, 2), false)
})

test('moveUpcoming: fromIndex === toIndexはno-op (false)', () => {
  const queue = makeQueueWithUpcoming(['current', 'A', 'B'])
  assert.equal(queue.moveUpcoming(0, 0), false)
})

test('moveUpcoming: 上へ移動で順序が入れ替わる', () => {
  const queue = makeQueueWithUpcoming(['current', 'A', 'B', 'C'])
  assert.equal(queue.moveUpcoming(1, 0), true)
  assert.deepEqual(
    queue.upcoming().map((t) => t.title),
    ['B', 'A', 'C']
  )
})

test('moveUpcoming: 下へ移動で順序が入れ替わる', () => {
  const queue = makeQueueWithUpcoming(['current', 'A', 'B', 'C'])
  assert.equal(queue.moveUpcoming(0, 1), true)
  assert.deepEqual(
    queue.upcoming().map((t) => t.title),
    ['B', 'A', 'C']
  )
})

test('moveUpcoming: 任意の位置への移動', () => {
  const queue = makeQueueWithUpcoming(['current', 'A', 'B', 'C', 'D'])
  assert.equal(queue.moveUpcoming(0, 2), true)
  assert.deepEqual(
    queue.upcoming().map((t) => t.title),
    ['B', 'C', 'A', 'D']
  )
})

test('moveUpcoming: upcomingの最後尾同士(先頭↔末尾)の入れ替え', () => {
  const queue = makeQueueWithUpcoming(['current', 'A', 'B', 'C'])
  assert.equal(queue.moveUpcoming(0, 2), true)
  assert.deepEqual(
    queue.upcoming().map((t) => t.title),
    ['B', 'C', 'A']
  )
})

test('moveUpcoming: 先頭への移動(toIndex=0)後next()で正しい曲が再生される', () => {
  const queue = makeQueueWithUpcoming(['current', 'A', 'B', 'C'])
  assert.equal(queue.moveUpcoming(2, 0), true)
  assert.deepEqual(
    queue.upcoming().map((t) => t.title),
    ['C', 'A', 'B']
  )
  const nextTrack = queue.next()
  assert.equal(nextTrack.title, 'C')
  assert.equal(queue.current.title, 'C')
})

test('reorderUpcoming: applies a full permutation to upcoming tracks', () => {
  const queue = makeQueueWithUpcoming(['current', 'A', 'B', 'C'])
  assert.equal(queue.reorderUpcoming([2, 0, 1]), true)
  assert.deepEqual(queue.upcoming().map((t) => t.title), ['C', 'A', 'B'])
})

test('reorderUpcoming: rejects invalid permutations', () => {
  const queue = makeQueueWithUpcoming(['current', 'A', 'B'])
  assert.equal(queue.reorderUpcoming([0, 0]), false)
  assert.equal(queue.reorderUpcoming([0]), false)
})

test('reorderUpcomingIfUnchanged: rejects when snapshot no longer matches', () => {
  const queue = makeQueueWithUpcoming(['current', 'A', 'B', 'C'])
  const snapshot = queue.upcoming().map(trackIdentity)
  queue.moveUpcoming(0, 2)
  assert.equal(queue.reorderUpcomingIfUnchanged([2, 0, 1], snapshot), false)
  assert.deepEqual(queue.upcoming().map((t) => t.title), ['B', 'C', 'A'])
})

test('reorderUpcomingIfUnchanged: applies when snapshot still matches', () => {
  const queue = makeQueueWithUpcoming(['current', 'A', 'B', 'C'])
  const snapshot = queue.upcoming().map(trackIdentity)
  assert.equal(queue.reorderUpcomingIfUnchanged([2, 0, 1], snapshot), true)
  assert.deepEqual(queue.upcoming().map((t) => t.title), ['C', 'A', 'B'])
})

// --- wrappedUpcoming (Codex review, PR #44) ---------------------------------

test('wrappedUpcoming: same as upcoming() when there is no loop or the window is already satisfied', () => {
  const queue = makeQueueWithUpcoming(['current', 'A', 'B', 'C', 'D'])
  assert.equal(queue.loopMode, LoopMode.OFF)
  assert.deepEqual(queue.wrappedUpcoming(3).map((t) => t.title), ['A', 'B', 'C'])
})

test('wrappedUpcoming: QUEUE loop mode wraps to the front once upcoming() runs out, mirroring next()', () => {
  const queue = makeQueueWithUpcoming(['A', 'B', 'C'])
  queue.loopMode = LoopMode.QUEUE
  // On the last track (C): upcoming() is [] but next() really does wrap to A.
  queue.next()
  queue.next()
  assert.equal(queue.current.title, 'C')
  assert.deepEqual(queue.wrappedUpcoming(3).map((t) => t.title), ['A', 'B'])

  // On the penultimate track (B): upcoming() is [C], next+1 should wrap to A.
  const queue2 = makeQueueWithUpcoming(['A', 'B', 'C'])
  queue2.loopMode = LoopMode.QUEUE
  queue2.next()
  assert.equal(queue2.current.title, 'B')
  assert.deepEqual(queue2.wrappedUpcoming(3).map((t) => t.title), ['C', 'A'])
})

test('wrappedUpcoming: never re-includes the current track (stops before a full lap)', () => {
  const queue = makeQueueWithUpcoming(['A', 'B'])
  queue.loopMode = LoopMode.QUEUE
  queue.next()
  assert.equal(queue.current.title, 'B')
  // Only one other track exists (A); must not loop back around to B itself.
  assert.deepEqual(queue.wrappedUpcoming(3).map((t) => t.title), ['A'])
})

test('wrappedUpcoming: a single-track QUEUE-loop queue returns [] just like upcoming() does', () => {
  const queue = makeQueueWithUpcoming(['A'])
  queue.loopMode = LoopMode.QUEUE
  assert.deepEqual(queue.wrappedUpcoming(3), [])
})

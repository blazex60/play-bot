import { test } from 'node:test'
import assert from 'node:assert/strict'
import { GuildQueue, createTrack } from './queue.js'

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

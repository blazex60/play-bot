import { test } from 'node:test'
import assert from 'node:assert/strict'
import { GuildQueue, LoopMode, createTrack } from '../queue.js'
import { isStemJobRelevantFor, stemRelevantTracks } from './stemRelevance.js'

const t = (id) => createTrack({ title: id, webpageUrl: `https://example.com/${id}`, duration: 200, videoId: id })

function queueOf(ids, { advance = 0, loopMode = LoopMode.OFF } = {}) {
  const q = new GuildQueue()
  for (const id of ids) q.add(t(id))
  q.loopMode = loopMode
  for (let i = 0; i < advance; i += 1) q.next()
  return q
}

test('stemRelevantTracks: current + next two', () => {
  const q = queueOf(['a', 'b', 'c', 'd'])
  assert.deepEqual(stemRelevantTracks(q).map((x) => x.videoId), ['a', 'b', 'c'])
  assert.equal(isStemJobRelevantFor(q, 'd'), false)
})

test('stemRelevantTracks: QUEUE loop wraps to the front near the end', () => {
  const q = queueOf(['a', 'b', 'c', 'd'], { advance: 3, loopMode: LoopMode.QUEUE })
  assert.equal(q.current.videoId, 'd')
  assert.deepEqual(stemRelevantTracks(q).map((x) => x.videoId), ['d', 'a', 'b'])
  assert.equal(isStemJobRelevantFor(q, 'a'), true, 'the wrapped next track is still worth separating')
})

test('stemRelevantTracks: without QUEUE loop nothing wraps', () => {
  const q = queueOf(['a', 'b', 'c', 'd'], { advance: 3 })
  assert.deepEqual(stemRelevantTracks(q).map((x) => x.videoId), ['d'])
})

test('stemRelevantTracks: TRACK loop only keeps the current track', () => {
  const q = queueOf(['a', 'b', 'c'], { loopMode: LoopMode.TRACK })
  assert.deepEqual(stemRelevantTracks(q).map((x) => x.videoId), ['a'])
  assert.equal(isStemJobRelevantFor(q, null), false)
})

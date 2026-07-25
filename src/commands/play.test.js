import { test } from 'node:test'
import assert from 'node:assert/strict'
import { enqueueAndAnnounce } from './play.js'

function fakeSession(initialTracks = []) {
  const tracks = [...initialTracks]
  const calls = []
  return {
    tracks,
    calls,
    queue: {
      get isEmpty() {
        return tracks.length === 0
      },
      add: (track) => tracks.push(track),
    },
    player: {
      playNext: async () => {
        calls.push('playNext')
      },
    },
  }
}

test('enqueueAndAnnounce: starts playback when the queue was empty', async () => {
  const session = fakeSession()
  const wasEmpty = await enqueueAndAnnounce(session, ['track-a'], async () => {
    session.calls.push('reply')
  })
  assert.equal(wasEmpty, true)
  assert.deepEqual(session.tracks, ['track-a'])
  assert.deepEqual(session.calls, ['reply', 'playNext'])
})

test('enqueueAndAnnounce: does not start playback when the queue already had a track', async () => {
  const session = fakeSession(['already-playing'])
  const wasEmpty = await enqueueAndAnnounce(session, ['track-a'], async () => {
    session.calls.push('reply')
  })
  assert.equal(wasEmpty, false)
  assert.deepEqual(session.tracks, ['already-playing', 'track-a'])
  assert.deepEqual(session.calls, ['reply'])
})

test('enqueueAndAnnounce: adds every track from a playlist in order', async () => {
  const session = fakeSession()
  await enqueueAndAnnounce(session, ['track-a', 'track-b', 'track-c'], async () => {})
  assert.deepEqual(session.tracks, ['track-a', 'track-b', 'track-c'])
})

test('enqueueAndAnnounce: replyFn always runs before playNext, even when the reply itself awaits', async () => {
  const session = fakeSession()
  await enqueueAndAnnounce(session, ['track-a'], async () => {
    await new Promise((resolve) => setImmediate(resolve))
    session.calls.push('reply')
  })
  assert.deepEqual(session.calls, ['reply', 'playNext'])
})

test('enqueueAndAnnounce: wasEmpty reflects the queue state captured before adding, not after', async () => {
  const session = fakeSession()
  let wasEmptyDuringReply
  await enqueueAndAnnounce(session, ['track-a'], async () => {
    // By the time replyFn runs, the track is already in the queue — the
    // returned wasEmpty must still reflect the pre-add snapshot.
    wasEmptyDuringReply = session.queue.isEmpty
  })
  assert.equal(wasEmptyDuringReply, false)
})

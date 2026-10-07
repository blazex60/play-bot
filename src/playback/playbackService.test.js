import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PlaybackService } from './playbackService.js'

function fakeSession(initialTracks = []) {
  const tracks = [...initialTracks]
  const calls = []
  const session = {
    tracks,
    calls,
    queue: {
      get isEmpty() {
        return tracks.length === 0
      },
      get current() {
        return tracks[0] ?? null
      },
      loopMode: 'off',
      add: (track) => tracks.push(track),
      upcoming: () => tracks.slice(1),
      shuffle: () => {
        calls.push('shuffle')
      },
      cycleLoop: () => {
        calls.push('cycleLoop')
        return 'track'
      },
      removeUpcoming: (i) => {
        calls.push(`removeUpcoming:${i}`)
        return true
      },
      moveUpcoming: (from, to) => {
        calls.push(`moveUpcoming:${from}->${to}`)
        return true
      },
      reorderUpcomingIfUnchanged: (order, snapshotIds) => {
        calls.push(`reorder:${order.join(',')}`)
        return true
      },
    },
    player: {
      status: 'playing',
      trackPositionSec: 12.5,
      playNext: async () => {
        calls.push('playNext')
      },
      pause: () => {
        calls.push('pause')
        return true
      },
      resume: () => {
        calls.push('resume')
        return true
      },
      skip: async () => {
        calls.push('skip')
      },
      stop: async () => {
        calls.push('stop')
      },
      seekTo: async (target) => {
        calls.push(`seekTo:${target}`)
        return target
      },
    },
  }
  return session
}

function serviceFor(session, extra = {}) {
  return new PlaybackService({ getSession: () => session, ...extra })
}

// --- enqueue (ported from commands/play.test.js's enqueueAndAnnounce suite) ---

test('enqueue: starts playback when the queue was empty', async () => {
  const session = fakeSession()
  const { wasEmpty, started } = await serviceFor(session).enqueue('g', ['track-a'], {
    onEnqueued: () => {
      session.calls.push('reply')
    },
  })
  assert.equal(wasEmpty, true)
  assert.equal(started, true)
  assert.deepEqual(session.tracks, ['track-a'])
  assert.deepEqual(session.calls, ['reply', 'playNext'])
})

test('enqueue: does not start playback when the queue already had a track', async () => {
  const session = fakeSession(['already-playing'])
  const { wasEmpty, started } = await serviceFor(session).enqueue('g', ['track-a'], {
    onEnqueued: () => {
      session.calls.push('reply')
    },
  })
  assert.equal(wasEmpty, false)
  assert.equal(started, false)
  assert.deepEqual(session.tracks, ['already-playing', 'track-a'])
  assert.deepEqual(session.calls, ['reply'])
})

test('enqueue: adds every track from a playlist in order', async () => {
  const session = fakeSession()
  await serviceFor(session).enqueue('g', ['track-a', 'track-b', 'track-c'])
  assert.deepEqual(session.tracks, ['track-a', 'track-b', 'track-c'])
})

test('enqueue: onEnqueued always runs before playNext, even when it awaits', async () => {
  const session = fakeSession()
  await serviceFor(session).enqueue('g', ['track-a'], {
    onEnqueued: async () => {
      await new Promise((resolve) => setImmediate(resolve))
      session.calls.push('reply')
    },
  })
  assert.deepEqual(session.calls, ['reply', 'playNext'])
})

test('enqueue: wasEmpty reflects the queue state captured before adding, not after', async () => {
  const session = fakeSession()
  let wasEmptyDuringHook
  await serviceFor(session).enqueue('g', ['track-a'], {
    onEnqueued: () => {
      // By the time the hook runs, the track is already in the queue — the
      // reported wasEmpty must still reflect the pre-add snapshot.
      wasEmptyDuringHook = session.queue.isEmpty
    },
  })
  assert.equal(wasEmptyDuringHook, false)
})

test('enqueue: awaitStart=false fires playNext without awaiting it', async () => {
  const session = fakeSession()
  const { wasEmpty, started } = await serviceFor(session).enqueue('g', ['track-a'], { awaitStart: false })
  assert.equal(wasEmpty, true)
  assert.equal(started, true)
  // playNext was invoked (its async body runs detached — flush a turn to see it)
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(session.calls, ['playNext'])
})

test('enqueue: returns null when the guild has no session', async () => {
  const result = await serviceFor(null).enqueue('g', ['track-a'])
  assert.equal(result, null)
})

// --- transport controls ---

test('pause/resume delegate to the player and null out without a session', () => {
  const session = fakeSession(['t'])
  const playback = serviceFor(session)
  assert.equal(playback.pause('g'), true)
  assert.equal(playback.resume('g'), true)
  assert.deepEqual(session.calls, ['pause', 'resume'])
  const empty = serviceFor(null)
  assert.equal(empty.pause('g'), null)
  assert.equal(empty.resume('g'), null)
})

test('skip/stop delegate to the player and return false without a session', async () => {
  const session = fakeSession(['t'])
  const playback = serviceFor(session)
  assert.equal(await playback.skip('g'), true)
  assert.equal(await playback.stop('g'), true)
  assert.deepEqual(session.calls, ['skip', 'stop'])
  const empty = serviceFor(null)
  assert.equal(await empty.skip('g'), false)
  assert.equal(await empty.stop('g'), false)
})

test('stop: invokes the onStop hook after player.stop()', async () => {
  const session = fakeSession(['t'])
  const order = []
  const playback = serviceFor(session, {
    onStop: (guildId) => {
      order.push(`onStop:${guildId}:${session.calls.join(',')}`)
    },
  })
  await playback.stop('g')
  assert.deepEqual(order, ['onStop:g:stop'])
})

test('seekTo delegates and distinguishes no-session from seek-failure', async () => {
  const session = fakeSession(['t'])
  const playback = serviceFor(session)
  assert.equal(await playback.seekTo('g', 42), 42)
  session.player.seekTo = async () => false
  assert.equal(await playback.seekTo('g', 10), false)
  assert.equal(await serviceFor(null).seekTo('g', 10), null)
})

// --- queue operations ---

test('queue operations delegate and null out without a session', () => {
  const session = fakeSession(['a', 'b', 'c'])
  const playback = serviceFor(session)
  assert.equal(playback.shuffle('g'), true)
  assert.equal(playback.cycleLoop('g'), 'track')
  assert.equal(playback.removeUpcoming('g', 1), true)
  assert.equal(playback.moveUpcoming('g', 0, 2), true)
  assert.equal(playback.reorderUpcomingIfUnchanged('g', [1, 0], ['a', 'b']), true)
  assert.deepEqual(session.calls, [
    'shuffle',
    'cycleLoop',
    'removeUpcoming:1',
    'moveUpcoming:0->2',
    'reorder:1,0',
  ])
  const empty = serviceFor(null)
  assert.equal(empty.shuffle('g'), false)
  assert.equal(empty.cycleLoop('g'), null)
  assert.equal(empty.removeUpcoming('g', 0), false)
  assert.equal(empty.moveUpcoming('g', 0, 1), false)
  assert.equal(empty.reorderUpcomingIfUnchanged('g', [], []), false)
})

// --- state snapshot ---

test('getState returns a plain snapshot without live internals', () => {
  const session = fakeSession(['current-t', 'next-t'])
  const state = serviceFor(session).getState('g')
  assert.equal(state.active, true)
  assert.equal(state.current, 'current-t')
  assert.deepEqual(state.upcoming, ['next-t'])
  assert.equal(state.isEmpty, false)
  assert.equal(state.loopMode, 'off')
  assert.equal(state.status, 'playing')
  assert.equal(state.positionSec, 12.5)
  // Encapsulation: the snapshot exposes no live player/queue references.
  assert.equal(state.player, undefined)
  assert.equal(state.queue, undefined)
  assert.equal(state.session, undefined)
  assert.equal(state.connection, undefined)
})

test('getState reports inactive for a missing session', () => {
  const state = serviceFor(null).getState('g')
  assert.deepEqual(state, { active: false, isEmpty: true })
})

test('queueIsEmpty / hasSession reflect session presence and queue state', () => {
  const session = fakeSession(['t'])
  const playback = serviceFor(session)
  assert.equal(playback.hasSession('g'), true)
  assert.equal(playback.queueIsEmpty('g'), false)
  const empty = serviceFor(null)
  assert.equal(empty.hasSession('g'), false)
  assert.equal(empty.queueIsEmpty('g'), true)
})

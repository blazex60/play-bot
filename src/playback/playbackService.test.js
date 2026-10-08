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

// --- enqueue async-window guards ---
// onEnqueued is an arbitrary async window (callers post Discord replies in
// it): /stop can clear the queue, /leave can destroy or replace the session,
// and a rival enqueue can re-fill the queue in the meantime. These tests
// simulate each of those by mutating the fake session/map mid-await.

function mapBackedService(map) {
  return new PlaybackService({ getSession: (guildId) => map.get(guildId) })
}

test('enqueue: a stop-clear during the onEnqueued await does not start playback', async () => {
  const session = fakeSession()
  const { wasEmpty, started } = await serviceFor(session).enqueue('g', ['track-a'], {
    onEnqueued: async () => {
      // /stop: player.stop() calls queue.clear() — the session stays live
      // but our just-added track is gone.
      session.tracks.length = 0
      session.calls.push('stop-clear')
    },
  })
  assert.equal(wasEmpty, true)
  assert.equal(started, false)
  assert.deepEqual(session.tracks, [])
  assert.deepEqual(session.calls, ['stop-clear']) // playNext never called
})

test('enqueue: an in-flight enqueue cannot revive playback after playback.stop()', async () => {
  const session = fakeSession()
  // Real GuildPlayer.stop() clears the queue — mirror that here.
  session.player.stop = async () => {
    session.calls.push('stop')
    session.tracks.length = 0
  }
  const playback = serviceFor(session)
  let release
  const pending = playback.enqueue('g', ['track-a'], {
    onEnqueued: () => new Promise((resolve) => { release = resolve }),
  })
  await playback.stop('g')
  release()
  const { wasEmpty, started } = await pending
  assert.equal(wasEmpty, true)
  assert.equal(started, false)
  assert.deepEqual(session.calls, ['stop']) // no playNext after stop
})

test('enqueue: a session swap during the onEnqueued await leaves the stale and new sessions alone', async () => {
  const staleSession = fakeSession()
  const newSession = fakeSession()
  const map = new Map([['g', staleSession]])
  const playback = mapBackedService(map)
  const result = await playback.enqueue('g', ['track-a'], {
    onEnqueued: async () => {
      // /leave + immediate rejoin: the map now holds a different session.
      map.delete('g')
      map.set('g', newSession)
    },
  })
  assert.deepEqual(result, { wasEmpty: true, started: false })
  // The stale session got the track (added before the swap) but its player
  // is never started again — playback must not revive post-leave.
  assert.deepEqual(staleSession.tracks, ['track-a'])
  assert.deepEqual(staleSession.calls, [])
  // The replacement session is untouched by the stale enqueue.
  assert.deepEqual(newSession.tracks, [])
  assert.deepEqual(newSession.calls, [])
})

test('enqueue: session destruction during the onEnqueued await does not start playback', async () => {
  const session = fakeSession()
  const map = new Map([['g', session]])
  const playback = mapBackedService(map)
  const result = await playback.enqueue('g', ['track-a'], {
    onEnqueued: async () => {
      map.delete('g')
    },
  })
  assert.deepEqual(result, { wasEmpty: true, started: false })
  assert.deepEqual(session.tracks, ['track-a'])
  assert.deepEqual(session.calls, []) // playNext never called on the dead session
})

test('enqueue: a stop-clear between two enqueues yields exactly one playNext', async () => {
  const session = fakeSession()
  const map = new Map([['g', session]])
  const playback = mapBackedService(map)

  let releaseA
  const aDone = playback.enqueue('g', ['track-a'], {
    onEnqueued: () => new Promise((resolve) => { releaseA = resolve }),
  })
  // A's adds run synchronously before its onEnqueued await suspends.
  await Promise.resolve()
  // /stop clears A's track while A is still awaiting its reply.
  session.tracks.length = 0
  // Rival enqueue B sees the now-empty queue and gets to start playback.
  const bResult = await playback.enqueue('g', ['track-b'])
  releaseA()
  const aResult = await aDone

  assert.equal(bResult.started, true)
  assert.equal(aResult.started, false)
  // Exactly one start total — A must not double-start B's track.
  assert.deepEqual(session.calls, ['playNext'])
  assert.deepEqual(session.tracks, ['track-b'])
})

test('enqueue: expectedSession blocks a stale continuation from touching the replacement session', async () => {
  const staleSession = fakeSession()
  const newSession = fakeSession()
  const map = new Map([['g', newSession]]) // rejoin already swapped the entry
  const playback = mapBackedService(map)
  const result = await playback.enqueue('g', ['track-a'], { expectedSession: staleSession })
  assert.deepEqual(result, { wasEmpty: false, started: false })
  assert.deepEqual(newSession.tracks, [])
  assert.deepEqual(newSession.calls, [])
  assert.deepEqual(staleSession.tracks, [])
})

test('enqueue: expectedSession aborts after the onEnqueued await when the session was swapped', async () => {
  const staleSession = fakeSession()
  const newSession = fakeSession()
  const map = new Map([['g', staleSession]])
  const playback = mapBackedService(map)
  const { wasEmpty, started } = await playback.enqueue('g', ['track-a'], {
    expectedSession: staleSession,
    onEnqueued: async () => {
      map.set('g', newSession)
    },
  })
  assert.equal(wasEmpty, true)
  assert.equal(started, false)
  assert.deepEqual(newSession.tracks, [])
  assert.deepEqual(newSession.calls, [])
  assert.deepEqual(staleSession.calls, [])
})

test('enqueue: expectedSession proceeds normally while it is still the live session', async () => {
  const session = fakeSession()
  const map = new Map([['g', session]])
  const { wasEmpty, started } = await mapBackedService(map).enqueue('g', ['track-a'], {
    expectedSession: session,
  })
  assert.equal(wasEmpty, true)
  assert.equal(started, true)
  assert.deepEqual(session.calls, ['playNext'])
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

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  claimAutoplayContinuation,
  hasAutoplayContinuationBeenUsed,
  releaseAutoplayContinuation,
  recordPlayedVideoId,
  playbackFor,
  MAX_SESSION_HISTORY,
} from './sessions.js'

test('sessions: autoplay continuation claim is scoped to one session object', () => {
  const session = { autoplayContinuationUsed: false }
  const nextSession = { autoplayContinuationUsed: false }

  assert.equal(hasAutoplayContinuationBeenUsed(session), false)
  assert.equal(claimAutoplayContinuation(session), true)

  assert.equal(hasAutoplayContinuationBeenUsed(session), true)
  assert.equal(hasAutoplayContinuationBeenUsed(nextSession), false)
})

// This is a per-round re-entrancy lock, not a once-per-session-lifetime cap:
// handleQueueExhausted releases it once a round's planning/posting settles
// (success or failure) so the next queue-exhaustion event can claim it again,
// letting auto/recommend mode keep continuing for as long as the session
// (the bot's VC connection) itself lives.
test('sessions: autoplay continuation claim is atomic until released', () => {
  const session = { autoplayContinuationUsed: false }

  assert.equal(claimAutoplayContinuation(session), true)
  assert.equal(claimAutoplayContinuation(session), false)

  releaseAutoplayContinuation(session)

  assert.equal(hasAutoplayContinuationBeenUsed(session), false)
  assert.equal(claimAutoplayContinuation(session), true)
})

test('recordPlayedVideoId: appends videoIds and evicts the oldest past MAX_SESSION_HISTORY (FIFO)', () => {
  const session = { recentPlayedVideoIds: [] }

  for (let i = 0; i < MAX_SESSION_HISTORY; i++) {
    recordPlayedVideoId(session, `vid-${i}`)
  }
  assert.equal(session.recentPlayedVideoIds.length, MAX_SESSION_HISTORY)
  assert.equal(session.recentPlayedVideoIds[0], 'vid-0')

  // The 101st entry should push out the oldest (vid-0), not grow past the cap.
  recordPlayedVideoId(session, `vid-${MAX_SESSION_HISTORY}`)
  assert.equal(session.recentPlayedVideoIds.length, MAX_SESSION_HISTORY)
  assert.equal(session.recentPlayedVideoIds[0], 'vid-1')
  assert.equal(session.recentPlayedVideoIds.at(-1), `vid-${MAX_SESSION_HISTORY}`)
})

test('recordPlayedVideoId: ignores calls with no videoId', () => {
  const session = { recentPlayedVideoIds: ['vid-existing'] }

  recordPlayedVideoId(session, null)
  recordPlayedVideoId(session, undefined)

  assert.deepEqual(session.recentPlayedVideoIds, ['vid-existing'])
})

// getOrCreateSession itself (which owns the actual reuse-vs-recreate
// decision) is not exercised here since it drives a real joinVoiceChannel/
// entersState connection — see other sessions tests in this file for why
// that flow isn't unit-tested directly. What's verified here is the piece
// this feature actually adds: an existing session's history array is a
// stable reference that recordPlayedVideoId mutates in place (so reusing a
// session preserves it), while a freshly built session literal always starts
// from recentPlayedVideoIds: [] (see getOrCreateSession in sessions.js).
test('recordPlayedVideoId: mutates the session\'s existing array in place, so a reused session keeps its history', () => {
  const session = { recentPlayedVideoIds: ['vid-old'] }
  const sameArrayRef = session.recentPlayedVideoIds

  recordPlayedVideoId(session, 'vid-new')

  assert.equal(session.recentPlayedVideoIds, sameArrayRef)
  assert.deepEqual(session.recentPlayedVideoIds, ['vid-old', 'vid-new'])
})

// playbackFor wiring: playback.stop()'s hooks invalidate the session being
// stopped — at stop START (planToken + pending recommendations), before the
// async teardown finishes — and must never land on a replacement session
// created by a leave+rejoin inside the stop window.
test('playbackFor: stop invalidates the stopped session at stop start — never the replacement', async () => {
  const map = new Map()
  const playback = playbackFor(map)
  const cancelled = []
  let release
  const sessionA = {
    planToken: 0,
    recommendHooks: { cancelRecommendations: (guildId) => cancelled.push(`A:${guildId}`) },
    player: { stop: async () => { await new Promise((resolve) => { release = resolve }) } },
    queue: { isEmpty: false },
  }
  map.set('g', sessionA)

  const stopping = playback.stop('g')
  // Invalidation lands the moment stop begins, while its teardown is still
  // gated on `release` — an in-flight recommend plan resolving in this
  // window already sees a dead planToken.
  assert.equal(sessionA.planToken, 1)
  assert.deepEqual(cancelled, ['A:g'])

  // leave + rejoin mid-stop: the map now holds a different session.
  const sessionB = {
    planToken: 0,
    recommendHooks: { cancelRecommendations: (guildId) => cancelled.push(`B:${guildId}`) },
  }
  map.set('g', sessionB)
  release()
  await stopping

  assert.equal(sessionB.planToken, 0)
  assert.deepEqual(cancelled, ['A:g'])
})

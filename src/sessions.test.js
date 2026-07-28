import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  claimAutoplayContinuation,
  hasAutoplayContinuationBeenUsed,
  releaseAutoplayContinuation,
  recordPlayedVideoId,
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

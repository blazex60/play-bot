import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  claimAutoplayContinuation,
  hasAutoplayContinuationBeenUsed,
  releaseAutoplayContinuation,
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

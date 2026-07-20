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

test('sessions: autoplay continuation claim is atomic until released', () => {
  const session = { autoplayContinuationUsed: false }

  assert.equal(claimAutoplayContinuation(session), true)
  assert.equal(claimAutoplayContinuation(session), false)

  releaseAutoplayContinuation(session)

  assert.equal(hasAutoplayContinuationBeenUsed(session), false)
  assert.equal(claimAutoplayContinuation(session), true)
})

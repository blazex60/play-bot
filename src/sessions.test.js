import { test } from 'node:test'
import assert from 'node:assert/strict'
import { hasAutoplayContinuationBeenUsed, markAutoplayContinuationUsed } from './sessions.js'

test('sessions: autoplay continuation marker is scoped to one session object', () => {
  const session = { autoplayContinuationUsed: false }
  const nextSession = { autoplayContinuationUsed: false }

  assert.equal(hasAutoplayContinuationBeenUsed(session), false)

  markAutoplayContinuationUsed(session)

  assert.equal(hasAutoplayContinuationBeenUsed(session), true)
  assert.equal(hasAutoplayContinuationBeenUsed(nextSession), false)
})

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  sessionVoiceChannelId,
  sessionVoiceGuildId,
  sessionConnectionStatus,
  sessionPlanToken,
  isSessionStale,
} from './sessionAccessors.js'

function makeSession({ channelId = 'vc-1', guildId = 'g1', status = 'ready', planToken = 0 } = {}) {
  return {
    connection: { joinConfig: { channelId, guildId }, state: { status } },
    planToken,
  }
}

test('sessionVoiceChannelId returns the joinConfig channelId', () => {
  assert.equal(sessionVoiceChannelId(makeSession({ channelId: 'vc-9' })), 'vc-9')
  assert.equal(sessionVoiceChannelId(null), null)
  assert.equal(sessionVoiceChannelId({ connection: {} }), null)
  // Local CLI sessions (LocalVoiceConnection) have no joinConfig.
  assert.equal(sessionVoiceChannelId({ connection: { state: { status: 'ready' } } }), null)
})

test('sessionVoiceGuildId returns the joinConfig guildId', () => {
  assert.equal(sessionVoiceGuildId(makeSession({ guildId: 'g7' })), 'g7')
  assert.equal(sessionVoiceGuildId(null), null)
})

test('sessionConnectionStatus returns the connection state status', () => {
  assert.equal(sessionConnectionStatus(makeSession({ status: 'destroyed' })), 'destroyed')
  assert.equal(sessionConnectionStatus({ connection: { state: { status: 'ready' } } }), 'ready')
  assert.equal(sessionConnectionStatus(null), null)
})

test('sessionPlanToken returns the plan generation token', () => {
  assert.equal(sessionPlanToken(makeSession({ planToken: 3 })), 3)
  assert.equal(sessionPlanToken(null), null)
})

test('isSessionStale is false while the session entry and token are unchanged', () => {
  const session = makeSession({ planToken: 2 })
  const sessions = new Map([['g1', session]])
  assert.equal(isSessionStale(sessions, 'g1', session, 2), false)
})

test('isSessionStale is true once the session is replaced or the token bumps', () => {
  const session = makeSession({ planToken: 0 })
  const sessions = new Map([['g1', session]])

  // /stop bumps the plan token on the same session object.
  session.planToken += 1
  assert.equal(isSessionStale(sessions, 'g1', session, 0), true)

  // A disconnect + rejoin swaps the map entry for a new object.
  const fresh = makeSession({ planToken: 0 })
  sessions.set('g1', fresh)
  assert.equal(isSessionStale(sessions, 'g1', session, 0), true)
  assert.equal(isSessionStale(sessions, 'g1', fresh, 0), false)

  // The session was removed entirely (/leave).
  sessions.delete('g1')
  assert.equal(isSessionStale(sessions, 'g1', fresh, 0), true)
})

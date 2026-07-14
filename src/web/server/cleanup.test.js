import assert from 'node:assert/strict'
import { test } from 'node:test'
import { sweepExpiredRows } from './cleanup.js'
import { createMemoryDb } from './testSupport.js'

test('sweepExpiredRows deletes expired OAuth states and web sessions only', (t) => {
  const db = createMemoryDb()
  t.after(() => db.close())
  const now = 1_000_000

  db.prepare(`
    INSERT INTO discord_users (discord_id, username, created_at, last_seen_at)
    VALUES (?, ?, ?, ?)
  `).run('u123', 'Lemitsu', now, now)
  db.prepare(`
    INSERT INTO oauth_states (state, discord_user_id, service, code_verifier, redirect_after, created_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run('expired-state', 'u123', 'spotify', null, '/', now - 20_000, now - 1)
  db.prepare(`
    INSERT INTO oauth_states (state, discord_user_id, service, code_verifier, redirect_after, created_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run('fresh-state', 'u123', 'spotify', null, '/', now, now + 60_000)
  db.prepare(`
    INSERT INTO web_sessions (session_id, discord_user_id, created_at, expires_at)
    VALUES (?, ?, ?, ?)
  `).run('expired-session', 'u123', now - 20_000, now - 1)
  db.prepare(`
    INSERT INTO web_sessions (session_id, discord_user_id, created_at, expires_at)
    VALUES (?, ?, ?, ?)
  `).run('fresh-session', 'u123', now, now + 60_000)

  assert.deepEqual(sweepExpiredRows({ db, now }), {
    oauthStates: 1,
    webSessions: 1,
  })
  assert.deepEqual(
    db.prepare('SELECT state FROM oauth_states ORDER BY state').all(),
    [{ state: 'fresh-state' }]
  )
  assert.deepEqual(
    db.prepare('SELECT session_id FROM web_sessions ORDER BY session_id').all(),
    [{ session_id: 'fresh-session' }]
  )
})

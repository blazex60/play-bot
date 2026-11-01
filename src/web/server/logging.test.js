import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Writable } from 'node:stream'
import { buildWebServer } from './index.js'
import { createMemoryDb, createTestConfig } from './testSupport.js'
import { createLogger, resolveLoggingConfig } from '../../logging/logger.js'

function capture() {
  const lines = []
  const stream = new Writable({ write(chunk, _e, cb) { lines.push(chunk.toString()); cb() } })
  const logger = createLogger('music-web', {
    config: { ...resolveLoggingConfig({}), level: 'debug', fileEnabled: false, stdoutEnabled: true },
    stdout: stream,
  })
  return { logger, records: () => lines.join('').split('\n').filter(Boolean).map(l => JSON.parse(l)), text: () => lines.join('') }
}

async function build(t, logger) {
  const db = createMemoryDb()
  t.after(() => db.close())
  const app = await buildWebServer({
    config: createTestConfig(),
    db,
    fetchImpl: async () => { throw new Error('unexpected fetch') },
    logger,
    startCleanup: false,
  })
  t.after(() => app.close())
  return app
}

test('web requests are logged with route pattern, status and duration; query secrets never appear', async (t) => {
  const cap = capture()
  const app = await build(t, cap.logger)

  await app.inject({ method: 'GET', url: '/auth/discord/callback?code=SECRETCODE&state=SECRETSTATE' })
  const rec = cap.records().find(r => r.event === 'web.request')
  assert.ok(rec, 'expected a web.request record')
  assert.equal(rec.service, 'music-web')
  assert.equal(rec.route, '/auth/discord/callback')
  assert.equal(typeof rec.durationMs, 'number')
  assert.equal(rec.level, 'warn')
  assert.equal(rec.status, 400)
  assert.ok(!cap.text().includes('SECRETCODE'))
  assert.ok(!cap.text().includes('SECRETSTATE'))
  assert.ok(cap.records().some(r => r.event === 'auth.oauth.callback_rejected'))
})

test('/healthz is not logged and migrations are', async (t) => {
  const cap = capture()
  const app = await build(t, cap.logger)
  await app.inject({ method: 'GET', url: '/healthz' })
  const events = cap.records().map(r => r.event)
  assert.ok(events.includes('web.db.migrated'))
  assert.ok(!events.includes('web.request'))
})

test('request ids are server generated, not taken from client headers', async (t) => {
  const cap = capture()
  const app = await build(t, cap.logger)
  await app.inject({ method: 'GET', url: '/api/me', headers: { 'x-request-id': 'attacker' } })
  const rec = cap.records().find(r => r.event === 'web.request')
  assert.notEqual(rec.reqId, 'attacker')
  assert.ok(rec.reqId, 'reqId should be present')
})

test('unexpected 5xx errors are logged with a stack even though request logging is custom', async (t) => {
  const cap = capture()
  const app = await build(t, cap.logger)
  app.get('/boom', async () => { throw new Error('kaboom Bearer abcdefghijklmnop') })
  const res = await app.inject({ method: 'GET', url: '/boom' })
  assert.equal(res.statusCode, 500)
  const rec = cap.records().find(r => r.event === 'web.request_error')
  assert.ok(rec, 'expected web.request_error')
  assert.equal(rec.err.message, 'kaboom Bearer [REDACTED]')
  assert.ok(rec.err.stack)
})

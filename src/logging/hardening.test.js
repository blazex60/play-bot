import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { scrubString } from './redact.js'
import { installProcessHandlers } from './processHandlers.js'

function fakeLogger() {
  const records = []
  const child = {}
  for (const level of ['info', 'warn', 'error', 'fatal']) child[level] = rec => records.push({ level, ...rec })
  return { records, child: () => child, flushLogs: () => { records.push({ flushed: true }) } }
}

// Dummy credential-shaped strings are assembled at runtime so secret scanners
// do not flag the literals in source.
const fake = (n, ch = 'x') => ch.repeat(n)

test('scrubString: masks real credentials but not ordinary prose', () => {
  assert.equal(scrubString('bot connection lost'), 'bot connection lost')
  assert.equal(scrubString('Missing Permissions: bot requires ManageMessages'), 'Missing Permissions: bot requires ManageMessages')
  assert.equal(scrubString('Basic authentication required'), 'Basic authentication required')
  assert.equal(scrubString('Bearer authentication failed'), 'Bearer authentication failed')
  assert.equal(scrubString(`Authorization: Bearer ${fake(22)}`), 'Authorization: Bearer [REDACTED]')
  assert.equal(scrubString(`Authorization: Bot ${fake(26)}`), 'Authorization: Bot [REDACTED]')
  assert.equal(scrubString(`Authorization: Basic ${fake(24, 'A')}==`), 'Authorization: Basic [REDACTED]')
})

test('processHandlers: shutdown runs onShutdown once, flushes, exits 0', async () => {
  const proc = new EventEmitter()
  const exits = []
  let calls = 0
  installProcessHandlers(fakeLogger(), { proc, exit: c => exits.push(c), onShutdown: async () => { calls += 1 } })
  proc.emit('SIGTERM')
  await new Promise(r => setImmediate(r))
  assert.equal(calls, 1)
  assert.deepEqual(exits, [0])
})

test('processHandlers: a second signal is not re-entrant and forces exit(1)', async () => {
  const proc = new EventEmitter()
  const exits = []
  let calls = 0
  installProcessHandlers(fakeLogger(), { proc, exit: c => exits.push(c), onShutdown: () => { calls += 1; return new Promise(() => {}) }, shutdownTimeoutMs: 5000 })
  proc.emit('SIGINT')
  await new Promise(r => setImmediate(r))
  proc.emit('SIGINT')
  await new Promise(r => setImmediate(r))
  assert.equal(calls, 1)
  assert.deepEqual(exits, [1])
})

test('processHandlers: a hung onShutdown times out, is logged, and still exits', async () => {
  const proc = new EventEmitter()
  const exits = []
  const logger = fakeLogger()
  installProcessHandlers(logger, { proc, exit: c => exits.push(c), onShutdown: () => new Promise(() => {}), shutdownTimeoutMs: 20 })
  proc.emit('SIGTERM')
  await new Promise(r => setTimeout(r, 80))
  assert.deepEqual(exits, [0])
  assert.ok(logger.records.some(r => r.event === 'process.shutdown_error'))
})

test('processHandlers: unhandledRejection logs fatal and exits 1', () => {
  const proc = new EventEmitter()
  const exits = []
  const logger = fakeLogger()
  installProcessHandlers(logger, { proc, exit: c => exits.push(c) })
  proc.emit('unhandledRejection', new Error('x'))
  assert.deepEqual(exits, [1])
  assert.ok(logger.records.some(r => r.event === 'process.unhandled_rejection'))
})

test('web process: shared modules log as music-web and never open the music-bot sink', () => {
  const dir = mkdtempSync(join(tmpdir(), 'logging-svc-'))
  try {
    const appLogger = fileURLToPath(new URL('./appLogger.js', import.meta.url))
    const search = fileURLToPath(new URL('../media/search.js', import.meta.url))
    const script = `
      const { setLogService, getAppLogger } = await import(${JSON.stringify(appLogger)});
      await import(${JSON.stringify(search)});   // imports a module that calls getLogger('ytdlp')
      setLogService('music-web');
      getAppLogger().child({ component: 'ytdlp' }).warn({ event: 'media.ytdlp.exited' });
      getAppLogger().flushLogs();
    `
    const res = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      env: { ...process.env, NODE_TEST_CONTEXT: '', NODE_ENV: '', LOG_DIR: dir, LOG_STDOUT_ENABLED: 'false', LOG_FILE_ENABLED: 'true' },
      encoding: 'utf8',
    })
    assert.equal(res.status, 0, res.stderr)
    assert.deepEqual(readdirSync(dir), ['music-web'])
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

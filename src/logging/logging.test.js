import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, mkdirSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Writable } from 'node:stream'

import { createLogger, resolveLoggingConfig } from './logger.js'
import { RotatingFileStream } from './rotatingFileStream.js'
import { pruneLogs, parseLogFileName } from './retention.js'
import { sanitizeUrl, scrubString } from './redact.js'

const DAY = 86_400_000
const T0 = Date.UTC(2026, 9, 28, 10, 0, 0)

function tmp() {
  return mkdtempSync(join(tmpdir(), 'logging-test-'))
}
function sink() {
  const lines = []
  const stream = new Writable({ write(chunk, _e, cb) { lines.push(chunk.toString()); cb() } })
  return { stream, lines, parsed: () => lines.join('').split('\n').filter(Boolean).map(l => JSON.parse(l)) }
}

test('config: defaults and overrides', () => {
  const c = resolveLoggingConfig({})
  assert.equal(c.level, 'info')
  assert.equal(c.retentionDays, 7)
  assert.equal(c.maxFileBytes, 10 * 1024 * 1024)
  assert.equal(c.maxFilesPerDay, 5)
  assert.equal(c.fileEnabled, true)
  assert.equal(resolveLoggingConfig({ LOG_LEVEL: 'DEBUG' }).level, 'debug')
  assert.equal(resolveLoggingConfig({ LOG_LEVEL: 'bogus' }).level, 'info')
  assert.equal(resolveLoggingConfig({ NODE_ENV: 'test' }).fileEnabled, false)
  assert.equal(resolveLoggingConfig({ NODE_ENV: 'test', LOG_FILE_ENABLED: 'true' }).fileEnabled, true)
})

test('logger: JSON lines with service/level/time, filtered by level', () => {
  const out = sink()
  const log = createLogger('music-bot', {
    config: { ...resolveLoggingConfig({}), level: 'info', fileEnabled: false },
    stdout: out.stream,
  })
  log.debug({ event: 'x.hidden' })
  log.info({ event: 'playback.track.started', guildId: '1', durationMs: 5 }, 'hi')
  const [rec, ...rest] = out.parsed()
  assert.equal(rest.length, 0)
  assert.equal(rec.service, 'music-bot')
  assert.equal(rec.level, 'info')
  assert.equal(rec.event, 'playback.track.started')
  assert.equal(rec.msg, 'hi')
  assert.match(rec.time, /^\d{4}-\d{2}-\d{2}T.*Z$/)
})

test('logger: secrets are redacted', () => {
  const out = sink()
  const log = createLogger('music-web', {
    config: { ...resolveLoggingConfig({}), fileEnabled: false },
    stdout: out.stream,
  })
  log.info({
    token: 'abc',
    req: { method: 'GET', url: '/cb?code=SECRET&x=1', headers: { authorization: 'Bearer abc', cookie: 'sid=1' } },
    nested: { password: 'pw', accessToken: 'at' },
    err: new Error('failed with Bearer abcdefghijklmnop'),
  })
  const text = out.lines.join('')
  for (const secret of ['"abc"', 'SECRET', 'sid=1', '"pw"', '"at"', 'abcdefghijklmnop']) {
    assert.ok(!text.includes(secret), `leaked ${secret}: ${text}`)
  }
  assert.ok(text.includes('x=1'))
})

test('sanitizeUrl / scrubString', () => {
  assert.equal(sanitizeUrl('/a?code=1&page=2#frag'), '/a?code=[REDACTED]&page=2')
  assert.equal(sanitizeUrl('/a'), '/a')
  assert.equal(sanitizeUrl('/a?access_token=z'), '/a?access_token=[REDACTED]')
  assert.equal(scrubString('Authorization: Bot abcdefghijklmnopqrstuvwx'), 'Authorization: Bot [REDACTED]')
})

test('file sink: writes to date-named jsonl and survives restart (appends)', () => {
  const dir = tmp()
  try {
    const a = new RotatingFileStream({ dir, now: () => T0, cleanupIntervalMs: 0 })
    a.write('{"n":1}\n')
    a.close()
    const b = new RotatingFileStream({ dir, now: () => T0, cleanupIntervalMs: 0 })
    b.write('{"n":2}\n')
    b.close()
    assert.deepEqual(readdirSync(dir), ['2026-10-28.jsonl'])
    assert.equal(readFileSync(join(dir, '2026-10-28.jsonl'), 'utf8'), '{"n":1}\n{"n":2}\n')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('file sink: rotates on date change', () => {
  const dir = tmp()
  let now = T0
  try {
    const s = new RotatingFileStream({ dir, now: () => now, cleanupIntervalMs: 0 })
    s.write('a\n'); s.flushSync()
    now = T0 + DAY
    s.write('b\n'); s.close()
    assert.deepEqual(readdirSync(dir).sort(), ['2026-10-28.jsonl', '2026-10-29.jsonl'])
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('file sink: rotates on size and caps generations per day', () => {
  const dir = tmp()
  try {
    const s = new RotatingFileStream({ dir, now: () => T0, maxFileBytes: 20, maxFilesPerDay: 3, cleanupIntervalMs: 0 })
    for (let i = 0; i < 10; i += 1) s.write(`${String(i).repeat(9)}\n`) // 10 bytes each
    s.close()
    const names = readdirSync(dir).sort()
    assert.equal(names.length, 3)
    // newest lines survive; oldest generation dropped
    const all = names.map(n => readFileSync(join(dir, n), 'utf8')).join('')
    assert.ok(all.includes('9'.repeat(9)))
    assert.ok(!all.includes('0'.repeat(9)))
    assert.ok(!names.includes('2026-10-28.jsonl'))
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('pruneLogs: removes only files outside the retention window; never protected', () => {
  const dir = tmp()
  try {
    const names = ['2026-10-20.jsonl', '2026-10-21.jsonl', '2026-10-21.1.jsonl', '2026-10-22.jsonl', '2026-10-28.jsonl', 'notes.txt']
    for (const n of names) writeFileSync(join(dir, n), 'x')
    // now = 10-28, retentionDays 7 -> keep >= 10-22
    const r = pruneLogs({ dir, now: T0, retentionDays: 7, protect: ['2026-10-20.jsonl'] })
    assert.deepEqual(r.deleted.map(d => d.name).sort(), ['2026-10-21.1.jsonl', '2026-10-21.jsonl'])
    assert.deepEqual(readdirSync(dir).sort(), ['2026-10-20.jsonl', '2026-10-22.jsonl', '2026-10-28.jsonl', 'notes.txt'])
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('pruneLogs: enforces total disk cap oldest-first, sparing the protected file', () => {
  const dir = tmp()
  try {
    for (const n of ['2026-10-26.jsonl', '2026-10-27.jsonl', '2026-10-28.jsonl']) writeFileSync(join(dir, n), 'x'.repeat(100))
    const r = pruneLogs({ dir, now: T0, retentionDays: 7, maxTotalBytes: 150, protect: ['2026-10-28.jsonl'] })
    assert.deepEqual(r.deleted.map(d => d.name), ['2026-10-26.jsonl', '2026-10-27.jsonl'])
    assert.deepEqual(readdirSync(dir), ['2026-10-28.jsonl'])
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('file sink: cleanup on startup deletes expired files', () => {
  const dir = tmp()
  try {
    writeFileSync(join(dir, '2026-10-01.jsonl'), 'old')
    const s = new RotatingFileStream({ dir, now: () => T0, cleanupIntervalMs: 0 })
    s.close()
    assert.deepEqual(readdirSync(dir), [])
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('file sink: unwritable destination never throws and warns once', { skip: process.getuid?.() === 0 }, () => {
  const dir = tmp()
  const warnings = []
  try {
    const s = new RotatingFileStream({ dir: join(dir, 'logs'), now: () => T0, cleanupIntervalMs: 0, warn: m => warnings.push(m) })
    chmodSync(join(dir, 'logs'), 0o500)
    assert.doesNotThrow(() => { s.write('a\n'); s.write('b\n'); s.flushSync() })
    s.close()
    assert.equal(warnings.length, 1)
    assert.match(warnings[0], /file sink unavailable/)
  } finally {
    try { chmodSync(join(dir, 'logs'), 0o700) } catch {}
    rmSync(dir, { recursive: true, force: true })
  }
})

test('file sink: dir that cannot be created does not break createLogger', () => {
  const dir = tmp()
  try {
    writeFileSync(join(dir, 'blocker'), 'file')
    const out = sink()
    const log = createLogger('music-bot', {
      config: { ...resolveLoggingConfig({}), dir: join(dir, 'blocker', 'logs') },
      stdout: out.stream,
    })
    assert.doesNotThrow(() => log.info({ event: 'still.works' }))
    assert.equal(out.parsed()[0].event, 'still.works')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('createLogger writes parseable JSONL into <dir>/<service>/', () => {
  const dir = tmp()
  try {
    const log = createLogger('music-web', {
      config: { ...resolveLoggingConfig({}), dir, stdoutEnabled: false },
      now: () => T0,
    })
    log.info({ event: 'web.started' })
    log.flushLogs(); log.closeLogs()
    const file = join(dir, 'music-web', '2026-10-28.jsonl')
    const rec = JSON.parse(readFileSync(file, 'utf8').trim())
    assert.equal(rec.event, 'web.started')
    assert.equal(rec.service, 'music-web')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('parseLogFileName', () => {
  assert.deepEqual(parseLogFileName('2026-10-28.jsonl'), { date: '2026-10-28', index: 0 })
  assert.deepEqual(parseLogFileName('2026-10-28.3.jsonl'), { date: '2026-10-28', index: 3 })
  assert.equal(parseLogFileName('x.jsonl'), null)
})

test('getLogger is lazy: importing/creating child loggers opens no log files', async () => {
  const dir = tmp()
  try {
    const { getLogger } = await import('./appLogger.js')
    process.env.LOG_DIR = dir
    const log = getLogger('lazy-test')
    assert.deepEqual(readdirSync(dir), [])
    assert.equal(typeof log.info, 'function')
  } finally {
    delete process.env.LOG_DIR
    rmSync(dir, { recursive: true, force: true })
  }
})

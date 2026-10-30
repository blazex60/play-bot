import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Fastify from 'fastify'
import { createFileSink, createLogger, installRequestLogging } from './index.js'

async function temporary(t) {
  const dir = await mkdtemp(join(tmpdir(), 'play-bot-log-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  return dir
}

test('JSON lines respect level, sanitize errors and persist across logger instances', async t => {
  const dir = await temporary(t)
  let out = ''
  const options = { service: 'music-bot', logDir: dir, stdout: { write: s => { out += s } } }
  let logs = createLogger(options)
  logs.logger.debug({ event: 'hidden' })
  logs.logger.info({ event: 'test.started', token: 'secret', err: new Error('https://example.com/?token=secret') })
  await logs.flush()
  logs = createLogger(options)
  logs.logger.info({ event: 'test.restart' })
  await logs.flush()
  const file = join(dir, 'music-bot', (await readdir(join(dir, 'music-bot')))[0])
  const lines = (await readFile(file, 'utf8')).trim().split('\n').map(JSON.parse)
  assert.deepEqual(lines.map(x => x.event), ['test.started', 'test.restart'])
  assert.equal(lines[0].level, 'info')
  assert.equal(lines[0].service, 'music-bot')
  assert.ok(!out.includes('secret'))
})

test('rotates by size and UTC date, deletes only expired named files', async t => {
  const dir = await temporary(t)
  let time = Date.parse('2026-10-30T23:59:59Z')
  await writeFile(join(dir, '2026-10-23.jsonl'), 'old')
  await writeFile(join(dir, '2026-10-24.jsonl'), 'keep')
  await writeFile(join(dir, 'other.txt'), 'keep')
  const sink = createFileSink({ directory: dir, now: () => time, maxBytes: 8, maxFiles: 2, warn() {} })
  sink.write('1234\n'); sink.write('5678\n'); sink.write('drop\n')
  await sink.flush()
  assert.deepEqual((await readdir(dir)).sort(), ['2026-10-24.jsonl', '2026-10-30.1.jsonl', '2026-10-30.jsonl', 'other.txt'])
  time += 2000
  sink.write('next\n')
  await sink.flush()
  const names = await readdir(dir)
  assert.ok(names.includes('2026-10-31.jsonl'))
  await sink.cleanup()
  assert.ok(!(await readdir(dir)).includes('2026-10-24.jsonl'))
})

test('file failures do not prevent stdout output', async t => {
  const dir = await temporary(t)
  const blocked = join(dir, 'file')
  await writeFile(blocked, '')
  let warnings = 0, out = ''
  const sink = createFileSink({ directory: join(blocked, 'logs'), warn: () => warnings++ })
  const logs = createLogger({ service: 'music-web', fileSink: sink, stdout: { write: s => { out += s } } })
  logs.logger.info({ event: 'still.running' })
  await logs.flush()
  assert.equal(JSON.parse(out).event, 'still.running')
  assert.equal(warnings, 1)
})

test('request logs contain route templates without query, body or headers and skip health', async t => {
  const dir = await temporary(t)
  let out = ''
  const logs = createLogger({ service: 'music-web', logDir: dir, stdout: { write: s => { out += s } } })
  const app = Fastify({ loggerInstance: logs.logger, disableRequestLogging: true })
  installRequestLogging(app, 'web.http')
  app.get('/healthz', async () => ({}))
  app.get('/item/:id', async () => ({}))
  await app.inject('/healthz')
  await app.inject({ url: '/item/secret?token=secret', headers: { authorization: 'secret' } })
  await app.close(); await logs.flush()
  assert.ok(!out.includes('secret'))
  const line = JSON.parse(out)
  assert.equal(line.route, '/item/:id')
  assert.equal(line.event, 'web.http.request.completed')
})

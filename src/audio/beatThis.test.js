import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { BeatThisWorker, isBeatThisAvailable, requestedBeatTracker, trackBeatsWithBeatThis } from './beatThis.js'

// Fake worker process speaking the JSON-lines protocol of beat_this_worker.py.
function fakeWorkerSpawn({ ready = true, respond = (req) => ({ id: req.id, ok: true, beats: [0.5, 1.0], downbeats: [0.5], inferMs: 5 }), spawns = [] } = {}) {
  return (cmd, args) => {
    const proc = new EventEmitter()
    proc.stdout = new PassThrough()
    proc.stderr = new PassThrough()
    proc.stdin = new PassThrough()
    proc.killed = false
    proc.kill = () => { proc.killed = true; queueMicrotask(() => proc.emit('close', null)) }
    spawns.push({ cmd, args, proc })
    queueMicrotask(() => proc.stdout.write(`${JSON.stringify(ready ? { ready: true, device: args.at(-1) } : { ready: false, error: 'CUDA is not available' })}\n`))
    let buf = ''
    proc.stdin.on('data', (d) => {
      buf += d
      let nl
      while ((nl = buf.indexOf('\n')) >= 0) {
        const req = JSON.parse(buf.slice(0, nl))
        buf = buf.slice(nl + 1)
        const res = respond(req)
        if (res) queueMicrotask(() => proc.stdout.write(`${JSON.stringify(res)}\n`))
      }
    })
    return proc
  }
}

test('requestedBeatTracker: auto by default, explicit values honored', () => {
  assert.equal(requestedBeatTracker({}), 'auto')
  assert.equal(requestedBeatTracker({ BEAT_TRACKER: 'Beat_This' }), 'beat_this')
  assert.equal(requestedBeatTracker({ BEAT_TRACKER: 'aubio' }), 'aubio')
  assert.equal(requestedBeatTracker({ BEAT_TRACKER: 'madmom' }), 'auto')
})

test('BeatThisWorker starts once and serves several tracks over the same process', async () => {
  const spawns = []
  const worker = new BeatThisWorker({ spawnFn: fakeWorkerSpawn({ spawns }), env: {} })
  const a = await worker.analyze('/tmp/a.webm', { device: 'cuda' })
  const b = await worker.analyze('/tmp/b.webm', { device: 'cuda' })
  assert.deepEqual(a, { beatsSec: [0.5, 1.0], downbeatsSec: [0.5], inferMs: 5 })
  assert.deepEqual(b.beatsSec, [0.5, 1.0])
  assert.equal(spawns.length, 1)
  assert.equal(spawns[0].cmd, 'nice')
  assert.equal(spawns[0].args.at(-1), 'cuda')
  worker.close()
})

test('BeatThisWorker: a per-track error rejects that track only', async () => {
  const worker = new BeatThisWorker({
    spawnFn: fakeWorkerSpawn({ respond: (req) => (req.id === 1 ? { id: 1, ok: false, error: 'ffmpeg exited with 1' } : { id: req.id, ok: true, beats: [1], downbeats: [] }) }),
    env: {},
  })
  await assert.rejects(worker.analyze('/tmp/bad'), /ffmpeg exited/)
  assert.deepEqual((await worker.analyze('/tmp/good')).beatsSec, [1])
  assert.equal(worker.disabled, false)
  worker.close()
})

test('BeatThisWorker: a hung request times out, the worker restarts, and 3 failures in a row disable it', async () => {
  const spawns = []
  const worker = new BeatThisWorker({ spawnFn: fakeWorkerSpawn({ spawns, respond: () => null }), env: {}, requestTimeoutMs: 20 })
  for (let i = 0; i < 3; i += 1) {
    await assert.rejects(worker.analyze(`/tmp/${i}`), /timed out/)
  }
  assert.equal(worker.disabled, true)
  assert.ok(spawns.length >= 2, 'a killed worker is restarted on the next request')
  await assert.rejects(worker.analyze('/tmp/later'), /disabled/)
})

test('BeatThisWorker: a worker that cannot start rejects with its reason', async () => {
  const worker = new BeatThisWorker({ spawnFn: fakeWorkerSpawn({ ready: false }), env: {} })
  await assert.rejects(worker.analyze('/tmp/a'), /CUDA is not available/)
  worker.close()
})

test('trackBeatsWithBeatThis: auto uses Beat This! only on CUDA; aubio mode never starts it', async () => {
  const spawns = []
  const worker = new BeatThisWorker({ spawnFn: fakeWorkerSpawn({ spawns }), env: {} })
  assert.equal(await trackBeatsWithBeatThis('/tmp/a', { env: {}, worker, deviceFn: async () => 'cpu' }), null)
  assert.equal(await trackBeatsWithBeatThis('/tmp/a', { env: { BEAT_TRACKER: 'aubio' }, worker, deviceFn: async () => 'cuda' }), null)
  assert.equal(spawns.length, 0)
  const r = await trackBeatsWithBeatThis('/tmp/a', { env: {}, worker, deviceFn: async () => 'cuda' })
  assert.deepEqual(r.beatsSec, [0.5, 1.0])
  worker.close()
})

test('trackBeatsWithBeatThis returns null (aubio fallback) when the worker fails', async () => {
  const worker = new BeatThisWorker({ spawnFn: fakeWorkerSpawn({ ready: false }), env: {} })
  assert.equal(await trackBeatsWithBeatThis('/tmp/a', { env: {}, worker, deviceFn: async () => 'cuda' }), null)
  worker.close()
})

test('isBeatThisAvailable follows BEAT_TRACKER and the worker state', () => {
  assert.equal(isBeatThisAvailable({ BEAT_TRACKER: 'aubio' }), false)
  assert.equal(isBeatThisAvailable({ BEAT_TRACKER: 'beat_this' }), true)
  assert.equal(isBeatThisAvailable({ BEAT_TRACKER: 'beat_this' }, { disabled: true }), false)
  assert.equal(isBeatThisAvailable({ DEMUCS_DEVICE: 'cpu' }), false)
  assert.equal(isBeatThisAvailable({ DEMUCS_DEVICE: 'cuda' }), true)
})

test('BeatThisWorker: a request queued behind a timed-out one gets a fresh worker, not the dying one', async () => {
  const spawns = []
  // The first worker never answers; later workers answer normally.
  const base = fakeWorkerSpawn({ spawns, respond: (req) => ({ id: req.id, ok: true, beats: [2], downbeats: [] }) })
  const spawnFn = (cmd, args) => {
    const proc = base(cmd, args)
    if (spawns.length === 1) proc.stdin.removeAllListeners('data')
    // Like a real child: `close` arrives a little after SIGKILL.
    proc.kill = () => { proc.killed = true; setTimeout(() => proc.emit('close', null), 10) }
    return proc
  }
  const worker = new BeatThisWorker({ spawnFn, env: {}, requestTimeoutMs: 20 })
  const first = worker.analyze('/tmp/hangs')
  const second = worker.analyze('/tmp/fine')
  await assert.rejects(first, /timed out/)
  assert.deepEqual((await second).beatsSec, [2])
  assert.equal(spawns.length, 2)
  assert.equal(spawns[0].proc.killed, true)
  worker.close()
})

test('BeatThisWorker does not keep the Node process alive (child and pipes are unref()ed)', async () => {
  const unrefs = []
  const base = fakeWorkerSpawn()
  const spawnFn = (cmd, args) => {
    const proc = base(cmd, args)
    proc.unref = () => unrefs.push('proc')
    for (const name of ['stdin', 'stdout', 'stderr']) proc[name].unref = () => unrefs.push(name)
    return proc
  }
  const worker = new BeatThisWorker({ spawnFn, env: {} })
  await worker.analyze('/tmp/a')
  assert.deepEqual(unrefs.sort(), ['proc', 'stderr', 'stdin', 'stdout'])
  worker.close()
})

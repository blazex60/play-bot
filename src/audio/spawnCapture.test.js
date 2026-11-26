import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { spawnCapture } from './spawnCapture.js'

function hangingProc(log) {
  const proc = new EventEmitter()
  proc.stdout = new EventEmitter()
  proc.stderr = new EventEmitter()
  proc.kill = (sig) => { log.push(sig); queueMicrotask(() => proc.emit('close', null)) }
  return proc
}

test('spawnCapture times out after timeoutMs when nothing is paused', async () => {
  const kills = []
  const started = Date.now()
  await assert.rejects(spawnCapture(() => hangingProc(kills), 'demucs', [], { timeoutMs: 40 }), /timed out after 40ms/)
  assert.ok(Date.now() - started < 200)
  assert.deepEqual(kills, ['SIGKILL'])
})

test('spawnCapture does not charge time the queue kept the process SIGSTOP\'d', async () => {
  const kills = []
  let paused = 0
  const started = Date.now()
  const run = spawnCapture(() => hangingProc(kills), 'demucs', [], { timeoutMs: 40, getPausedMs: () => paused })
  // 60 ms of the run is spent frozen; the deadline moves out by that much.
  paused = 60
  await new Promise((r) => setTimeout(r, 70))
  assert.deepEqual(kills, [], 'still alive past the raw 40 ms timeout')
  await assert.rejects(run, /timed out/)
  assert.ok(Date.now() - started >= 95, 'deadline was extended by the paused time')
  assert.deepEqual(kills, ['SIGKILL'])
})

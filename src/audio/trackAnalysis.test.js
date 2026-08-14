import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { analyzeKeys } from './keyAnalysis.js'
import { bpmTempPath } from './trackAnalysis.js'

test('bpmTempPath distinguishes overlapping start offsets by window length', () => {
  const head = bpmTempPath('/tmp/track.m4a', 0, 20)
  const tail = bpmTempPath('/tmp/track.m4a', 0, 40)
  assert.notEqual(head, tail)
  assert.match(head, /\.bpm\.0\.20000\.wav$/)
  assert.match(tail, /\.bpm\.0\.40000\.wav$/)
})

test('analyzeKeys extracts PCM through the provided spawnFn', async () => {
  const cmds = []
  const spawnFn = (cmd) => {
    cmds.push(cmd)
    const proc = new EventEmitter()
    proc.stdout = new EventEmitter()
    proc.stderr = new EventEmitter()
    proc.kill = () => {}
    queueMicrotask(() => proc.emit('close', 1))
    return proc
  }
  const keys = await analyzeKeys('/tmp/track.m4a', 60, {
    spawnFn,
    extractKeysFn: async () => ({ headKey: 'C major', tailKey: 'G major', harmonicConfidence: 0.8 }),
  })
  assert.ok(cmds.includes('ffmpeg'))
  assert.equal(keys.headKey, 'C major')
  assert.equal(keys.tailKey, 'G major')
})

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  STEM_FULL_TRACK_MAX_SEC,
  STEM_HEAD_WINDOW_SEC,
  STEM_TAIL_WINDOW_SEC,
  estimateSeparationTimeoutMs,
  findStemWindow,
  planStemWindows,
  stemPairCovered,
  stemSeparationConfig,
  stemWindowsAudioSec,
  stemWindowsOf,
} from './stemConfig.js'

test('stemSeparationConfig: measured defaults, env overrides, bad values fall back', () => {
  const d = stemSeparationConfig({})
  assert.equal(d.enabled, true)
  assert.equal(d.threads, 4)
  assert.equal(d.rtf, 1.5)
  assert.equal(d.timeoutCapMs, 600_000)
  const o = stemSeparationConfig({ STEM_SEPARATION_ENABLED: 'off', DEMUCS_THREADS: '2', STEM_SEPARATION_RTF: '2.1' })
  assert.equal(o.enabled, false)
  assert.equal(o.threads, 2)
  assert.equal(o.rtf, 2.1)
  const bad = stemSeparationConfig({ DEMUCS_THREADS: '0', STEM_SEPARATION_RTF: 'fast', STEM_SEPARATION_ENABLED: 'maybe' })
  assert.equal(bad.threads, 4)
  assert.equal(bad.rtf, 1.5)
  assert.equal(bad.enabled, true)
})

test('estimateSeparationTimeoutMs: (rtf × audio + fixed) × safety, capped; unknown length gets the cap', () => {
  const config = stemSeparationConfig({})
  // 135 s of windows: (1.5 × 135 + 10) × 2 = 425 s
  assert.equal(estimateSeparationTimeoutMs(135, config), 425_000)
  assert.equal(estimateSeparationTimeoutMs(10_000, config), 600_000)
  assert.equal(estimateSeparationTimeoutMs(null, config), 600_000)
  // The old fixed 600 s limit vs. the measured 1-thread cost of a 336 s track
  // (1231 s) is what failed in production; at 1 thread's RTF the estimate
  // must at least clear the measured run.
  const oneThread = stemSeparationConfig({ STEM_SEPARATION_RTF: '3.7', STEM_SEPARATION_TIMEOUT_MS: '5000000' })
  assert.ok(estimateSeparationTimeoutMs(336, oneThread) > 1231_000)
})

test('planStemWindows: head + tail for long tracks, whole track for short or unknown', () => {
  assert.deepEqual(planStemWindows(300), [
    { name: 'head', startSec: 0, endSec: STEM_HEAD_WINDOW_SEC },
    { name: 'tail', startSec: 300 - STEM_TAIL_WINDOW_SEC, endSec: 300 },
  ])
  assert.deepEqual(planStemWindows(STEM_FULL_TRACK_MAX_SEC), [{ name: 'full', startSec: 0, endSec: STEM_FULL_TRACK_MAX_SEC }])
  assert.deepEqual(planStemWindows(null), [{ name: 'full', startSec: 0, endSec: null }])
  assert.equal(stemWindowsAudioSec(planStemWindows(300)), STEM_HEAD_WINDOW_SEC + STEM_TAIL_WINDOW_SEC)
  assert.equal(stemWindowsAudioSec(planStemWindows(null)), null)
})

test('stemWindowsOf / findStemWindow: windowed and legacy whole-track shapes', () => {
  const legacy = { vocalPath: '/v.wav', instrumentalPath: '/i.wav' }
  assert.equal(stemWindowsOf(legacy).length, 1)
  assert.equal(findStemWindow(legacy, 250, 40).vocalPath, '/v.wav')
  assert.deepEqual(stemWindowsOf(null), [])

  const windowed = {
    windows: [
      { name: 'head', startSec: 0, endSec: 60, vocalPath: '/h.v', instrumentalPath: '/h.i' },
      { name: 'tail', startSec: 225, endSec: 300, vocalPath: '/t.v', instrumentalPath: '/t.i' },
    ],
  }
  assert.equal(findStemWindow(windowed, 10, 20).name, 'head')
  assert.equal(findStemWindow(windowed, 240, 50).name, 'tail')
  assert.equal(findStemWindow(windowed, 50, 20), null, 'span runs past the head window')
  assert.equal(findStemWindow(windowed, 120, 10), null, 'the middle was never separated')
  assert.equal(findStemWindow(windowed, 225, 10).name, 'tail', 'starting exactly at the window start is fine')
  assert.equal(findStemWindow(windowed, 224.8, 10), null, 'never before the window: the opener would clamp and misalign')
  assert.equal(findStemWindow(windowed, 0, 59.4).name, 'head')
  assert.equal(findStemWindow(windowed, 0, 59.8), null, 'the end keeps a margin inside the window (EOF at full gain)')
})

test('stemPairCovered: both sides must hold the overlap, scaled by tempo ratio', () => {
  const out = { windows: [{ name: 'tail', startSec: 225, endSec: 300, vocalPath: 'a', instrumentalPath: 'b' }] }
  const inc = { windows: [{ name: 'head', startSec: 0, endSec: 60, vocalPath: 'c', instrumentalPath: 'd' }] }
  const both = { outgoingStems: out, incomingStems: inc }
  assert.equal(stemPairCovered(both, { exitSec: 260, entrySec: 0, fadeSec: 16 }), true)
  assert.equal(stemPairCovered(both, { exitSec: 200, entrySec: 0, fadeSec: 16 }), false, 'exit before the tail window')
  assert.equal(stemPairCovered(both, { exitSec: 260, entrySec: 50, fadeSec: 16 }), false, 'entry overlap runs past the head window')
  // 289 + 8 × 1.25 = 299 ≤ 300 − 0.5; a faster outgoing stretch pushes it over.
  assert.equal(stemPairCovered(both, { exitSec: 289, entrySec: 0, fadeSec: 8, outgoingRatio: 1.25 }), true)
  assert.equal(stemPairCovered(both, { exitSec: 289, entrySec: 0, fadeSec: 8, outgoingRatio: 1.5 }), false)
  // Incoming also reserves the ~1 s promotion hold: (fade + 1) × 1.06 must fit.
  assert.equal(stemPairCovered(both, { exitSec: 226, entrySec: 0, fadeSec: 54 }), true) // out 280 ≤ 299.5, in 58.3 ≤ 59.5
  assert.equal(stemPairCovered(both, { exitSec: 226, entrySec: 3, fadeSec: 54 }), false) // in 61.3 > 59.5
})

test('stemSeparationConfig: cuda has its own RTF/fixed defaults and env knobs', () => {
  const cuda = stemSeparationConfig({}, { device: 'cuda' })
  assert.equal(cuda.device, 'cuda')
  assert.equal(cuda.rtf, 0.15)
  assert.equal(stemSeparationConfig({ STEM_SEPARATION_RTF: '9' }, { device: 'cuda' }).rtf, 0.15, 'the CPU knob does not leak into cuda')
  assert.equal(stemSeparationConfig({ STEM_SEPARATION_RTF_CUDA: '0.3' }, { device: 'cuda' }).rtf, 0.3)
  assert.equal(stemSeparationConfig({}).rtf, 1.5, 'cpu stays the default')
})

test('planStemWindows: wholeTrack (GPU) separates long tracks whole', () => {
  assert.deepEqual(planStemWindows(300, { wholeTrack: true }), [{ name: 'full', startSec: 0, endSec: 300 }])
  assert.equal(planStemWindows(300).length, 2)
})

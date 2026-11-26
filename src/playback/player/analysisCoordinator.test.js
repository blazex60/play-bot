import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isReusableAnalysis } from './analysisCoordinator.js'
import { ANALYSIS_VERSION } from '../../audio/trackAnalysis.js'

const NOW = 1_800_000_000

test('isReusableAnalysis: current-version analyses are reused', () => {
  assert.equal(isReusableAnalysis({ version: ANALYSIS_VERSION, bpm: 120, analyzedAt: NOW - 100 }, { nowSec: NOW }), true)
})

test('isReusableAnalysis: older versions (v4 rows from before vocal-from-stems) are re-analyzed', () => {
  assert.equal(isReusableAnalysis({ version: 4, bpm: 120 }, { nowSec: NOW, beatThisAvailable: false }), false)
  assert.equal(isReusableAnalysis({ version: 4, bpm: 120 }, { nowSec: NOW, beatThisAvailable: true }), false)
  assert.equal(isReusableAnalysis(null), false)
})

test('isReusableAnalysis: v5 (aubio beats) is re-analyzed only when Beat This! can run', () => {
  assert.equal(ANALYSIS_VERSION, 6)
  assert.equal(isReusableAnalysis({ version: 5, bpm: 120 }, { nowSec: NOW, beatThisAvailable: true }), false)
  assert.equal(isReusableAnalysis({ version: 5, bpm: 120 }, { nowSec: NOW, beatThisAvailable: false }), true)
})

test('isReusableAnalysis: a v6 aubio fallback is retried after a day once Beat This! is back', () => {
  const row = { version: ANALYSIS_VERSION, bpm: 120, beatSource: 'aubio' }
  assert.equal(isReusableAnalysis({ ...row, analyzedAt: NOW - 3600 }, { nowSec: NOW, beatThisAvailable: true }), true)
  assert.equal(isReusableAnalysis({ ...row, analyzedAt: NOW - 25 * 3600 }, { nowSec: NOW, beatThisAvailable: true }), false)
  assert.equal(isReusableAnalysis({ ...row, analyzedAt: NOW - 25 * 3600 }, { nowSec: NOW, beatThisAvailable: false }), true)
  assert.equal(isReusableAnalysis({ ...row, beatSource: 'beat_this', analyzedAt: NOW - 25 * 3600 }, { nowSec: NOW, beatThisAvailable: true }), true)
})

test('isReusableAnalysis: a BPM-less analysis is retried once it is a day old, not on every play', () => {
  assert.equal(isReusableAnalysis({ version: ANALYSIS_VERSION, bpm: null, analyzedAt: NOW - 3600 }, { nowSec: NOW }), true)
  assert.equal(isReusableAnalysis({ version: ANALYSIS_VERSION, bpm: null, analyzedAt: NOW - 25 * 3600 }, { nowSec: NOW }), false)
})

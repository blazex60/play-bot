import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isReusableAnalysis } from './analysisCoordinator.js'
import { ANALYSIS_VERSION } from '../../audio/trackAnalysis.js'

const NOW = 1_800_000_000

test('isReusableAnalysis: current-version analyses are reused', () => {
  assert.equal(isReusableAnalysis({ version: ANALYSIS_VERSION, bpm: 120, analyzedAt: NOW - 100 }, { nowSec: NOW }), true)
})

test('isReusableAnalysis: older versions (v4 rows from before vocal-from-stems) are re-analyzed', () => {
  assert.equal(isReusableAnalysis({ version: ANALYSIS_VERSION - 1, bpm: 120 }, { nowSec: NOW }), false)
  assert.equal(isReusableAnalysis(null), false)
})

test('isReusableAnalysis: a BPM-less analysis is retried once it is a day old, not on every play', () => {
  assert.equal(isReusableAnalysis({ version: ANALYSIS_VERSION, bpm: null, analyzedAt: NOW - 3600 }, { nowSec: NOW }), true)
  assert.equal(isReusableAnalysis({ version: ANALYSIS_VERSION, bpm: null, analyzedAt: NOW - 25 * 3600 }, { nowSec: NOW }), false)
})

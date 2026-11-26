import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildBeatThisGrids, deriveDownbeats, estimateMeter, fitBeatGrid } from './beatGrid.js'

// Deterministic ±jitter in [-amp, amp] so tests do not depend on Math.random.
function jitter(i, amp) {
  return (((i * 7919) % 21) / 10 - 1) * amp
}

// Beat This!-like output: times quantized to 20 ms frames.
function beatsAt(bpm, startSec, endSec, { jitterSec = 0.008, offset = 0.1 } = {}) {
  const period = 60 / bpm
  const out = []
  for (let i = 0; offset + i * period < endSec; i += 1) {
    const t = offset + i * period
    if (t >= startSec) out.push(Math.round((t + jitter(i, jitterSec)) / 0.02) * 0.02)
  }
  return out
}

test('fitBeatGrid recovers the tempo from 20 ms-quantized beats and drops a stray beat', () => {
  const beats = beatsAt(158, 0, 30)
  const withStray = [...beats, beats[10] + 0.17].sort((a, b) => a - b)
  const grid = fitBeatGrid(withStray, { startSec: 0, endSec: 30 })
  assert.ok(Math.abs(grid.bpm - 158) < 0.3, `bpm ${grid.bpm}`)
  assert.equal(grid.inliers, beats.length, 'the stray beat is not on the grid')
  assert.equal(grid.detected, beats.length + 1)
  assert.ok(grid.confidence > 0.9, `confidence ${grid.confidence}`)
  // grid beats are evenly spaced
  const gaps = grid.beatsSec.slice(1).map((t, i) => t - grid.beatsSec[i])
  assert.ok(Math.max(...gaps) - Math.min(...gaps) < 0.003)
})

test('fitBeatGrid fills missed beats on the grid but lowers confidence', () => {
  const beats = beatsAt(120, 0, 60).filter((_, i) => i % 4 !== 2) // a quarter missing
  const grid = fitBeatGrid(beats, { startSec: 0, endSec: 60 })
  assert.ok(Math.abs(grid.bpm - 120) < 0.3, `bpm ${grid.bpm}`)
  assert.ok(grid.beatsSec.length > beats.length, 'missing slots come back as grid beats')
  assert.ok(grid.confidence > 0.6 && grid.confidence < 0.85, `confidence ${grid.confidence}`)
})

test('fitBeatGrid gives low confidence to beats with no steady tempo, and null with too few beats', () => {
  const erratic = []
  let t = 0
  for (let i = 0; i < 60; i += 1) { t += 0.3 + ((i * 37) % 11) / 30; erratic.push(t) }
  const grid = fitBeatGrid(erratic, { startSec: 0, endSec: 60 })
  assert.ok(grid == null || grid.confidence < 0.4, `confidence ${grid?.confidence}`)
  assert.equal(fitBeatGrid([1, 2, 3], { startSec: 0, endSec: 30 }), null)
})

test('fitBeatGrid lowers confidence when the grid spans only a small part of the window', () => {
  const beats = beatsAt(120, 50, 60)
  const grid = fitBeatGrid(beats, { startSec: 0, endSec: 60 })
  assert.ok(grid.confidence < 0.4, `confidence ${grid.confidence}`)
})

test('deriveDownbeats snaps downbeats to the grid and keeps the majority bar phase', () => {
  const beats = beatsAt(150, 0, 60)
  const grid = fitBeatGrid(beats, { startSec: 0, endSec: 60 })
  const downbeats = beats.filter((_, i) => i % 4 === 1)
  const clean = deriveDownbeats(grid, downbeats, { meter: 4 })
  assert.ok(clean.confidence > 0.9, `confidence ${clean.confidence}`)
  assert.ok(Math.abs(clean.downbeatsSec[0] - beats[1]) < 0.03)
  // two downbeats on the wrong beat: same phase wins, confidence drops a bit
  const noisy = [...downbeats.slice(2), beats[2], beats[6]].sort((a, b) => a - b)
  const r = deriveDownbeats(grid, noisy, { meter: 4 })
  assert.ok(Math.abs(r.downbeatsSec[0] - beats[1]) < 0.03)
  assert.ok(r.confidence < clean.confidence)
  assert.deepEqual(deriveDownbeats(null, downbeats), { downbeatsSec: [], confidence: 0 })
})

test('estimateMeter reads 3/4 only when bars mostly hold 3 beats', () => {
  const beats = beatsAt(120, 0, 30)
  assert.equal(estimateMeter(beats, beats.filter((_, i) => i % 3 === 0)), 3)
  assert.equal(estimateMeter(beats, beats.filter((_, i) => i % 4 === 0)), 4)
  assert.equal(estimateMeter(beats, []), 4)
})

test('buildBeatThisGrids fills the head/tail payload shape and returns null without beats', () => {
  const beatsSec = beatsAt(128, 0, 240)
  const downbeatsSec = beatsSec.filter((_, i) => i % 4 === 0)
  const r = buildBeatThisGrids({ beatsSec, downbeatsSec }, { headWindowSec: 30, tailStartSec: 180, tailWindowSec: 60 })
  assert.equal(r.beatGrid.source, 'beat_this')
  assert.equal(r.beatGrid.tail.startSec, 180)
  assert.ok(r.beatGrid.head.beatsSec.every((t) => t < 30))
  assert.ok(r.beatGrid.tail.beatsSec.every((t) => t >= 180))
  assert.ok(Math.abs(r.head.bpm - 128) < 0.3 && Math.abs(r.tail.bpm - 128) < 0.3)
  assert.equal(r.downbeatGrid.meter, 4)
  assert.ok(r.downbeatGrid.confidence > 0.9, `downbeat confidence ${r.downbeatGrid.confidence}`)
  assert.equal(buildBeatThisGrids({ beatsSec: [], downbeatsSec: [] }, { headWindowSec: 30, tailStartSec: 180, tailWindowSec: 60 }), null)
})

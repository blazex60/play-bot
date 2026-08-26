import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { spawn, spawnSync } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { analyzeKeys } from './keyAnalysis.js'
import {
  bpmTempPath,
  analyzeBpmWindow,
  beatGridConfidence,
  isHalfDouble,
  dampIfHalfDouble,
  analyzeTrackFile,
  TAIL_BPM_WINDOW_SEC,
} from './trackAnalysis.js'

test('bpmTempPath distinguishes overlapping start offsets by window length', () => {
  const head = bpmTempPath('/tmp/track.m4a', 0, 20)
  const tail = bpmTempPath('/tmp/track.m4a', 0, 40)
  assert.notEqual(head, tail)
  assert.match(head, /\.bpm\.0\.20000\.wav$/)
  assert.match(tail, /\.bpm\.0\.40000\.wav$/)
})

test('bpmTempPath disambiguates identical startSec/windowSec via role (20-30s tracks: head === tail window)', () => {
  // For a 25s track, HEAD_BPM_WINDOW_SEC=30 and TAIL_BPM_WINDOW_SEC (60 as
  // of Phase 9F) both clamp to the same [0, 25] window — without a role
  // suffix the two parallel analyzeBpmWindow() calls would race on one temp
  // file.
  const head = bpmTempPath('/tmp/track.m4a', 0, 25, 'head')
  const tail = bpmTempPath('/tmp/track.m4a', 0, 25, 'tail')
  assert.notEqual(head, tail)
  assert.match(head, /\.bpm\.head\.0\.25000\.wav$/)
  assert.match(tail, /\.bpm\.tail\.0\.25000\.wav$/)
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

// --- Phase 9F §8: exit candidate search window expansion ---------------

test('analyzeTrackFile widens beatGrid.tail/phrases.tail reach in lockstep with TAIL_WINDOW_SEC', async () => {
  // Phase 9F widened vocalActivity.js's TAIL_WINDOW_SEC from 45s to 60s so
  // exit candidates further from EOF become reachable — but the actual pool
  // findExitCandidates() searches (beatGrid.tail / phrases.tail, sized here
  // by TAIL_BPM_WINDOW_SEC) used to be a SEPARATELY hardcoded 45s constant.
  // Before this phase's fix the two windows could silently diverge: a 70s
  // track would extend vocal analysis back to 10s (70-60) while still
  // capping the phrase/beat candidate pool at 25s (70-45), leaving Phase
  // 9F's own completion criterion ("a phrase boundary before 45s-from-end
  // can be selected as exit") unmet despite the constant bump.
  // TAIL_BPM_WINDOW_SEC is now derived from TAIL_WINDOW_SEC so they can't
  // re-diverge.
  const spawnFn = (cmd) => {
    const proc = new EventEmitter();
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.kill = () => {};
    // 'bash' probes for aubiotrack; reporting it missing short-circuits the
    // BPM/beat pipeline early (available:false) without needing a full
    // ffmpeg/aubiotrack fixture — tailStart is computed before any of that
    // and is what this test actually verifies.
    queueMicrotask(() => proc.emit('close', cmd === 'bash' ? 1 : 0));
    return proc;
  };

  const result = await analyzeTrackFile('/tmp/fake-9f.wav', { durationSec: 70, spawnFn });
  assert.equal(result.beatGrid.tail.startSec, 70 - TAIL_BPM_WINDOW_SEC);
  assert.ok(
    result.beatGrid.tail.startSec < 70 - 45,
    `expected the tail window to reach further back than the pre-Phase-9F 45s bound, got startSec=${result.beatGrid.tail.startSec}`,
  );
});

// --- Phase 7 §5: beat grid ---------------------------------------------

test('beatGridConfidence is 0 for fewer than 4 beats', () => {
  assert.equal(beatGridConfidence([]), 0)
  assert.equal(beatGridConfidence([0, 0.5, 1]), 0)
  assert.equal(beatGridConfidence(null), 0)
})

test('beatGridConfidence is high for a perfectly regular grid', () => {
  const beats = [0, 0.5, 1.0, 1.5, 2.0, 2.5, 3.0, 3.5];
  const conf = beatGridConfidence(beats, 4);
  assert.ok(conf > 0.9, `expected near-1.0 confidence, got ${conf}`);
})

test('beatGridConfidence drops for a jittery/inconsistent grid', () => {
  const regular = [0, 0.5, 1.0, 1.5, 2.0, 2.5, 3.0, 3.5];
  const jittery = [0, 0.3, 1.1, 1.4, 2.3, 2.4, 3.2, 3.9];
  const regularConf = beatGridConfidence(regular, 4);
  const jitteryConf = beatGridConfidence(jittery, 4);
  assert.ok(jitteryConf < regularConf, `expected ${jitteryConf} < ${regularConf}`);
})

test('beatGridConfidence drops when coverage is sparse relative to the window', () => {
  const beats = [0, 0.5, 1.0, 1.5]; // regular, but only covers 1.5s of a 10s window
  const fullCoverage = beatGridConfidence(beats, 1.5);
  const sparseCoverage = beatGridConfidence(beats, 10);
  assert.ok(sparseCoverage < fullCoverage, `expected ${sparseCoverage} < ${fullCoverage}`);
})

test('isHalfDouble flags a 2x tempo ratio and ignores near-equal or unrelated BPMs', () => {
  assert.equal(isHalfDouble(120, 60), true)
  assert.equal(isHalfDouble(61, 122), true)
  assert.equal(isHalfDouble(120, 121), false)
  assert.equal(isHalfDouble(120, 90), false)
  assert.equal(isHalfDouble(null, 120), false)
})

test('dampIfHalfDouble clamps confidence to 0.35 only when head/tail BPM disagree by ~2x', () => {
  // Head=60 BPM, tail=120 BPM: each window can independently report a
  // clean, high-confidence grid while describing different tempos — not a
  // trustworthy grid for tempo sync.
  assert.equal(dampIfHalfDouble(0.95, 60, 120), 0.35)
  assert.equal(dampIfHalfDouble(0.2, 60, 120), 0.2, 'never raises confidence, only clamps it down')
  assert.equal(dampIfHalfDouble(0.95, 120, 121), 0.95, 'agreeing windows are untouched')
})

test('empty aubiotrack output does not fabricate a beat at time 0', async () => {
  // Number('') === 0 (finite, not NaN): splitting an empty stdout on '\n'
  // yields [''], and mapping that through Number() used to slip a bogus
  // beat past the Number.isFinite() filter.
  const spawnFn = (cmd) => {
    const proc = new EventEmitter()
    proc.stdout = new EventEmitter()
    proc.stderr = new EventEmitter()
    proc.kill = () => {}
    if (cmd === 'bash') {
      queueMicrotask(() => {
        proc.stdout.emit('data', 'aubiotrack\n')
        proc.emit('close', 0)
      })
    } else if (cmd === 'aubiotrack') {
      queueMicrotask(() => proc.emit('close', 0)) // no stdout data at all -> ''
    } else {
      queueMicrotask(() => proc.emit('close', 0)) // ffmpeg conversion "succeeds"
    }
    return proc
  }

  const result = await analyzeBpmWindow('/tmp/fake.wav', { startSec: 0, windowSec: 8, spawnFn })
  assert.deepEqual(result.beatsSec, [])
  assert.equal(result.beatCount, 0)
  assert.equal(result.bpm, null)
})

// --- Real ffmpeg/aubiotrack fixture (Phase 7 §5 completion condition) --

function hasBinary(cmd) {
  const result = spawnSync('bash', ['-lc', `command -v ${cmd} || true`])
  return Boolean(result.stdout?.toString().trim())
}

const HAS_AUDIO_TOOLS = hasBinary('ffmpeg') && hasBinary('aubiotrack')

/** Synthesizes a click track at `bpm` (a 1kHz click every 60/bpm seconds). */
function synthesizeClickTrack(destPath, { bpm, durationSec = 8 }) {
  const periodSec = 60 / bpm
  return new Promise((resolve, reject) => {
    const proc = spawn('ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'lavfi',
      '-i', `aevalsrc=exprs='if(lt(mod(t\\,${periodSec})\\,0.02)\\,sin(2*PI*1000*t)\\,0)':s=44100:d=${durationSec}`,
      '-ac', '1',
      destPath,
    ])
    proc.on('error', reject)
    proc.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}`))))
  })
}

test(
  '120 BPM click-track fixture yields a beat grid at ~0.5s intervals',
  { skip: !HAS_AUDIO_TOOLS && 'ffmpeg/aubiotrack not installed' },
  async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'trackanalysis-fixture-'))
    const src = path.join(dir, 'click120.wav')
    try {
      // 120 BPM = a 1kHz click every 0.5s, 8s of audio (~16 beats).
      await synthesizeClickTrack(src, { bpm: 120 })

      const result = await analyzeBpmWindow(src, { startSec: 0, windowSec: 8, spawnFn: undefined })
      assert.equal(result.available, true)
      assert.equal(result.ok, true)
      assert.ok(result.bpm > 100 && result.bpm < 140, `expected ~120 BPM, got ${result.bpm}`)
      assert.ok(result.beatsSec.length >= 8, `expected several detected beats, got ${result.beatsSec.length}`)

      const intervals = []
      for (let i = 1; i < result.beatsSec.length; i += 1) {
        intervals.push(result.beatsSec[i] - result.beatsSec[i - 1])
      }
      const sorted = [...intervals].sort((a, b) => a - b)
      const median = sorted[Math.floor(sorted.length / 2)]
      assert.ok(median > 0.4 && median < 0.6, `expected ~0.5s median interval, got ${median}`)

      const conf = beatGridConfidence(result.beatsSec, 8)
      assert.ok(conf > 0.3, `expected a non-trivial confidence for a clean click track, got ${conf}`)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  },
)

test(
  'half/double ambiguous BPMs (60 vs 120 click tracks) are both individually detected as regular grids',
  { skip: !HAS_AUDIO_TOOLS && 'ffmpeg/aubiotrack not installed' },
  async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'trackanalysis-halfdouble-'))
    const src60 = path.join(dir, 'click60.wav')
    const src120 = path.join(dir, 'click120.wav')
    try {
      await Promise.all([
        synthesizeClickTrack(src60, { bpm: 60 }),
        synthesizeClickTrack(src120, { bpm: 120 }),
      ])

      const [result60, result120] = await Promise.all([
        analyzeBpmWindow(src60, { startSec: 0, windowSec: 8, spawnFn: undefined }),
        analyzeBpmWindow(src120, { startSec: 0, windowSec: 8, spawnFn: undefined }),
      ])
      assert.ok(result60.bpm > 45 && result60.bpm < 75, `expected ~60 BPM, got ${result60.bpm}`)
      assert.ok(result120.bpm > 100 && result120.bpm < 140, `expected ~120 BPM, got ${result120.bpm}`)

      // Two independently-detected grids at a real ~2x tempo ratio is what
      // isHalfDouble() exists to catch when head/tail windows disagree.
      assert.equal(isHalfDouble(result60.bpm, result120.bpm), true)
      assert.equal(isHalfDouble(result60.bpm, result60.bpm), false)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  },
)

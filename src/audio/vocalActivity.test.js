import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import {
  classifyVocalEnvelope,
  classifyFirstVocalStart,
  parseRmsLevels,
  analyzeVocalActivity,
} from './vocalActivity.js';

test('parseRmsLevels extracts ffmpeg astats lines', () => {
  const levels = parseRmsLevels('foo RMS_level=-12.5\nRMS_level=-40.0\n');
  assert.deepEqual(levels, [-12.5, -40]);
});

test('parseRmsLevels preserves -inf frames as a silent value instead of dropping them', () => {
  // Digital silence reports RMS_level=-inf. Dropping that entry (instead of
  // keeping a placeholder) shifted every later frame's index one position
  // early relative to real time, corrupting any fixed-cadence lookup over
  // the array (buildLevelLookup, head/tail slice indices, phrase features).
  const levels = parseRmsLevels('RMS_level=-inf\nRMS_level=-12.5\nRMS_level=-inf\nRMS_level=-8.2');
  assert.equal(levels.length, 4, 'every frame must keep its position, including silent ones');
  assert.ok(levels[0] < -50, `expected a silent placeholder, got ${levels[0]}`);
  assert.equal(levels[1], -12.5);
  assert.ok(levels[2] < -50, `expected a silent placeholder, got ${levels[2]}`);
  assert.equal(levels[3], -8.2);
});

test('classifyVocalEnvelope finds last vocal end on a sung outro', () => {
  const vocal = [-8, -8, -8, -45, -60, -60];
  const mix = [-6, -6, -6, -20, -30, -40];
  const result = classifyVocalEnvelope({
    vocalLevels: vocal,
    mixLevels: mix,
    tailStartSec: 100,
    frameSec: 0.1,
  });
  assert.equal(result.ok, true);
  assert.equal(result.source, 'demucs');
  assert.ok(result.lastVocalEndSec > 100.2 && result.lastVocalEndSec < 100.5);
  assert.equal(result.vocalConfidence, 0.85);
});

test('classifyVocalEnvelope treats an instrumental tail as ending at window start', () => {
  const vocal = [-60, -62, -58, -61, -59];
  const mix = [-12, -12, -14, -16, -18];
  const result = classifyVocalEnvelope({
    vocalLevels: vocal,
    mixLevels: mix,
    tailStartSec: 80,
    frameSec: 0.1,
  });
  assert.equal(result.lastVocalEndSec, 80);
  assert.ok(result.vocalGaps.length >= 1);
});

// --- Phase 7 §2.4: head-window vocal start detection --------------------

test('classifyFirstVocalStart finds where singing begins in an intro', () => {
  const vocal = [-60, -60, -60, -8, -8, -8, -8];
  const mix = [-6, -6, -6, -6, -6, -6, -6];
  const result = classifyFirstVocalStart({
    vocalLevels: vocal,
    mixLevels: mix,
    headStartSec: 0,
    frameSec: 0.1,
  });
  assert.ok(Math.abs(result.firstVocalStartSec - 0.3) < 1e-6);
  assert.deepEqual(result.headVocalGaps, []);
});

test('classifyFirstVocalStart returns null when the head window is fully instrumental', () => {
  const vocal = [-60, -62, -58, -61, -59];
  const mix = [-12, -12, -14, -16, -18];
  const result = classifyFirstVocalStart({
    vocalLevels: vocal,
    mixLevels: mix,
    headStartSec: 10,
    frameSec: 0.1,
  });
  assert.equal(result.firstVocalStartSec, null);
});

test('classifyFirstVocalStart reports a long instrumental gap between two vocal phrases', () => {
  // vocal(0.5s) -> instrumental gap(1.5s, at the VOCAL_GAP_MIN_SEC floor) -> vocal(0.5s)
  const vocal = [-8, -8, -8, -8, -8, -60, -60, -60, -60, -60, -60, -60, -60, -60, -60,
    -60, -60, -60, -60, -60, -8, -8, -8, -8, -8];
  const mix = new Array(vocal.length).fill(-6);
  const result = classifyFirstVocalStart({
    vocalLevels: vocal,
    mixLevels: mix,
    headStartSec: 0,
    frameSec: 0.1,
  });
  assert.equal(result.firstVocalStartSec, 0);
  assert.equal(result.headVocalGaps.length, 1);
  assert.ok(Math.abs(result.headVocalGaps[0].startSec - 0.5) < 1e-6);
  assert.ok(Math.abs(result.headVocalGaps[0].endSec - 2.0) < 1e-6);
});

// --- analyzeVocalActivity: single Demucs pass covering head + tail ------

function fakeVocalSpawn({ vocalsStderr, mixStderr, cmds = [] }) {
  return (cmd, args = []) => {
    cmds.push(cmd);
    const proc = new EventEmitter();
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.kill = () => {};
    let stderr = '';
    if (cmd === 'ffmpeg') {
      const iIndex = args.indexOf('-i');
      const inputPath = iIndex >= 0 ? args[iIndex + 1] : null;
      const isReadOnly = args.includes('-f') && args[args.indexOf('-f') + 1] === 'null';
      if (isReadOnly && inputPath?.endsWith('vocals.wav')) stderr = vocalsStderr;
      else if (isReadOnly && inputPath?.endsWith('combined.wav')) stderr = mixStderr;
    }
    queueMicrotask(() => {
      if (stderr) proc.stderr.emit('data', stderr);
      proc.emit('close', 0);
    });
    return proc;
  };
}

function levelsToStderr(levels) {
  return levels.map((db) => `RMS_level=${db}`).join('\n');
}

test('analyzeVocalActivity runs one Demucs pass and splits head/tail from the concatenated envelope', async () => {
  // head window: 3s (0-3s) = 30 frames; tail window: 4s (16-20s) = 40 frames.
  // head: 1.0s silence, then vocal to the end of the head window.
  // tail: vocal for 3.0s, then 1.0s silence to the end of the tail window.
  const vocalsLevels = [
    ...new Array(10).fill(-60), ...new Array(20).fill(-8), // head: 30 frames
    ...new Array(30).fill(-8), ...new Array(10).fill(-60), // tail: 40 frames
  ];
  const mixLevels = new Array(vocalsLevels.length).fill(-6);
  const cmds = [];

  const result = await analyzeVocalActivity('/tmp/fake-track.wav', {
    durationSec: 20,
    headWindowSec: 3,
    tailWindowSec: 4,
    spawnFn: fakeVocalSpawn({
      vocalsStderr: levelsToStderr(vocalsLevels),
      mixStderr: levelsToStderr(mixLevels),
      cmds,
    }),
  });

  assert.equal(cmds.filter((c) => c.endsWith('demucs')).length, 1, 'must run exactly one Demucs pass');
  assert.equal(result.ok, true);
  assert.equal(result.source, 'demucs');
  assert.ok(Math.abs(result.firstVocalStartSec - 1.0) < 0.05, `got ${result.firstVocalStartSec}`);
  assert.deepEqual(result.headVocalGaps, []);
  assert.ok(Math.abs(result.lastVocalEndSec - 19.0) < 0.05, `got ${result.lastVocalEndSec}`);
  assert.deepEqual(result.vocalGaps, []);
});

test('analyzeVocalActivity analyzes the whole clip in one pass when head/tail windows overlap (short track)', async () => {
  // 2s track, both windows cover it entirely -> single-clip branch.
  const vocalsLevels = [...new Array(5).fill(-60), ...new Array(10).fill(-8), ...new Array(5).fill(-60)];
  const mixLevels = new Array(vocalsLevels.length).fill(-6);

  const result = await analyzeVocalActivity('/tmp/fake-short.wav', {
    durationSec: 2,
    headWindowSec: 30,
    tailWindowSec: 45,
    spawnFn: fakeVocalSpawn({
      vocalsStderr: levelsToStderr(vocalsLevels),
      mixStderr: levelsToStderr(mixLevels),
    }),
  });

  assert.equal(result.ok, true);
  assert.ok(Math.abs(result.firstVocalStartSec - 0.5) < 0.05, `got ${result.firstVocalStartSec}`);
  assert.ok(Math.abs(result.lastVocalEndSec - 1.5) < 0.05, `got ${result.lastVocalEndSec}`);
});

test('analyzeVocalActivity slices the overlap-branch envelope to each window (medium track, gap straddling the boundary)', async () => {
  // 60s track: headWindowSec=30 -> head=[0,30), tailWindowSec=45 ->
  // tail=[15,60) -> overlap branch (head and tail both cover [15,30)).
  // A 2s instrumental gap sits at [29,31), straddling the head/tail
  // boundary: only 1.0s of it (29-30) is inside the head window (below the
  // 1.5s VOCAL_GAP_MIN_SEC floor -> no head gap), while the full 2.0s falls
  // inside the tail window (above the floor -> one tail gap). Before the
  // slicing fix, both windows were classified from the same full-clip
  // envelope and would have reported the same (29,31) gap for both.
  const frameSec = 0.1;
  const totalFrames = Math.round(60 / frameSec);
  const gapStartFrame = Math.round(29 / frameSec);
  const gapEndFrame = Math.round(31 / frameSec);
  const vocalsLevels = new Array(totalFrames).fill(-8);
  for (let i = gapStartFrame; i < gapEndFrame; i += 1) vocalsLevels[i] = -60;
  const mixLevels = new Array(totalFrames).fill(-6);

  const result = await analyzeVocalActivity('/tmp/fake-medium.wav', {
    durationSec: 60,
    spawnFn: fakeVocalSpawn({
      vocalsStderr: levelsToStderr(vocalsLevels),
      mixStderr: levelsToStderr(mixLevels),
    }),
  });

  assert.equal(result.ok, true);
  assert.equal(result.firstVocalStartSec, 0);
  assert.deepEqual(result.headVocalGaps, [], 'the 1.0s visible-in-head portion of the gap is below the reporting floor');
  assert.equal(result.vocalGaps.length, 1);
  assert.ok(Math.abs(result.vocalGaps[0].startSec - 29) < 0.05, `got ${result.vocalGaps[0].startSec}`);
  assert.ok(Math.abs(result.vocalGaps[0].endSec - 31) < 0.05, `got ${result.vocalGaps[0].endSec}`);
  assert.ok(Math.abs(result.lastVocalEndSec - 60) < 0.05, `got ${result.lastVocalEndSec}`);
});

test('analyzeVocalActivity returns the neutral empty result when the ffmpeg/Demucs pipeline fails', async () => {
  const spawnFn = () => {
    const proc = new EventEmitter();
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.kill = () => {};
    queueMicrotask(() => proc.emit('close', 1));
    return proc;
  };
  const result = await analyzeVocalActivity('/tmp/fake-fail.wav', { durationSec: 20, spawnFn });
  assert.equal(result.ok, false);
  assert.equal(result.source, 'none');
  assert.equal(result.firstVocalStartSec, null);
  assert.deepEqual(result.headVocalGaps, []);
});

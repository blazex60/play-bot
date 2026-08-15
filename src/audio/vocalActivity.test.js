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

function fakeVocalSpawn({ vocalsStderr, mixStderr }) {
  return (cmd, args = []) => {
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

  const result = await analyzeVocalActivity('/tmp/fake-track.wav', {
    durationSec: 20,
    headWindowSec: 3,
    tailWindowSec: 4,
    spawnFn: fakeVocalSpawn({
      vocalsStderr: levelsToStderr(vocalsLevels),
      mixStderr: levelsToStderr(mixLevels),
    }),
  });

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

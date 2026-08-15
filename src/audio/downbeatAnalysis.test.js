import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { scoreDownbeatPhase, analyzeDownbeats, DOWNBEAT_FRAME_SEC } from './downbeatAnalysis.js';

test('scoreDownbeatPhase picks the phase with the loudest low-band accent', () => {
  const beatsSec = [0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5]; // 4/4, 120 BPM
  // Phase 1 (indices 1, 5 -> 0.5s, 2.5s) is the loud one.
  const loud = new Set([0.5, 2.5]);
  const levelAt = (sec) => (loud.has(sec) ? -6 : -24);
  const result = scoreDownbeatPhase({ beatsSec, levelAt, meter: 4 });
  assert.equal(result.bestPhase, 1);
  assert.ok(result.margin > 10);
});

test('scoreDownbeatPhase returns null when there are fewer beats than the meter', () => {
  assert.equal(scoreDownbeatPhase({ beatsSec: [0, 0.5], levelAt: () => -6, meter: 4 }), null);
});

test('scoreDownbeatPhase margin is ~0 when every phase is equally loud', () => {
  const beatsSec = [0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5];
  const result = scoreDownbeatPhase({ beatsSec, levelAt: () => -10, meter: 4 });
  assert.ok(result.margin < 0.01);
});

function fakeEnvelopeSpawn(stderrByCall) {
  let call = 0;
  return () => {
    const proc = new EventEmitter();
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.kill = () => {};
    const stderr = stderrByCall[Math.min(call, stderrByCall.length - 1)];
    call += 1;
    queueMicrotask(() => {
      proc.stderr.emit('data', stderr);
      proc.emit('close', 0);
    });
    return proc;
  };
}

function buildRmsStderr(levels) {
  return levels.map((db) => `[Parsed_ametadata_2 @ 0x0] lavfi.astats.Overall.RMS_level=${db}\n`).join('');
}

test('analyzeDownbeats derives downbeatsSec from the accented phase and keeps them monotonic', async () => {
  const beatsSec = [0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5];
  // 40 frames (~4s at 0.1s) covering the head window span; loud at frames
  // matching beat index 1 mod 4 (0.5s -> frame 5, 2.5s -> frame 25).
  const levels = new Array(41).fill(-24);
  levels[Math.round(0.5 / DOWNBEAT_FRAME_SEC)] = -6;
  levels[Math.round(2.5 / DOWNBEAT_FRAME_SEC)] = -6;
  const stderr = buildRmsStderr(levels);

  const spawnFn = fakeEnvelopeSpawn([stderr, stderr]);
  const result = await analyzeDownbeats('/tmp/track.wav', {
    durationSec: 200,
    beatGrid: {
      head: { startSec: 0, beatsSec },
      tail: { startSec: 155, beatsSec },
    },
    spawnFn,
  });

  assert.equal(result.source, 'heuristic');
  assert.deepEqual(result.head.downbeatsSec, [0.5, 2.5]);
  const sorted = [...result.head.downbeatsSec].sort((a, b) => a - b);
  assert.deepEqual(result.head.downbeatsSec, sorted);
  assert.ok(result.confidence > 0);
});

test('analyzeDownbeats degrades to empty grid with zero confidence when the beat grid is too sparse', async () => {
  const spawnFn = () => {
    throw new Error('should not spawn for an empty beat grid');
  };
  const result = await analyzeDownbeats('/tmp/track.wav', {
    durationSec: 200,
    beatGrid: { head: { startSec: 0, beatsSec: [] }, tail: { startSec: 155, beatsSec: [0.1, 0.2] } },
    spawnFn,
  });
  assert.deepEqual(result.head.downbeatsSec, []);
  assert.deepEqual(result.tail.downbeatsSec, []);
  assert.equal(result.confidence, 0);
});

test('analyzeDownbeats returns an empty grid when filePath or beatGrid is missing', async () => {
  const empty = await analyzeDownbeats(null, { beatGrid: { head: {}, tail: {} } });
  assert.deepEqual(empty.head.downbeatsSec, []);
  const empty2 = await analyzeDownbeats('/tmp/track.wav', {});
  assert.deepEqual(empty2.head.downbeatsSec, []);
});

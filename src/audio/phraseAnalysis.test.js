import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPhraseCandidates } from './phraseAnalysis.js';

test('buildPhraseCandidates returns nothing without a downbeat grid', () => {
  assert.deepEqual(buildPhraseCandidates({ downbeatsSec: [] }), []);
  assert.deepEqual(buildPhraseCandidates({}), []);
});

test('buildPhraseCandidates emits one candidate per downbeat with bar-multiple bonuses', () => {
  const downbeatsSec = [0, 2, 4, 6, 8, 10, 12, 14, 16];
  const candidates = buildPhraseCandidates({ downbeatsSec });
  assert.equal(candidates.length, downbeatsSec.length);
  assert.deepEqual(candidates.map((c) => c.sec), downbeatsSec);
  assert.deepEqual(candidates.map((c) => c.barIndex), [0, 1, 2, 3, 4, 5, 6, 7, 8]);
  // bar 0 and bar 8 both hit the 8-bar bonus; bar 4 hits only the 4-bar bonus.
  assert.ok(candidates[0].reasons.includes('bar-multiple-8'));
  assert.ok(candidates[8].reasons.includes('bar-multiple-8'));
  assert.ok(candidates[4].reasons.includes('bar-multiple-4'));
  assert.ok(!candidates[4].reasons.includes('bar-multiple-8'));
  assert.ok(!candidates[1].reasons.includes('bar-multiple-4'));
});

test('a boundary near a vocal start/end scores higher than a bar-8 boundary far from it', () => {
  const downbeatsSec = [0, 4, 8, 16];
  const near = buildPhraseCandidates({
    downbeatsSec,
    vocalActivity: { boundariesSec: [4.2] },
  });
  const far = buildPhraseCandidates({
    downbeatsSec,
    vocalActivity: { boundariesSec: [100] },
  });
  const nearCandidate = near.find((c) => c.sec === 4);
  const farCandidate = far.find((c) => c.sec === 4);
  assert.ok(nearCandidate.reasons.includes('vocal-boundary'));
  assert.ok(!farCandidate.reasons.includes('vocal-boundary'));
  assert.ok(nearCandidate.score > farCandidate.score);
});

test('a candidate landing on a big level change scores higher than a flat region', () => {
  const downbeatsSec = [0, 2, 4];
  // Sharp jump in level right at sec=2 (drop from loud to quiet).
  const rmsLevels = [-6, -6, -6, -6, -6, -6, -6, -6, -6, -6, -6, -6, -6, -6, -6,
    -30, -30, -30, -30, -30, -30, -30, -30, -30, -30, -30, -30, -30, -30, -30,
    -30, -30, -30, -30, -30, -30, -30, -30, -30, -30, -30];
  const candidates = buildPhraseCandidates({
    downbeatsSec,
    features: { frameSec: 0.1, startSec: 0, rmsLevels },
  });
  const changeCandidate = candidates.find((c) => c.sec === 2);
  const flatCandidate = candidates.find((c) => c.sec === 0);
  assert.ok(changeCandidate.reasons.includes('structural-change'));
  assert.ok(!flatCandidate.reasons.includes('structural-change'));
});

test('a near-silence downbeat is tagged accordingly', () => {
  const downbeatsSec = [1];
  const rmsLevels = new Array(20).fill(-60);
  const candidates = buildPhraseCandidates({
    downbeatsSec,
    features: { frameSec: 0.1, startSec: 0, rmsLevels },
  });
  assert.ok(candidates[0].reasons.includes('near-silence'));
});

test('candidates within the tail 45s window and head 30s window are both reachable', () => {
  // Simulates a tail window starting at 193.42s (durationSec - 45) — the
  // window offset must not distort barIndex or boundary matching.
  const tailStart = 193.42;
  const downbeatsSec = [tailStart + 0.5, tailStart + 8.5];
  const candidates = buildPhraseCandidates({
    downbeatsSec,
    vocalActivity: { boundariesSec: [tailStart + 8.6] },
  });
  assert.equal(candidates[0].barIndex, 0);
  assert.equal(candidates[1].barIndex, 1);
  assert.ok(candidates[1].reasons.includes('vocal-boundary'));
});

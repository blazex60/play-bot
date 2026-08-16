import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bpmDelta, transitionCost, optimizeTrackOrder, isValidPermutation } from './ordering.js';
import { camelotDistance, parseCamelot } from './camelot.js';

test('parseCamelot accepts Camelot codes and key names', () => {
  assert.deepEqual(parseCamelot('8B'), { code: '8B', number: 8, mode: 'B' });
  assert.deepEqual(parseCamelot('C major'), { code: '8B', number: 8, mode: 'B' });
  assert.equal(parseCamelot('nonsense'), null);
});

test('camelotDistance is zero for identical keys', () => {
  assert.equal(camelotDistance('8B', 'C major'), 0);
  assert.ok(camelotDistance('8B', '9B') <= 1);
});

test('bpmDelta handles half/double tempo', () => {
  assert.equal(bpmDelta(120, 121), 1);
  assert.equal(bpmDelta(120, 60), 0);
});

test('optimizeTrackOrder prefers closer BPM neighbors', () => {
  const tracks = [{ title: 'A' }, { title: 'B' }, { title: 'C' }];
  const analyses = [
    { bpm: 128, headKey: '8B', tailKey: '8B', harmonicConfidence: 0.8 },
    { bpm: 130, headKey: '8B', tailKey: '8B', harmonicConfidence: 0.8 },
    { bpm: 90, headKey: '5A', tailKey: '5A', harmonicConfidence: 0.8 },
  ];
  const order = optimizeTrackOrder({
    anchorAnalysis: { bpm: 128, tailKey: '8B', harmonicConfidence: 0.8 },
    tracks,
    analyses,
  });
  assert.equal(isValidPermutation(order, 3), true);
  assert.equal(order[0], 0, '130 BPM track should follow 128 BPM anchor before 90 BPM outlier');
});

test('isValidPermutation rejects duplicates and out-of-range indices', () => {
  assert.equal(isValidPermutation([0, 1, 2], 3), true);
  assert.equal(isValidPermutation([0, 0, 2], 3), false);
  assert.equal(isValidPermutation([0, 1], 3), false);
});

test('transitionCost stays finite without analysis', () => {
  assert.ok(Number.isFinite(transitionCost(null, null)));
});

test('transitionCost ignores key distance when harmonic confidence is low', () => {
  const from = { bpm: 120, tailKey: '8B', harmonicConfidence: 0.2 };
  const toCompatible = { bpm: 120, headKey: '8B', harmonicConfidence: 0.2 };
  const toDistant = { bpm: 120, headKey: '2A', harmonicConfidence: 0.2 };
  assert.equal(
    transitionCost(from, toCompatible),
    transitionCost(from, toDistant),
    'low-confidence keys must not change cost',
  );

  const fromOk = { ...from, harmonicConfidence: 0.8 };
  const toOkClose = { ...toCompatible, harmonicConfidence: 0.8 };
  const toOkFar = { ...toDistant, harmonicConfidence: 0.8 };
  assert.ok(transitionCost(fromOk, toOkClose) < transitionCost(fromOk, toOkFar));
});

test('optimizeTrackOrder caps work to maxTracks and preserves the tail', () => {
  const n = 45;
  const tracks = Array.from({ length: n }, (_, i) => ({ title: `T${i}` }));
  const analyses = tracks.map((_, i) => ({ bpm: 100 + (i % 7), harmonicConfidence: 0.8 }));
  const order = optimizeTrackOrder({ tracks, analyses, maxTracks: 12, maxExact: 5 });
  assert.equal(isValidPermutation(order, n), true);
  assert.deepEqual(order.slice(12), Array.from({ length: n - 12 }, (_, i) => i + 12));
});

// Phase 7E (docs/mix-transition-phase7.md §12): transitionCost() reuses
// Phase 7C's findExitCandidates/findEntryCandidates/scoreTransitionPair as
// an additional term, only when both sides carry v3 phrase/vocal analysis.
function richOutgoing(overrides = {}) {
  return {
    analysisSource: 'demucs',
    durationSec: 200,
    lastVocalEndSec: 150,
    bpm: 120,
    tailBpm: 120,
    harmonicConfidence: 0.8,
    tailKey: '8B',
    downbeatGrid: { confidence: 0.8 },
    phrases: { tail: [{ sec: 160, barIndex: 0, score: 0.9, reasons: ['bar-multiple'] }] },
    lastRms: -14,
    ...overrides,
  };
}

function richIncoming(overrides = {}) {
  return {
    analysisSource: 'demucs',
    firstVocalStartSec: 20,
    headVocalGaps: [],
    bpm: 120,
    headBpm: 120,
    harmonicConfidence: 0.8,
    headKey: '8B',
    downbeatGrid: { confidence: 0.8 },
    phrases: { head: [{ sec: 4, barIndex: 0, score: 0.9, reasons: ['bar-multiple'] }] },
    lastRms: -14,
    ...overrides,
  };
}

test('transitionCost is skipped (no beatmix term) without phrase/vocal analysis, same as pre-7E', () => {
  // A pair whose only fields are the pre-Phase-7 ones (no analysisSource,
  // no phrases/downbeatGrid) must cost exactly the same as before the new
  // term existed — findExitCandidates/findEntryCandidates both return []
  // for it (hasVocalAnalysis() gates on analysisSource), so
  // beatmixCompatibilityCost() returns null and is skipped like the
  // harmonic term's own confidence gate. Non-identical bpm/key/energy
  // values (rather than a trivial all-zero-cost pair) so a bug that wrongly
  // counted a null beatmix term toward `parts` — same cost total, wrong
  // denominator — would still be caught.
  const from = { bpm: 120, tailKey: '8B', harmonicConfidence: 0.8, lastRms: -14 };
  const to = { bpm: 130, headKey: '9B', harmonicConfidence: 0.8, lastRms: -20 };
  const expectedBpmCost = 1 * Math.min(2, bpmDelta(120, 130) / 20);
  const expectedKeyCost = 1.2 * Math.min(2, camelotDistance('8B', '9B') / 2);
  const expectedEnergyCost = 0.3 * Math.min(1, Math.abs(-14 - -20) / 12);
  const expectedLegacyCost = (expectedBpmCost + expectedKeyCost + expectedEnergyCost) / 3;
  assert.ok(Math.abs(transitionCost(from, to) - expectedLegacyCost) < 1e-9);
});

test('transitionCost favors a well-matched beatmix candidate over a tempo-incompatible one', () => {
  const from = richOutgoing();
  const goodMatch = richIncoming();
  const badTempoMatch = richIncoming({ bpm: 200, headBpm: 200 }); // well outside stretch range
  assert.ok(
    transitionCost(from, goodMatch) < transitionCost(from, badTempoMatch),
    'a tempo-compatible, phrase-aligned candidate must cost less than an incompatible one',
  );
});

test('transitionCost\'s beatmix term treats half/double BPM like bpmDelta() does, not as unrelated', () => {
  const from = richOutgoing();
  const halfTempo = richIncoming({ bpm: 60, headBpm: 60 }); // octave-related to 120
  const unrelated = richIncoming({ bpm: 170, headBpm: 170 }); // outside any octave band of 120
  assert.ok(
    transitionCost(from, halfTempo) < transitionCost(from, unrelated),
    'a half-tempo candidate must not be penalized as harshly as a genuinely unrelated tempo',
  );
});

test('transitionCost\'s beatmix term is absent when the outgoing side has no usable vocal-safe exit', () => {
  // hasVocalAnalysis() requires analysisSource !== 'none' — a failed vocal
  // separation (not simply "no vocals found") must not be treated as a safe
  // window, so the beatmix term is skipped rather than silently optimistic.
  const from = richOutgoing({ analysisSource: 'none' });
  const to = richIncoming();
  const withBeatmixData = transitionCost(richOutgoing(), to);
  const withoutUsableExit = transitionCost(from, to);
  assert.notEqual(withBeatmixData, withoutUsableExit);
});

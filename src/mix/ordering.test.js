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

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bpmDelta, transitionCost, optimizeTrackOrder, isValidPermutation } from './ordering.js';
import { camelotDistance, parseCamelot } from './camelot.js';
import { BEAT_CONFIDENCE_MIN } from '../audio/beatmixTransition.js';

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
    beatConfidence: 0.8,
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
    beatConfidence: 0.8,
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

test('transitionCost\'s beatmix term requires the planner\'s own bar-derived overlap room, not a flat 2s floor', () => {
  // Codex round-1 on PR #35: a fixed 2s floor admitted candidates
  // planBeatmixTransition() would reject with no-exit-candidate (needs
  // MIN_OVERLAP_BARS * barSec = 2 bars @ 120 BPM/4-beat = 4s). This exit
  // candidate has 3.5s of room — enough for the old flat floor, not enough
  // for the real bar-derived one.
  const tightRoom = richOutgoing({
    durationSec: 163.5,
    phrases: { tail: [{ sec: 160, barIndex: 0, score: 0.9, reasons: ['bar-multiple'] }] },
  });
  const to = richIncoming();
  // bpm/key/lastRms are identical between richOutgoing()/richIncoming() by
  // default, so a correctly-skipped beatmix term leaves cost at exactly 0.
  assert.equal(transitionCost(tightRoom, to), 0);
});

test('transitionCost\'s beatmix term penalizes meter-mismatched pairs, matching planBeatmixTransition()', () => {
  // Codex round-1 on PR #35: scoreTransitionPair() itself doesn't inspect
  // meter, so a 3/4 vs 4/4 pair could still score well here even though
  // planBeatmixTransition() hard-rejects it (bar alignment can't stay
  // synchronized). bpm/key/lastRms stay identical to the defaults so any
  // cost difference can only come from the beatmix term itself.
  //
  // Codex round-2 on PR #35: the original round-1 fix returned null
  // (skipped) for a meter mismatch, same as "no data available" — but a
  // confirmed mismatch is a *positive* infeasibility signal, not missing
  // data, and skipping it let two meter-mismatched (unfixably bad) tracks
  // cost LESS than two well-matched (genuinely good) ones, since
  // transitionCost() only averages the terms that actually fire. A
  // confirmed mismatch must cost more than a real, scored match.
  const matchedMeter = [
    richOutgoing({ downbeatGrid: { confidence: 0.8, meter: 4 } }),
    richIncoming({ downbeatGrid: { confidence: 0.8, meter: 4 } }),
  ];
  const mismatchedMeter = [
    richOutgoing({ downbeatGrid: { confidence: 0.8, meter: 4 } }),
    richIncoming({ downbeatGrid: { confidence: 0.8, meter: 3 } }),
  ];
  const noBeatmixData = transitionCost(
    { bpm: 120, tailKey: '8B', harmonicConfidence: 0.8, lastRms: -14 },
    { bpm: 120, headKey: '8B', harmonicConfidence: 0.8, lastRms: -14 },
  );
  assert.ok(
    transitionCost(...mismatchedMeter) > transitionCost(...matchedMeter),
    'expected a confirmed meter mismatch to cost more than a genuinely well-matched beatmix pair',
  );
  assert.ok(
    transitionCost(...mismatchedMeter) > noBeatmixData,
    'expected a confirmed meter mismatch to cost more than simply having no beatmix data at all',
  );
});

test('transitionCost\'s beatmix term scores the best exit/entry combination, not just the top-ranked candidate on each side', () => {
  // Codex round-1 on PR #35: findExitCandidates()/findEntryCandidates() sort
  // by phrase score first, but the highest-scoring candidate on each side
  // can sit right at a vocal boundary (poor vocalSafety) while a
  // lower-scored pair together has much better vocal safety margin.
  // planBeatmixTransition() searches every combination and keeps the best
  // pair; this term must too.
  const exitNearBoundary = { sec: 150.5, barIndex: 0, score: 0.9, reasons: ['bar-multiple'] }; // margin 0.5
  const exitSafe = { sec: 155, barIndex: 1, score: 0.85, reasons: ['bar-multiple'] }; // margin 5
  const entryNearBoundary = { sec: 19, barIndex: 0, score: 0.9, reasons: ['bar-multiple'] }; // margin 1
  const entrySafe = { sec: 4, barIndex: 1, score: 0.8, reasons: ['bar-multiple'] }; // margin 16

  const fromBothCandidates = richOutgoing({ phrases: { tail: [exitNearBoundary, exitSafe] } });
  const toBothCandidates = richIncoming({ phrases: { head: [entryNearBoundary, entrySafe] } });
  // Only the top-ranked (by score) candidate on each side — [0]-only logic
  // would reduce the "both candidates" case to exactly this pairing.
  const fromTopOnly = richOutgoing({ phrases: { tail: [exitNearBoundary] } });
  const toTopOnly = richIncoming({ phrases: { head: [entryNearBoundary] } });

  assert.ok(
    transitionCost(fromBothCandidates, toBothCandidates) < transitionCost(fromTopOnly, toTopOnly),
    'expected considering the lower-ranked-but-vocal-safer pair to score better (cost less) than being forced onto the top-ranked pair alone',
  );
});

test('transitionCost\'s beatmix term penalizes sub-threshold beat-grid confidence, matching planBeatmixTransition()\'s beat-confidence-low rejection', () => {
  // Codex round-2 on PR #35: scoreTransitionPair() never inspects
  // beatConfidence at all — only downbeatGrid.confidence factors into its
  // score — so a shaky beat grid could still get a near-perfect beatmix
  // score here even though planBeatmixTransition() hard-rejects the same
  // pair with 'beat-confidence-low'. Below BEAT_CONFIDENCE_MIN on either
  // side must be treated as a confirmed infeasibility (full penalty), not
  // scored as if the grid were solid.
  const solidBeat = richOutgoing();
  const shakyBeatOutgoing = richOutgoing({ beatConfidence: BEAT_CONFIDENCE_MIN - 0.1 });
  const solidIncoming = richIncoming();
  const shakyBeatIncoming = richIncoming({ beatConfidence: BEAT_CONFIDENCE_MIN - 0.1 });

  assert.ok(
    transitionCost(solidBeat, shakyBeatIncoming) > transitionCost(solidBeat, solidIncoming),
    'expected a sub-threshold incoming beat grid to be penalized, not scored as solid',
  );
  assert.ok(
    transitionCost(shakyBeatOutgoing, solidIncoming) > transitionCost(solidBeat, solidIncoming),
    'expected a sub-threshold outgoing beat grid to be penalized, not scored as solid',
  );
});

test('transitionCost\'s beatmix term rejects an entry whose start is vocal-safe but leaves no forward overlap room', () => {
  // Codex round-2 on PR #35 (follow-up to the round-1 exit-side fix):
  // findEntryCandidates() only checks that entry.sec ITSELF is vocal-safe
  // (before firstVocalStartSec) — it says nothing about whether the room
  // that follows is enough for even the shortest real overlap.
  // planBeatmixTransition() additionally requires forwardSafePlayback to
  // cover the fadeSec it picks (entryForwardSafeSec()); this term must
  // apply the same floor derived by minOverlapSecFor() (2 bars @ 120 BPM/
  // 4-beat = 4s here). Single exit/entry candidate on each side so there's
  // no candidate-selection ambiguity — this isolates the forward-room
  // filter itself from the "best pair" search covered above.
  const from = richOutgoing();
  const tightEntry = richIncoming({
    firstVocalStartSec: 20,
    phrases: { head: [{ sec: 16.5, barIndex: 0, score: 0.9, reasons: ['bar-multiple'] }] }, // 3.5s room, needs 4s
  });
  const roomyEntry = richIncoming({
    firstVocalStartSec: 20,
    phrases: { head: [{ sec: 15, barIndex: 0, score: 0.9, reasons: ['bar-multiple'] }] }, // 5s room
  });
  assert.ok(
    transitionCost(from, tightEntry) > transitionCost(from, roomyEntry),
    'expected an entry without enough forward overlap room to be penalized versus one with enough room',
  );
});

test('optimizeTrackOrder caches per-edge beatmix scoring so the exact search stays fast with realistic candidate pools', () => {
  // Codex round-2 on PR #35 (P1): transitionCost(from, next) only depends
  // on the (from, next) pair, but the exact-search DP previously
  // recomputed it once per (mask, lastIdx, next) STATE — O(2^n * n) calls
  // instead of the O(n^2) distinct edges that actually exist. Each call now
  // runs an exitCandidates x entryCandidates search
  // (beatmixCompatibilityCost()), so with real v3 payloads (~20-25 tail x
  // ~15-20 head candidates) this measured at ~3s for a single n=10 exact
  // search on this machine without the edgeCost() cache added in this
  // round, comfortably enough to blow past the bot's 5s
  // /internal/optimize-order timeout on slower hardware — versus ~35ms with
  // it. The threshold below sits an order of magnitude above the cached
  // time and well below the uncached time, so a regression back to
  // per-state recomputation fails this test rather than silently
  // reintroducing the event-loop-blocking bug.
  function bigAnalysis(i) {
    const bpm = 118 + (i % 5);
    const tailPhrases = Array.from({ length: 20 }, (_, k) => (
      { sec: 150 + k * 2, barIndex: k, score: 0.5 + (k % 5) / 10, reasons: ['bar-multiple'] }
    ));
    const headPhrases = Array.from({ length: 15 }, (_, k) => (
      { sec: 4 + k * 1.2, barIndex: k, score: 0.5 + (k % 5) / 10, reasons: ['bar-multiple'] }
    ));
    return {
      ...richOutgoing({ bpm, tailBpm: bpm }),
      ...richIncoming({ bpm, headBpm: bpm }),
      phrases: { tail: tailPhrases, head: headPhrases },
    };
  }
  const n = 10; // optimizeTrackOrder()'s default maxExact — the exact case Codex flagged
  const tracks = Array.from({ length: n }, (_, i) => ({ title: `T${i}` }));
  const analyses = tracks.map((_, i) => bigAnalysis(i));

  const start = Date.now();
  const order = optimizeTrackOrder({ tracks, analyses, maxExact: n });
  const elapsedMs = Date.now() - start;

  assert.equal(isValidPermutation(order, n), true);
  assert.ok(
    elapsedMs < 500,
    `expected edge-cost caching to keep a ${n}-track exact search well under 500ms even with 20x15 phrase candidates per edge (took ${elapsedMs}ms)`,
  );
});

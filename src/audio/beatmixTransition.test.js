import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  findExitCandidates,
  findEntryCandidates,
  scoreTransitionPair,
  planBeatmixTransition,
  planPhraseCrossfade,
  planBeatSyncedTransition,
} from './beatmixTransition.js';

function makeAnalysis({
  bpm = 120,
  beatConfidence = 0.7,
  downbeatMeter = 4,
  downbeatConfidence = 0.6,
  durationSec = 200,
  lastVocalEndSec = null,
  vocalGaps = [],
  firstVocalStartSec = null,
  headVocalGaps = [],
  phrasesTail = null,
  phrasesHead = null,
  tailDownbeats = [],
  headDownbeats = [],
  tailKey = null,
  headKey = null,
  harmonicConfidence = 0,
} = {}) {
  return {
    bpm,
    beatConfidence,
    durationSec,
    downbeatGrid: {
      meter: downbeatMeter,
      confidence: downbeatConfidence,
      head: { downbeatsSec: headDownbeats },
      tail: { downbeatsSec: tailDownbeats },
    },
    phrases: { head: phrasesHead ?? [], tail: phrasesTail ?? [] },
    lastVocalEndSec,
    vocalGaps,
    firstVocalStartSec,
    headVocalGaps,
    tailKey,
    headKey,
    harmonicConfidence,
  };
}

// --- findExitCandidates ----------------------------------------------------

test('findExitCandidates filters to the vocal-free window with overlap room, sorted best-first', () => {
  const outgoing = makeAnalysis({
    durationSec: 200,
    lastVocalEndSec: 180,
    phrasesTail: [
      { sec: 175, barIndex: -1, score: 0.9, reasons: ['bar-multiple-8'] }, // before vocals end
      { sec: 184, barIndex: 0, score: 0.6, reasons: [] },
      { sec: 199, barIndex: 1, score: 0.8, reasons: [] }, // no room for overlap
      { sec: 188, barIndex: 2, score: 0.3, reasons: [] },
    ],
  });
  const candidates = findExitCandidates(outgoing, { minOverlapSec: 4 });
  assert.deepEqual(candidates.map((c) => c.sec), [184, 188]);
});

test('findExitCandidates falls back to bare downbeats when no phrase candidates exist', () => {
  const outgoing = makeAnalysis({
    durationSec: 200,
    lastVocalEndSec: 180,
    tailDownbeats: [182, 186, 199],
  });
  const candidates = findExitCandidates(outgoing, { minOverlapSec: 4 });
  assert.deepEqual(candidates.map((c) => c.sec), [182, 186]);
  assert.deepEqual(candidates[0].reasons, ['downbeat-only']);
});

test('findExitCandidates returns nothing without a usable duration', () => {
  assert.deepEqual(findExitCandidates(null), []);
  assert.deepEqual(findExitCandidates(makeAnalysis({ durationSec: null })), []);
});

// --- findEntryCandidates -----------------------------------------------------

test('findEntryCandidates keeps candidates before firstVocalStartSec and inside headVocalGaps', () => {
  const incoming = makeAnalysis({
    firstVocalStartSec: 15,
    headVocalGaps: [{ startSec: 20, endSec: 24 }],
    phrasesHead: [
      { sec: 4, barIndex: 0, score: 0.5, reasons: [] },
      { sec: 18, barIndex: 1, score: 0.9, reasons: [] }, // after first vocal, not in a gap
      { sec: 22, barIndex: 2, score: 0.4, reasons: [] }, // inside the gap
    ],
  });
  const candidates = findEntryCandidates(incoming);
  assert.deepEqual(candidates.map((c) => c.sec), [4, 22]);
});

test('findEntryCandidates treats a null firstVocalStartSec as fully vocal-safe', () => {
  const incoming = makeAnalysis({
    firstVocalStartSec: null,
    phrasesHead: [{ sec: 10, barIndex: 0, score: 0.5, reasons: [] }],
  });
  assert.equal(findEntryCandidates(incoming).length, 1);
});

// --- scoreTransitionPair ------------------------------------------------------

test('scoreTransitionPair rewards a closer tempo match', () => {
  const outgoing = makeAnalysis({ downbeatConfidence: 0.7 });
  const incoming = makeAnalysis({ downbeatConfidence: 0.7 });
  const exit = { sec: 190, score: 0.5 };
  const entry = { sec: 5, score: 0.5 };
  const close = scoreTransitionPair({ outgoing, incoming, exit, entry, targetBpm: 121 });
  const far = scoreTransitionPair({ outgoing, incoming, exit, entry, targetBpm: 127 });
  assert.ok(close > far);
});

test('scoreTransitionPair adds a harmonic bonus only when both sides clear the confidence threshold', () => {
  const base = { downbeatGrid: { confidence: 0.6 }, lastVocalEndSec: 0, firstVocalStartSec: null };
  const exit = { sec: 190, score: 0.5 };
  const entry = { sec: 5, score: 0.5 };
  const withHarmonic = scoreTransitionPair({
    outgoing: { ...base, harmonicConfidence: 0.9, tailKey: '8B' },
    incoming: { ...base, harmonicConfidence: 0.9, headKey: '8B' },
    exit, entry, targetBpm: 120,
  });
  const withoutHarmonic = scoreTransitionPair({
    outgoing: { ...base, harmonicConfidence: 0.2, tailKey: '8B' },
    incoming: { ...base, harmonicConfidence: 0.2, headKey: '8B' },
    exit, entry, targetBpm: 120,
  });
  assert.ok(withHarmonic > withoutHarmonic);
});

// --- planBeatmixTransition -----------------------------------------------------

function happyPathTracks() {
  const outgoing = makeAnalysis({
    bpm: 120,
    beatConfidence: 0.8,
    downbeatConfidence: 0.7,
    durationSec: 200,
    lastVocalEndSec: 180,
    phrasesTail: [
      { sec: 184, barIndex: 0, score: 0.6, reasons: ['bar-multiple-4'] },
      { sec: 188, barIndex: 1, score: 0.3, reasons: [] },
      { sec: 192, barIndex: 2, score: 0.2, reasons: [] },
    ],
  });
  const incoming = makeAnalysis({
    bpm: 122,
    beatConfidence: 0.75,
    downbeatConfidence: 0.65,
    durationSec: 200,
    firstVocalStartSec: 15,
    phrasesHead: [
      { sec: 4, barIndex: 0, score: 0.5, reasons: ['bar-multiple-4'] },
      { sec: 8, barIndex: 1, score: 0.3, reasons: [] },
      { sec: 20, barIndex: 2, score: 0.4, reasons: [] }, // after firstVocalStartSec, excluded
    ],
  });
  return { outgoing, incoming };
}

test('planBeatmixTransition builds a full TransitionPlan v2 for a clean, compatible pair', () => {
  const { outgoing, incoming } = happyPathTracks();
  const plan = planBeatmixTransition(outgoing, incoming);

  assert.equal(plan.mode, 'beatmix');
  assert.equal(plan.eligible, true);
  assert.equal(plan.targetBpm, 120); // session tempo: incoming stretches to outgoing's BPM
  assert.equal(plan.outgoing.exitStartSec, 184);
  assert.equal(plan.incoming.entrySec, 4);
  assert.equal(plan.sync.bars, 4);
  assert.equal(plan.sync.beatsPerBar, 4);
  assert.ok(Math.abs(plan.incoming.tempoRatio - 120 / 122) < 1e-9);
  assert.match(plan.incoming.tempoFilter, /^rubberband=tempo=0\.9836$/);
  assert.ok(plan.confidence > 0.5 && plan.confidence <= 1);
  assert.ok(Math.abs(plan.fadeSec - (60 / 120) * 4 * 4) < 1e-6);
});

test('planBeatmixTransition rejects when BPM is unavailable on either side', () => {
  const { outgoing, incoming } = happyPathTracks();
  const plan = planBeatmixTransition({ ...outgoing, bpm: null }, incoming);
  assert.equal(plan.eligible, false);
  assert.deepEqual(plan.reasons, ['bpm-unavailable']);
});

test('planBeatmixTransition rejects on low beat confidence', () => {
  const { outgoing, incoming } = happyPathTracks();
  const plan = planBeatmixTransition({ ...outgoing, beatConfidence: 0.1 }, incoming);
  assert.deepEqual(plan.reasons, ['beat-confidence-low']);
});

test('planBeatmixTransition rejects on low downbeat confidence', () => {
  const { outgoing, incoming } = happyPathTracks();
  const lowDownbeat = { ...outgoing, downbeatGrid: { ...outgoing.downbeatGrid, confidence: 0.1 } };
  const plan = planBeatmixTransition(lowDownbeat, incoming);
  assert.deepEqual(plan.reasons, ['downbeat-confidence-low']);
});

test('planBeatmixTransition rejects when the tempo ratio exceeds the hard limit', () => {
  const { outgoing, incoming } = happyPathTracks();
  const plan = planBeatmixTransition(outgoing, { ...incoming, bpm: 140 }); // ~14.3% off 120
  assert.equal(plan.eligible, false);
  assert.equal(plan.reasons[0], 'tempo-ratio-exceeds-hard');
});

test('planBeatmixTransition rejects when the outgoing track has no vocal-safe exit room', () => {
  const { outgoing, incoming } = happyPathTracks();
  const plan = planBeatmixTransition({ ...outgoing, phrases: { tail: [] } }, incoming);
  assert.deepEqual(plan.reasons, ['no-exit-candidate']);
});

test('planBeatmixTransition rejects when the incoming track has no vocal-safe entry point', () => {
  const { outgoing, incoming } = happyPathTracks();
  const plan = planBeatmixTransition(outgoing, { ...incoming, phrases: { head: [] } });
  assert.deepEqual(plan.reasons, ['no-entry-candidate']);
});

test('planBeatmixTransition degrades overlap bars when 4 bars does not fit but 2 does', () => {
  const { outgoing, incoming } = happyPathTracks();
  // Only the 184s candidate remains, with 5s of room after it (189 - 184):
  // 4 bars (8s) and 3 bars (6s) don't fit, 2 bars (4s) does.
  const tightOutgoing = {
    ...outgoing,
    durationSec: 189,
    phrases: { tail: [{ sec: 184, barIndex: 0, score: 0.6, reasons: [] }] },
  };
  const plan = planBeatmixTransition(tightOutgoing, incoming);
  assert.equal(plan.eligible, true);
  assert.equal(plan.sync.bars, 2);
  assert.ok(Math.abs(plan.fadeSec - (60 / 120) * 4 * 2) < 1e-6);
});

test('planBeatmixTransition rejects when no overlap length fits on the incoming side', () => {
  const { outgoing, incoming } = happyPathTracks();
  // Incoming track is only 6s long; the one entry candidate at 4s leaves 2s
  // of room, less than even MIN_OVERLAP_BARS (2 bars = 4s at 120 BPM).
  const shortIncoming = {
    ...incoming,
    durationSec: 6,
    firstVocalStartSec: 5,
    phrases: { head: [{ sec: 4, barIndex: 0, score: 0.5, reasons: [] }] },
  };
  const plan = planBeatmixTransition(outgoing, shortIncoming);
  assert.deepEqual(plan.reasons, ['no-overlap-fit']);
});

// --- planPhraseCrossfade -----------------------------------------------------

test('planPhraseCrossfade aligns to phrase boundaries without requiring tempo compatibility', () => {
  const outgoing = makeAnalysis({
    bpm: 90,
    durationSec: 200,
    lastVocalEndSec: 180,
    phrasesTail: [{ sec: 185, barIndex: 0, score: 0.7, reasons: [] }],
  });
  const incoming = makeAnalysis({
    bpm: 170, // wildly different tempo — beatmix would reject this
    firstVocalStartSec: 10,
    phrasesHead: [{ sec: 3, barIndex: 0, score: 0.6, reasons: [] }],
  });
  const plan = planPhraseCrossfade(outgoing, incoming);
  assert.equal(plan.mode, 'phrase-crossfade');
  assert.equal(plan.startSec, 185);
  assert.equal(plan.entrySec, 3);
  assert.ok(plan.confidence > 0);
});

test('planPhraseCrossfade rejects without a phrase candidate on either side', () => {
  const outgoing = makeAnalysis({ durationSec: 200, lastVocalEndSec: 180 });
  const incoming = makeAnalysis({ firstVocalStartSec: 10 });
  assert.deepEqual(planPhraseCrossfade(outgoing, incoming).reasons, ['no-exit-candidate']);
});

// --- planBeatSyncedTransition (§16 fallback ladder) ---------------------------

test('planBeatSyncedTransition returns the beatmix plan when tier 1 is eligible', () => {
  const { outgoing, incoming } = happyPathTracks();
  const plan = planBeatSyncedTransition(outgoing, incoming);
  assert.equal(plan.mode, 'beatmix');
});

test('planBeatSyncedTransition falls back to phrase-crossfade when beatmix is ineligible but phrases align', () => {
  const { outgoing, incoming } = happyPathTracks();
  const incompatibleTempo = { ...incoming, bpm: 140 };
  const plan = planBeatSyncedTransition(outgoing, incompatibleTempo);
  assert.equal(plan.mode, 'phrase-crossfade');
  assert.deepEqual(plan.fallbackFrom, ['tempo-ratio-exceeds-hard']);
});

test('planBeatSyncedTransition falls back to the existing planTransition() crossfade when no beat/phrase data exists', () => {
  // Mirrors phase2.test.js's "planTransition crossfades from outgoing vocal
  // window" fixture — this must still land on 'crossfade' via the untouched
  // tier-3+ delegation, with no phrase/beat data to support tiers 1-2.
  const outgoing = {
    confidence: 0.8,
    recommendedOverlapSec: 5,
    durationSec: 200,
    vocalConfidence: 0.85,
    lastVocalEndSec: 195,
    tailShape: 'abrupt',
    bpm: 120,
    bpmConfidence: 0.6,
    beatConfidence: 0,
    downbeatGrid: { confidence: 0 },
    phrases: { tail: [] },
  };
  const incoming = {
    confidence: 0.8,
    bpm: 122,
    bpmConfidence: 0.6,
    beatConfidence: 0,
    downbeatGrid: { confidence: 0 },
    phrases: { head: [] },
  };
  const plan = planBeatSyncedTransition(outgoing, incoming);
  assert.equal(plan.mode, 'crossfade');
  assert.equal(plan.baseSwap, true);
  assert.ok(plan.startSec >= 195);
  assert.deepEqual(plan.fallbackFrom, ['beat-confidence-low', 'no-exit-candidate']);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  findExitCandidates,
  findEntryCandidates,
  scoreTransitionPair,
  scoreTransitionPairDetailed,
  planBeatmixTransition,
  planPhraseCrossfade,
  planBeatSyncedTransition,
  MIX_BARS,
  BEATMIX_OVERLAP_BARS,
  MIN_OVERLAP_BARS,
  EXTENDED_PHRASE_CONFIDENCE_MIN,
  EXTENDED_VOCAL_CONFIDENCE_MIN,
} from './beatmixTransition.js';

function makeAnalysis({
  bpm = 120,
  headBpm = null,
  tailBpm = null,
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
  vocalConfidence = null,
  analysisSource = 'demucs', // real (possibly null-vocal) analysis by default; pass 'none' to simulate a failed pass
} = {}) {
  return {
    bpm,
    headBpm,
    tailBpm,
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
    vocalConfidence,
    analysisSource,
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

test('findExitCandidates returns nothing when vocal analysis failed outright, even with a null lastVocalEndSec that would otherwise default to a permissive floor', () => {
  // analyzeVocalActivity()'s emptyResult() on a total ffmpeg/Demucs failure
  // returns lastVocalEndSec: null AND source: 'none' together — treating
  // that null as "vocal-free from time 0" would offer an unverified window.
  const outgoing = makeAnalysis({
    durationSec: 200,
    lastVocalEndSec: null,
    phrasesTail: [{ sec: 190, barIndex: 0, score: 0.5, reasons: [] }],
    analysisSource: 'none',
  });
  assert.deepEqual(findExitCandidates(outgoing), []);
});

test('findEntryCandidates returns nothing when vocal analysis failed outright, even with a null firstVocalStartSec that would otherwise mean fully safe', () => {
  const incoming = makeAnalysis({
    firstVocalStartSec: null,
    phrasesHead: [{ sec: 5, barIndex: 0, score: 0.5, reasons: [] }],
    analysisSource: 'none',
  });
  assert.deepEqual(findEntryCandidates(incoming), []);
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

test('scoreTransitionPair credits a gap-safe entry from the gap boundaries, not a negative firstVocalStartSec delta', () => {
  const outgoing = makeAnalysis({ downbeatConfidence: 0.7, lastVocalEndSec: 0 });
  // Entry at 22s sits inside the [20,24] gap, after firstVocalStartSec (15) —
  // the naive `firstVocalStartSec - entrySec` would be -7 (zero credit).
  // The true margin is min(22-20, 24-22) = 2s, i.e. full credit.
  const incomingWithGap = makeAnalysis({
    downbeatConfidence: 0.7,
    firstVocalStartSec: 15,
    headVocalGaps: [{ startSec: 20, endSec: 24 }],
  });
  const exit = { sec: 190, score: 0.5 };
  const gapEntry = { sec: 22, score: 0.5 };
  const scoreAtGapEntry = scoreTransitionPair({ outgoing, incoming: incomingWithGap, exit, entry: gapEntry, targetBpm: 120 });

  // A same-shaped pair whose entry is comfortably before firstVocalStartSec
  // should score identically — the gap entry is just as safe.
  const beforeOnsetEntry = { sec: 13, score: 0.5 };
  const scoreBeforeOnset = scoreTransitionPair({ outgoing, incoming: incomingWithGap, exit, entry: beforeOnsetEntry, targetBpm: 120 });
  assert.equal(scoreAtGapEntry, scoreBeforeOnset);
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

// --- scoreTransitionPairDetailed (Phase 9D §6.3: Candidate quality sub-terms) ---

test('scoreTransitionPairDetailed().total matches scoreTransitionPair() exactly for the same inputs', () => {
  // scoreTransitionPair() is now a thin wrapper around the same computation
  // scoreTransitionPairDetailed() exposes — same rounding, same call
  // signature — so every existing caller/test treating it as "the score, a
  // number" must see no behavior change from this refactor.
  const outgoing = makeAnalysis({ downbeatConfidence: 0.7 });
  const incoming = makeAnalysis({ downbeatConfidence: 0.7 });
  const exit = { sec: 190, score: 0.5 };
  const entry = { sec: 5, score: 0.5 };
  const params = { outgoing, incoming, exit, entry, targetBpm: 121 };
  assert.equal(scoreTransitionPairDetailed(params).total, scoreTransitionPair(params));
});

test('scoreTransitionPairDetailed() reports harmonicCompatibility as null (not 0) when confidence does not clear the threshold on both sides', () => {
  // §9.2 "key match is never required": harmonicCompatibility must
  // distinguish "not scored at all" (null) from "scored and it was bad"
  // (a low number close to 0) — the Candidate struct in §6.3 relies on
  // this to avoid fabricating a harmonic quality reading that was never
  // actually computed.
  const base = { downbeatGrid: { confidence: 0.6 }, lastVocalEndSec: 0, firstVocalStartSec: null };
  const exit = { sec: 190, score: 0.5 };
  const entry = { sec: 5, score: 0.5 };
  const belowThreshold = scoreTransitionPairDetailed({
    outgoing: { ...base, harmonicConfidence: 0.2, tailKey: '8B' },
    incoming: { ...base, harmonicConfidence: 0.2, headKey: '8B' },
    exit, entry, targetBpm: 120,
  });
  assert.equal(belowThreshold.harmonicCompatibility, null);

  const aboveThreshold = scoreTransitionPairDetailed({
    outgoing: { ...base, harmonicConfidence: 0.9, tailKey: '8B' },
    incoming: { ...base, harmonicConfidence: 0.9, headKey: '8B' },
    exit, entry, targetBpm: 120,
  });
  assert.ok(typeof aboveThreshold.harmonicCompatibility === 'number');
  assert.ok(aboveThreshold.harmonicCompatibility >= 0 && aboveThreshold.harmonicCompatibility <= 1);
});

test('scoreTransitionPairDetailed() returns every §6.3 quality sub-term as a finite 0..1 number', () => {
  const outgoing = makeAnalysis({ downbeatConfidence: 0.7 });
  const incoming = makeAnalysis({ downbeatConfidence: 0.7 });
  const exit = { sec: 190, score: 0.5 };
  const entry = { sec: 5, score: 0.5 };
  const detail = scoreTransitionPairDetailed({ outgoing, incoming, exit, entry, targetBpm: 121 });
  for (const key of ['phraseAlignment', 'tempoCompatibility', 'vocalSafety', 'downbeatConfidence', 'energyContinuity']) {
    assert.ok(Number.isFinite(detail[key]), `expected ${key} to be a finite number, got ${detail[key]}`);
    assert.ok(detail[key] >= 0 && detail[key] <= 1, `expected ${key} to be in 0..1, got ${detail[key]}`);
  }
  assert.ok(Number.isFinite(detail.total) && detail.total >= 0 && detail.total <= 1);
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
  // Phase 9E (docs/mix-transition-phase9.md §7.2): the sweep now starts at
  // MIX_BARS.preferred (8, not the pre-9E 4) — but this fixture's incoming
  // entry only has ~11.2 playback seconds of forward vocal-free room before
  // firstVocalStartSec (15), so 8/7/6 bars (16/14/12s) don't fit and 5 bars
  // (10s) is the widest that does. See the dedicated
  // "reaches the new preferred 8-bar tier" test below for a fixture with
  // enough forward room to actually land on 8.
  assert.equal(plan.sync.bars, 5);
  assert.equal(plan.sync.beatsPerBar, 4);
  assert.ok(Math.abs(plan.incoming.tempoRatio - 120 / 122) < 1e-9);
  assert.match(plan.incoming.tempoFilter, /^rubberband=tempo=0\.9836$/);
  assert.ok(plan.confidence > 0.5 && plan.confidence <= 1);
  assert.ok(Math.abs(plan.fadeSec - (60 / 120) * 4 * 5) < 1e-6);
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

test('planBeatmixTransition degrades overlap bars when 8 (preferred) does not fit but 4 (minimum) does', () => {
  const { outgoing, incoming } = happyPathTracks();
  // Phase 9E: preferred is now 8 bars (16s @ 120 BPM), minimum is 4 bars
  // (8s). Only the 184s candidate remains, with 9s of room after it
  // (193 - 184): 8 down through 5 bars (16s..10s) don't fit, 4 bars (8s)
  // does — the sweep degrades all the way to the new floor.
  const tightOutgoing = {
    ...outgoing,
    durationSec: 193,
    phrases: { tail: [{ sec: 184, barIndex: 0, score: 0.6, reasons: [] }] },
  };
  const plan = planBeatmixTransition(tightOutgoing, incoming);
  assert.equal(plan.eligible, true);
  assert.equal(plan.sync.bars, 4);
  assert.ok(Math.abs(plan.fadeSec - (60 / 120) * 4 * 4) < 1e-6);
});

test('planBeatmixTransition rejects when no overlap length fits on the incoming side', () => {
  const { outgoing, incoming } = happyPathTracks();
  // Incoming track is only 6s long; the one entry candidate at 4s leaves 2s
  // of room, less than even MIN_OVERLAP_BARS (4 bars = 8s at 120 BPM as of
  // Phase 9E).
  const shortIncoming = {
    ...incoming,
    durationSec: 6,
    firstVocalStartSec: 5,
    phrases: { head: [{ sec: 4, barIndex: 0, score: 0.5, reasons: [] }] },
  };
  const plan = planBeatmixTransition(outgoing, shortIncoming);
  assert.deepEqual(plan.reasons, ['no-overlap-fit']);
});

test('planBeatmixTransition rejects an incompatible meter instead of silently picking one side', () => {
  const { outgoing, incoming } = happyPathTracks();
  const plan = planBeatmixTransition(outgoing, { ...incoming, downbeatGrid: { ...incoming.downbeatGrid, meter: 3 } });
  assert.deepEqual(plan.reasons, ['meter-mismatch']);
});

test('planBeatmixTransition rejects when the tempo filter cannot be built for a non-unity ratio', () => {
  const { outgoing, incoming } = happyPathTracks();
  // ~4.76% deviation: within canTempoMatch()'s marginal tier (ok: true),
  // but beyond atempo's soft-limit-only range — buildTempoFilter() returns
  // filter: null even though match.ok is true.
  const plan = planBeatmixTransition(outgoing, { ...incoming, bpm: 126 }, { tempoBackend: 'atempo' });
  assert.deepEqual(plan.reasons, ['tempo-filter-unavailable']);
});

test('planBeatmixTransition gates the 4-6% marginal tempo tier on transition quality, not just the BPM-confidence minimums', () => {
  const outgoing = makeAnalysis({
    bpm: 120,
    beatConfidence: 0.55, // just above BEAT_CONFIDENCE_MIN
    downbeatConfidence: 0.45, // just above DOWNBEAT_CONFIDENCE_MIN
    durationSec: 200,
    lastVocalEndSec: 180,
    phrasesTail: [{ sec: 184, barIndex: 0, score: 0.1, reasons: [] }],
  });
  const incoming = makeAnalysis({
    bpm: 126, // ~4.76% off 120 — marginal tier
    beatConfidence: 0.55,
    downbeatConfidence: 0.45,
    durationSec: 200,
    firstVocalStartSec: 15,
    phrasesHead: [{ sec: 4, barIndex: 0, score: 0.1, reasons: [] }],
  });
  const plan = planBeatmixTransition(outgoing, incoming); // rubberband: filter builds fine, this only tests the quality gate
  assert.deepEqual(plan.reasons, ['marginal-tempo-low-confidence']);
});

test('planBeatmixTransition allows a marginal tempo match when transition quality is high', () => {
  // Same ~4.76% marginal deviation as the low-confidence case above, but
  // with near-maximal downbeat confidence and phrase alignment — high
  // enough overall quality to clear MARGINAL_TEMPO_MIN_SCORE.
  const outgoing = makeAnalysis({
    bpm: 120,
    beatConfidence: 0.9,
    downbeatConfidence: 0.95,
    durationSec: 200,
    lastVocalEndSec: 180,
    phrasesTail: [{ sec: 184, barIndex: 0, score: 0.95, reasons: [] }],
  });
  const incoming = makeAnalysis({
    bpm: 126,
    beatConfidence: 0.9,
    downbeatConfidence: 0.95,
    durationSec: 200,
    firstVocalStartSec: 15,
    phrasesHead: [{ sec: 4, barIndex: 0, score: 0.95, reasons: [] }],
  });
  const plan = planBeatmixTransition(outgoing, incoming);
  assert.equal(plan.eligible, true);
  assert.ok(Math.abs(plan.incoming.tempoRatio - 120 / 126) < 1e-9);
});

test('planBeatmixTransition converts overlap room to the stretched incoming timeline before choosing bar count', () => {
  const outgoing = makeAnalysis({
    bpm: 124,
    beatConfidence: 0.8,
    downbeatConfidence: 0.7,
    durationSec: 200,
    lastVocalEndSec: 180,
    phrasesTail: [{ sec: 184, barIndex: 0, score: 0.6, reasons: [] }],
  });
  const incoming = makeAnalysis({
    bpm: 120,
    beatConfidence: 0.75,
    downbeatConfidence: 0.65,
    durationSec: 13.7, // 9.7s of *native* room after the entry candidate
    firstVocalStartSec: 15,
    phrasesHead: [{ sec: 4, barIndex: 0, score: 0.5, reasons: [] }],
  });
  const plan = planBeatmixTransition(outgoing, incoming);
  assert.equal(plan.eligible, true);
  // Phase 9E: minimum is now 4 bars (not 2), so the sweep's lowest
  // candidate is 4 bars (~7.74s) / 5 bars (~9.68s), not 3/4. 5 bars fits the
  // native 9.7s room but not the ~9.39s of actual playback time left once
  // incoming plays back sped up by ~3.3% — 4 bars does fit either way.
  assert.equal(plan.sync.bars, 4);
});

test('planBeatmixTransition stretches the incoming entry against its head BPM, not the tail-biased aggregate', () => {
  const outgoing = makeAnalysis({
    bpm: 120,
    beatConfidence: 0.8,
    downbeatConfidence: 0.7,
    durationSec: 200,
    lastVocalEndSec: 180,
    phrasesTail: [{ sec: 184, barIndex: 0, score: 0.6, reasons: [] }],
  });
  const incoming = makeAnalysis({
    bpm: 125, // trackAnalysis.js's aggregate prefers tailBpm — a faster back half
    headBpm: 120, // the actual intro tempo, where the entry point lives
    beatConfidence: 0.75,
    downbeatConfidence: 0.65,
    durationSec: 200,
    firstVocalStartSec: 15,
    phrasesHead: [{ sec: 4, barIndex: 0, score: 0.5, reasons: [] }],
  });
  const plan = planBeatmixTransition(outgoing, incoming);
  assert.equal(plan.eligible, true);
  assert.equal(plan.incoming.nativeBpm, 120);
  assert.equal(plan.incoming.tempoRatio, 1); // headBpm already matches targetBpm exactly
});

test('planBeatmixTransition targets the outgoing tail\'s actual current tempo, not the head BPM it was originally matched to', () => {
  // Simulates a chained beatmix: the outgoing track was itself spawned as
  // an incoming track earlier, stretched to match its own head (120) to a
  // 120 BPM session — so outgoingPlaybackBpm=120, tempoRatio=1 at spawn.
  // Its native tail is 125, and since that spawn-time ratio (1) carries
  // through unchanged for its whole remaining playback, the tail is
  // actually playing at 125 right now, not the 120 it was originally
  // matched against.
  const outgoing = makeAnalysis({
    bpm: 125, // aggregate prefers tailBpm
    headBpm: 120,
    tailBpm: 125,
    beatConfidence: 0.8,
    downbeatConfidence: 0.7,
    durationSec: 200,
    lastVocalEndSec: 180,
    phrasesTail: [{ sec: 184, barIndex: 0, score: 0.6, reasons: [] }],
  });
  const incoming = makeAnalysis({
    bpm: 125,
    beatConfidence: 0.75,
    downbeatConfidence: 0.65,
    durationSec: 200,
    firstVocalStartSec: 15,
    phrasesHead: [{ sec: 4, barIndex: 0, score: 0.5, reasons: [] }],
  });
  const plan = planBeatmixTransition(outgoing, incoming, { outgoingPlaybackBpm: 120 });
  assert.equal(plan.eligible, true);
  assert.equal(plan.targetBpm, 125); // the tail's real current tempo, not the stale 120
});

test('planBeatmixTransition normalizes the outgoing tempo ratio through octaves, not a plain division', () => {
  // outgoingBpm is a doubled misdetection (240 instead of the real ~120);
  // outgoingPlaybackBpm=120 reflects this track already having been
  // correctly session-matched at spawn time. A plain 120/240 division
  // would treat the source as playing at half its real remaining-time
  // rate and could schedule an overlap the source can't actually sustain.
  const outgoing = makeAnalysis({
    bpm: 240,
    headBpm: 240,
    tailBpm: 240,
    beatConfidence: 0.8,
    downbeatConfidence: 0.7,
    durationSec: 200,
    lastVocalEndSec: 180,
    // 5s of native room after the exit — at the correct ratio (~1) this
    // comfortably covers a 4-bar (8s @ 120 BPM) overlap's worth of real
    // time is NOT actually available, so this alone would still gate the
    // bar count; the point of this test is only that the ratio used to
    // convert that room is ~1, not 0.5.
    phrasesTail: [{ sec: 195, barIndex: 0, score: 0.6, reasons: [] }],
  });
  const incoming = makeAnalysis({
    bpm: 122,
    beatConfidence: 0.75,
    downbeatConfidence: 0.65,
    durationSec: 200,
    firstVocalStartSec: 15,
    phrasesHead: [{ sec: 4, barIndex: 0, score: 0.5, reasons: [] }],
  });
  const plan = planBeatmixTransition(outgoing, incoming, {
    outgoingPlaybackBpm: 120,
    minOverlapBars: 2,
  });
  assert.equal(plan.eligible, true);
  // 5s of native room / ratio~1 => ~5s playback room => only 2 bars (4s @
  // 120 BPM) fit, not 4 bars (8s). A naive 120/240=0.5 ratio would have
  // computed 10s of playback room and wrongly allowed 4 bars.
  assert.equal(plan.sync.bars, 2);
});

test('planBeatmixTransition rejects when incoming matches only via octave normalization (bar lengths would not align)', () => {
  // 60 BPM (4s bars) vs a 120 BPM target (2s bars): canTempoMatch()
  // correctly treats these as tempo-compatible (ratio ~1 after octave
  // normalization), but incoming's real downbeats only land on every
  // other computed 2s bar boundary.
  const { outgoing, incoming } = happyPathTracks();
  const plan = planBeatmixTransition(outgoing, { ...incoming, bpm: 60 });
  assert.deepEqual(plan.reasons, ['octave-bar-mismatch']);
});

test('planBeatmixTransition converts the exit prefilter to native-time room for an already-stretched outgoing source', () => {
  const outgoing = makeAnalysis({
    bpm: 125, // native; with outgoingPlaybackBpm=120 this yields ratio 0.96
    beatConfidence: 0.8,
    downbeatConfidence: 0.7,
    durationSec: 200,
    lastVocalEndSec: 190,
    // 3.9 native seconds of room after the exit — below the *unscaled*
    // 4.0s (2 bars @ 120 BPM) minimum, but above the correctly *scaled*
    // 3.84s (4.0 * 0.96) minimum once outgoingRatio is accounted for.
    phrasesTail: [{ sec: 196.1, barIndex: 0, score: 0.6, reasons: [] }],
  });
  const incoming = makeAnalysis({
    bpm: 122,
    beatConfidence: 0.75,
    downbeatConfidence: 0.65,
    durationSec: 200,
    firstVocalStartSec: 15,
    phrasesHead: [{ sec: 4, barIndex: 0, score: 0.5, reasons: [] }],
  });
  const plan = planBeatmixTransition(outgoing, incoming, {
    outgoingPlaybackBpm: 120,
    minOverlapBars: 2,
  });
  assert.equal(plan.eligible, true);
  assert.equal(plan.sync.bars, 2);
});

test('planBeatmixTransition bounds an instrumental head\'s safety by the analyzed window, not infinity', () => {
  const outgoing = makeAnalysis({
    bpm: 120,
    beatConfidence: 0.8,
    downbeatConfidence: 0.7,
    durationSec: 200,
    lastVocalEndSec: 180,
    phrasesTail: [{ sec: 184, barIndex: 0, score: 0.6, reasons: [] }],
  });
  const incoming = makeAnalysis({
    bpm: 122,
    beatConfidence: 0.75,
    downbeatConfidence: 0.65,
    durationSec: 200,
    firstVocalStartSec: null, // no vocals found within the analyzed 30s head window
    // Only 2s of headroom before the analyzed window ends at 30s — not
    // enough for even MIN_OVERLAP_BARS, even though nothing here proves
    // vocals don't start right after 30s.
    phrasesHead: [{ sec: 28, barIndex: 0, score: 0.9, reasons: [] }],
  });
  const plan = planBeatmixTransition(outgoing, incoming);
  assert.deepEqual(plan.reasons, ['no-overlap-fit']);
});

test('planBeatmixTransition rejects when an entry candidate has almost no forward vocal-free room, even though the entry point itself is safe', () => {
  const outgoing = makeAnalysis({
    bpm: 120,
    beatConfidence: 0.8,
    downbeatConfidence: 0.7,
    durationSec: 200,
    lastVocalEndSec: 180,
    phrasesTail: [{ sec: 184, barIndex: 0, score: 0.6, reasons: [] }],
  });
  const incoming = makeAnalysis({
    bpm: 122,
    beatConfidence: 0.75,
    downbeatConfidence: 0.65,
    durationSec: 200,
    firstVocalStartSec: 15,
    // Only 2s of forward room before singing starts — not enough for even
    // MIN_OVERLAP_BARS (2 bars = 4s at 120 BPM), despite 13s itself passing
    // the point-only "is entrySec before firstVocalStartSec" check.
    phrasesHead: [{ sec: 13, barIndex: 0, score: 0.9, reasons: [] }],
  });
  const plan = planBeatmixTransition(outgoing, incoming);
  assert.deepEqual(plan.reasons, ['no-overlap-fit']);
});

test('planBeatmixTransition rejects when an entry candidate sits too close to the end of a vocal gap', () => {
  const outgoing = makeAnalysis({
    bpm: 120,
    beatConfidence: 0.8,
    downbeatConfidence: 0.7,
    durationSec: 200,
    lastVocalEndSec: 180,
    phrasesTail: [{ sec: 184, barIndex: 0, score: 0.6, reasons: [] }],
  });
  const incoming = makeAnalysis({
    bpm: 122,
    beatConfidence: 0.75,
    downbeatConfidence: 0.65,
    durationSec: 200,
    firstVocalStartSec: 5,
    headVocalGaps: [{ startSec: 20, endSec: 22 }],
    phrasesHead: [{ sec: 21.8, barIndex: 0, score: 0.9, reasons: [] }], // 0.2s before the gap closes
  });
  const plan = planBeatmixTransition(outgoing, incoming);
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

test('planPhraseCrossfade rejects when neither side has real phrase data (does not fall back to bare downbeats)', () => {
  const outgoing = makeAnalysis({ durationSec: 200, lastVocalEndSec: 180 });
  const incoming = makeAnalysis({ firstVocalStartSec: 10 });
  assert.deepEqual(planPhraseCrossfade(outgoing, incoming).reasons, ['no-phrase-data']);
});

test('planPhraseCrossfade rejects on no-exit-candidate when phrase data exists but nothing clears the vocal-safe/overlap filter', () => {
  const outgoing = makeAnalysis({
    durationSec: 10,
    lastVocalEndSec: 9.5, // leaves no room for even minOverlapSec
    phrasesTail: [{ sec: 9.6, barIndex: 0, score: 0.5, reasons: [] }],
  });
  const incoming = makeAnalysis({
    firstVocalStartSec: 10,
    phrasesHead: [{ sec: 3, barIndex: 0, score: 0.5, reasons: [] }],
  });
  assert.deepEqual(planPhraseCrossfade(outgoing, incoming).reasons, ['no-exit-candidate']);
});

test('planPhraseCrossfade skips an infeasible top-scored entry (too close to the incoming source end) and picks a feasible one instead', () => {
  const outgoing = makeAnalysis({
    durationSec: 200,
    lastVocalEndSec: 180,
    phrasesTail: [{ sec: 185, barIndex: 0, score: 0.7, reasons: [] }],
  });
  const incoming = makeAnalysis({
    durationSec: 10, // short incoming source
    firstVocalStartSec: 8,
    phrasesHead: [
      { sec: 7.5, barIndex: 0, score: 0.9, reasons: [] }, // highest score, but only 0.5s before vocals start
      { sec: 2, barIndex: 1, score: 0.4, reasons: [] }, // lower score, but 6s of clean forward room
    ],
  });
  const plan = planPhraseCrossfade(outgoing, incoming);
  assert.equal(plan.eligible, true);
  assert.equal(plan.entrySec, 2);
  assert.equal(plan.fadeSec, 6);
});

test('planPhraseCrossfade converts outgoing room for an already-stretched source', () => {
  // outgoingBpm=100 with outgoingPlaybackBpm=105 yields ratio 1.05: 6
  // native seconds of room after the exit is really only ~5.71 playback
  // seconds, not the naive 6 a native-only calculation would compute.
  const outgoing = makeAnalysis({
    bpm: 100,
    durationSec: 200,
    lastVocalEndSec: 190,
    phrasesTail: [{ sec: 194, barIndex: 0, score: 0.7, reasons: [] }],
  });
  const incoming = makeAnalysis({
    firstVocalStartSec: 20,
    phrasesHead: [{ sec: 2, barIndex: 0, score: 0.5, reasons: [] }],
  });
  const plan = planPhraseCrossfade(outgoing, incoming, { outgoingPlaybackBpm: 105 });
  assert.equal(plan.eligible, true);
  assert.ok(Math.abs(plan.fadeSec - 6 / 1.05) < 1e-9);
});

test('planPhraseCrossfade rejects when no candidate pair has enough incoming-source or vocal-free room', () => {
  const outgoing = makeAnalysis({
    durationSec: 200,
    lastVocalEndSec: 180,
    phrasesTail: [{ sec: 185, barIndex: 0, score: 0.7, reasons: [] }],
  });
  const incoming = makeAnalysis({
    durationSec: 10,
    firstVocalStartSec: 8,
    phrasesHead: [{ sec: 7.5, barIndex: 0, score: 0.9, reasons: [] }], // only 0.5s of forward room, and the only candidate
  });
  assert.deepEqual(planPhraseCrossfade(outgoing, incoming).reasons, ['no-overlap-fit']);
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
  assert.deepEqual(plan.fallbackFrom, ['beat-confidence-low', 'no-phrase-data']);
});

// --- Phase 8 (docs/mix-transition-phase8.md): vocal-safety relaxation flags ---

test('the happy-path fixture is byte-for-byte unchanged with the new Phase 8 flags left at their defaults', () => {
  // Every test above this point already exercises the default (unrelaxed)
  // behavior implicitly — this pins the exact happy-path plan shape as an
  // explicit regression guard specifically against the requireExitVocalSafe/
  // requireEntryForwardSafe/stemAware options existing at all.
  const { outgoing, incoming } = happyPathTracks();
  const plan = planBeatmixTransition(outgoing, incoming);
  assert.equal(plan.eligible, true);
  assert.equal(plan.mode, 'beatmix');
  assert.equal(plan.outgoing.exitStartSec, 184);
});

test('findExitCandidates({requireVocalSafe:false}) keeps a mid-vocal candidate that the default (true) drops', () => {
  const outgoing = makeAnalysis({
    durationSec: 200,
    lastVocalEndSec: 190,
    phrasesTail: [{ sec: 160, barIndex: 0, score: 0.5, reasons: [] }],
  });
  assert.deepEqual(findExitCandidates(outgoing), []); // 160 < lastVocalEndSec 190 -> filtered
  const relaxed = findExitCandidates(outgoing, { requireVocalSafe: false });
  assert.equal(relaxed.length, 1);
  assert.equal(relaxed[0].sec, 160);
});

test('findExitCandidates({requireVocalSafe:false}) still requires hasVocalAnalysis() (a real reading, not failed analysis)', () => {
  const outgoing = makeAnalysis({
    durationSec: 200,
    lastVocalEndSec: 190,
    phrasesTail: [{ sec: 160, barIndex: 0, score: 0.5, reasons: [] }],
  });
  outgoing.analysisSource = 'none'; // failed analysis, not "verifiably no vocal"
  assert.deepEqual(findExitCandidates(outgoing, { requireVocalSafe: false }), []);
});

test('scoreTransitionPair({stemAware:true}) drops the exit-margin term but keeps the entry-margin term', () => {
  const outgoing = makeAnalysis({ durationSec: 200, lastVocalEndSec: 190 });
  const incoming = makeAnalysis({ firstVocalStartSec: 30 });
  const exit = { sec: 160, barIndex: 0, score: 0 }; // 30s before lastVocalEndSec -> exit margin would be 0
  const entry = { sec: 4, barIndex: 0, score: 0 }; // well before firstVocalStartSec -> full entry credit
  const plain = scoreTransitionPair({ outgoing, incoming, exit, entry, targetBpm: 120 });
  const stemAware = scoreTransitionPair({ outgoing, incoming, exit, entry, targetBpm: 120, stemAware: true });
  assert.ok(stemAware > plain, `expected dropping the exit-margin penalty to raise the score (plain=${plain}, stemAware=${stemAware})`);
});

test('planBeatmixTransition({requireExitVocalSafe:false, requireEntryForwardSafe:false, stemAware:true}) accepts what the default rejects, matching planStemTransition()', () => {
  const outgoing = makeAnalysis({
    durationSec: 200,
    lastVocalEndSec: 190,
    phrasesTail: [{ sec: 160, barIndex: 0, score: 0.5, reasons: ['bar-multiple'] }],
  });
  const incoming = makeAnalysis({ firstVocalStartSec: 20, headDownbeats: [4, 6, 8] });

  const plain = planBeatmixTransition(outgoing, incoming);
  assert.equal(plain.eligible, false);

  const relaxed = planBeatmixTransition(outgoing, incoming, {
    requireExitVocalSafe: false,
    requireEntryForwardSafe: false,
    stemAware: true,
  });
  assert.equal(relaxed.eligible, true);
  assert.equal(relaxed.outgoing.exitStartSec, 160);
  assert.ok(Number.isFinite(relaxed.outgoing.tempoRatioApplied));
});

test('requireEntryForwardSafe:false does NOT disable findEntryCandidates()\'s own entry-point vocal-safety check', () => {
  // CodeRabbit: "Line 88 disables requireEntryForwardSafe. This permits stem
  // plans that the Phase 8 contract requires to reject." findEntryCandidates()
  // itself (called with no vocal-safety-related option at all, see its own
  // isVocalSafe() closure) unconditionally filters out any candidate whose
  // OWN position is mid-vocal — that check is entirely independent of
  // requireEntryForwardSafe. What requireEntryForwardSafe actually gates is
  // the separate, more conservative entryForwardSafeSec() cap on how much
  // vocal-free room follows the (already vocal-safe) entry point — see its
  // docstring. Isolated here from the exit side (requireExitVocalSafe stays
  // at its default true; only requireEntryForwardSafe is relaxed) to pin
  // down exactly which check does what.
  const outgoing = happyPathTracks().outgoing; // already vocal-safe at its exit — not the thing under test
  const incoming = makeAnalysis({
    bpm: 120,
    beatConfidence: 0.75,
    downbeatConfidence: 0.65,
    durationSec: 200,
    firstVocalStartSec: 1, // singing starts almost immediately...
    headVocalGaps: [{ startSec: 3, endSec: 4 }], // ...then a brief 1s gap...
    headDownbeats: [3.5], // ...and the only candidate sits inside that gap: itself
    // vocal-safe (per findEntryCandidates), but with only 0.5s of room
    // before vocals resume at 4 — nowhere near forward-safe for even the
    // minimum 4-bar (8s at 120 BPM, as of Phase 9E) overlap this pair
    // would otherwise fit.
  });

  const entryCandidates = findEntryCandidates(incoming);
  assert.deepEqual(entryCandidates.map((c) => c.sec), [3.5],
    'the entry point itself is vocal-safe (inside the gap) and must still be offered as a candidate');

  const strict = planBeatmixTransition(outgoing, incoming);
  assert.equal(strict.eligible, false,
    'the default (requireEntryForwardSafe:true) must still reject: no bar count fits within the 0.5s forward-safe room');

  const relaxed = planBeatmixTransition(outgoing, incoming, { requireEntryForwardSafe: false });
  assert.equal(relaxed.eligible, true,
    'relaxing only requireEntryForwardSafe accepts the same (still entry-point-vocal-safe) candidate');
  assert.equal(relaxed.incoming.entrySec, 3.5);
});

// --- Phase 9E (docs/mix-transition-phase9.md §7): Long Mix Zone -----------

test('MIX_BARS matches §7.2 exactly, and BEATMIX_OVERLAP_BARS/MIN_OVERLAP_BARS mirror its preferred/minimum for existing callers', () => {
  assert.deepEqual(MIX_BARS, { preferred: 8, minimum: 4, extended: 16 });
  assert.equal(BEATMIX_OVERLAP_BARS, MIX_BARS.preferred);
  assert.equal(MIN_OVERLAP_BARS, MIX_BARS.minimum);
});

/** A pair with ample room on both sides at every tier (16/8/4 bars all
 * physically fit), so which tier actually gets used is driven purely by
 * extendedTierEligible()'s three §7.2 gates, not by room constraints. */
function longMixZoneTracks({
  outgoingDownbeatConfidence = 0.9,
  incomingDownbeatConfidence = 0.9,
  outgoingVocalConfidence = 0.9,
  incomingVocalConfidence = 0.9,
} = {}) {
  const outgoing = makeAnalysis({
    bpm: 120,
    beatConfidence: 0.9,
    downbeatConfidence: outgoingDownbeatConfidence,
    vocalConfidence: outgoingVocalConfidence,
    durationSec: 260,
    lastVocalEndSec: 200, // irrelevant once requireExitVocalSafe:false, but a real reading either way
    phrasesTail: [{ sec: 200, barIndex: 0, score: 0.6, reasons: ['bar-multiple'] }], // 60s of native room after exit
  });
  const incoming = makeAnalysis({
    bpm: 120,
    beatConfidence: 0.9,
    downbeatConfidence: incomingDownbeatConfidence,
    vocalConfidence: incomingVocalConfidence,
    durationSec: 260,
    firstVocalStartSec: 240, // irrelevant once requireEntryForwardSafe:false
    phrasesHead: [{ sec: 4, barIndex: 0, score: 0.6, reasons: ['bar-multiple'] }], // ~256s of room after entry
  });
  return { outgoing, incoming };
}

/** stemAware:true plus the vocal-safety relaxations planStemTransition() itself
 * always passes (see stemTransition.js's planStemTransition()) — isolates the
 * extended-tier gate from the ordinary vocal-safe candidate search. */
const STEM_MIX_OPTIONS = { stemAware: true, requireExitVocalSafe: false, requireEntryForwardSafe: false };

test('planBeatmixTransition reaches the extended 16-bar tier when stemAware, phrase confidence, and vocal confidence all clear the §7.2 gates', () => {
  const { outgoing, incoming } = longMixZoneTracks();
  const plan = planBeatmixTransition(outgoing, incoming, STEM_MIX_OPTIONS);
  assert.equal(plan.eligible, true);
  assert.equal(plan.sync.bars, MIX_BARS.extended);
  assert.ok(Math.abs(plan.fadeSec - (60 / 120) * 4 * MIX_BARS.extended) < 1e-6);
});

test('planBeatmixTransition never reaches the extended tier without stemAware, even with ample room and high confidence', () => {
  // §7.2's "stem available" gate: a plain (non-stem) beatmix call never
  // claims stems are cached, so it must cap at MIX_BARS.preferred (8) no
  // matter how high phrase/vocal confidence are — see
  // extendedTierEligible()'s docstring for why this is intentional, not a
  // missed case.
  const { outgoing, incoming } = longMixZoneTracks();
  // requireExitVocalSafe/requireEntryForwardSafe stay at their (stricter)
  // defaults here since a plain, non-stem plan has no per-stem vocal
  // envelope to fall back on — lastVocalEndSec/firstVocalStartSec are set
  // far enough from the candidates for this pair to still be vocal-safe.
  const plan = planBeatmixTransition(outgoing, incoming);
  assert.equal(plan.eligible, true);
  assert.equal(plan.sync.bars, MIX_BARS.preferred);
});

test('planBeatmixTransition falls back to the preferred 8-bar tier when phrase confidence is not high enough for the extended tier', () => {
  const { outgoing, incoming } = longMixZoneTracks({
    // Both sides still clear DOWNBEAT_CONFIDENCE_MIN (tier-1 eligibility)
    // but not EXTENDED_PHRASE_CONFIDENCE_MIN.
    outgoingDownbeatConfidence: EXTENDED_PHRASE_CONFIDENCE_MIN - 0.05,
  });
  const plan = planBeatmixTransition(outgoing, incoming, STEM_MIX_OPTIONS);
  assert.equal(plan.eligible, true);
  assert.equal(plan.sync.bars, MIX_BARS.preferred);
});

test('planBeatmixTransition falls back to the preferred 8-bar tier when the vocal plan is not usable enough for the extended tier', () => {
  const { outgoing, incoming } = longMixZoneTracks({
    // classifyVocalEnvelope() (vocalActivity.js) never reports exactly this
    // mid-tier value in practice (its own output is 0/0.5/0.85), but any
    // reading below EXTENDED_VOCAL_CONFIDENCE_MIN must fail the gate the
    // same way — this pins the threshold itself, not a specific real value.
    incomingVocalConfidence: EXTENDED_VOCAL_CONFIDENCE_MIN - 0.05,
  });
  const plan = planBeatmixTransition(outgoing, incoming, STEM_MIX_OPTIONS);
  assert.equal(plan.eligible, true);
  assert.equal(plan.sync.bars, MIX_BARS.preferred);
});

test('planBeatmixTransition degrades from the extended tier down through the dense sweep when 16 bars does not fit but a lower count does', () => {
  // Same eligibility as the "reaches 16" test above, but room after the
  // exit is capped so only 10 bars (20s) fit, not 16 (32s) or higher — the
  // search must still land on the best FITTING count, not reject outright
  // just because the extended tier's own ceiling doesn't fit.
  const { incoming } = longMixZoneTracks();
  const outgoing = makeAnalysis({
    bpm: 120,
    beatConfidence: 0.9,
    downbeatConfidence: 0.9,
    vocalConfidence: 0.9,
    durationSec: 220,
    lastVocalEndSec: 200,
    phrasesTail: [{ sec: 200, barIndex: 0, score: 0.6, reasons: ['bar-multiple'] }], // 20s of native room after exit
  });
  const plan = planBeatmixTransition(outgoing, incoming, STEM_MIX_OPTIONS);
  assert.equal(plan.eligible, true);
  assert.equal(plan.sync.bars, 10);
});

test('extendedTierEligible-equivalent gate is symmetric: low confidence on the OUTGOING side alone also blocks the extended tier', () => {
  const { outgoing, incoming } = longMixZoneTracks({ outgoingVocalConfidence: 0.5 });
  const plan = planBeatmixTransition(outgoing, incoming, STEM_MIX_OPTIONS);
  assert.equal(plan.eligible, true);
  assert.equal(plan.sync.bars, MIX_BARS.preferred);
});

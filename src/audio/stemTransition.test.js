import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  planStemTransition, buildStemEnvelopes, buildMixZone, buildTransitionEvents,
  DEFAULT_VOCAL_CROSSOVER_MARGIN_SEC,
} from './stemTransition.js';
import { planBeatmixTransition } from './beatmixTransition.js';

function richOutgoing(overrides = {}) {
  return {
    analysisSource: 'demucs',
    durationSec: 200,
    bpm: 120,
    tailBpm: 120,
    beatConfidence: 0.8,
    downbeatGrid: { confidence: 0.8, meter: 4, tail: { downbeatsSec: [150, 152, 154, 156, 158, 160] } },
    lastVocalEndSec: 165,
    tailKey: '8B',
    harmonicConfidence: 0.8,
    lastRms: -14,
    phrases: { tail: [{ sec: 158, barIndex: 0, score: 0.9, reasons: ['bar-multiple'] }] },
    ...overrides,
  };
}

function richIncoming(overrides = {}) {
  return {
    analysisSource: 'demucs',
    durationSec: 200,
    bpm: 120,
    headBpm: 120,
    beatConfidence: 0.8,
    downbeatGrid: { confidence: 0.8, meter: 4, head: { downbeatsSec: [4, 6, 8] } },
    firstVocalStartSec: 20,
    headVocalGaps: [],
    headKey: '8B',
    harmonicConfidence: 0.8,
    lastRms: -14,
    phrases: { head: [{ sec: 4, barIndex: 0, score: 0.9, reasons: ['bar-multiple'] }] },
    ...overrides,
  };
}

test('planStemTransition accepts a mid-vocal outgoing exit that plain planBeatmixTransition rejects', () => {
  // The actual new capability Phase 8 adds: exit at 158, but the outgoing
  // track's vocal doesn't end until 165 (7s after the exit point) — plain
  // beatmix's findExitCandidates() would have filtered this candidate out
  // entirely (see beatmixTransition.js's own vocalFloor filter).
  const outgoing = richOutgoing();
  const incoming = richIncoming();

  const plain = planBeatmixTransition(outgoing, incoming);
  assert.equal(plain.eligible, false);
  assert.deepEqual(plain.reasons, ['no-exit-candidate']);

  const stemPlan = planStemTransition(outgoing, incoming);
  assert.equal(stemPlan.eligible, true);
  assert.equal(stemPlan.mode, 'stem-mix');
  assert.equal(stemPlan.outgoing.exitStartSec, 158);
});

test('planStemTransition rejects a technically-nonzero but near-instant inVocal fade (Codex review, PR #48, round 1)', () => {
  // richOutgoing()/richIncoming() land this pair on the preferred (8-bar,
  // 16s) tier. lastVocalEndSec is set so the outgoing vocal tail leaves
  // only a sliver of a second for inVocal to fade in (well below
  // MIN_MEANINGFUL_INVOCAL_FADE_SEC) — a technically-nonzero fade the OLD
  // `> 0` check would have accepted as eligible.
  const outgoing = richOutgoing({ lastVocalEndSec: 173.7 }); // exit at 158, 15.7s of native vocal tail remains
  const incoming = richIncoming();

  const stemPlan = planStemTransition(outgoing, incoming);
  assert.equal(stemPlan.eligible, false);
  assert.deepEqual(stemPlan.reasons, ['stem-mix-no-invocal-fade-room']);
});

test('planStemTransition retries other exit candidates before rejecting the plan outright when the strict-score winner leaves no usable inVocal fade (Codex review, PR #48, round 5)', () => {
  // Two exit candidates: sec 158 (high phrase score 0.9, wins the strict-
  // score race outright) but its 15.7s outgoing vocal tail leaves no room
  // for inVocal to fade in — the same fixture as the round-1 test above.
  // sec 172 (low phrase score 0.1, loses the strict-score race) has only a
  // 1.7s tail, leaving 14.1s of usable inVocal fade window. Before this fix,
  // the fade-room check ran once, post-hoc, against only the pair the
  // search already committed to (sec 158) — rejecting the whole plan even
  // though sec 172 would have produced a perfectly usable envelope.
  const outgoing = richOutgoing({
    lastVocalEndSec: 173.7,
    phrases: {
      tail: [
        { sec: 158, barIndex: 0, score: 0.9, reasons: ['bar-multiple'] },
        { sec: 172, barIndex: 0, score: 0.1, reasons: ['bar-multiple'] },
      ],
    },
  });
  const incoming = richIncoming();

  const stemPlan = planStemTransition(outgoing, incoming);
  assert.equal(stemPlan.eligible, true,
    'expected the search to fall through to the sec-172 pair instead of rejecting the whole plan over sec 158 alone');
  assert.equal(stemPlan.outgoing.exitStartSec, 172);
  assert.ok(stemPlan.stems.inVocal.fadeSec >= 0.5,
    `expected a usable inVocal fade window, got ${stemPlan.stems.inVocal.fadeSec}`);
});

test('planStemTransition still requires everything plain beatmix requires except the outgoing vocal-safety window', () => {
  // Tempo/downbeat/meter gating must be untouched — stem-mix only widens
  // the vocal-clash axis, never weakens tempo sync (docs/mix-transition-
  // phase8.md's redefinition of 禁止5, 禁止1 preserved).
  const outgoing = richOutgoing({ beatConfidence: 0.1 }); // below BEAT_CONFIDENCE_MIN
  const incoming = richIncoming();
  const stemPlan = planStemTransition(outgoing, incoming);
  assert.equal(stemPlan.eligible, false);
  assert.deepEqual(stemPlan.reasons, ['beat-confidence-low']);
});

test('planStemTransition still requires the incoming entry itself to be vocal-safe (scope cut: only the outgoing side is relaxed)', () => {
  const outgoing = richOutgoing();
  // Incoming's only head candidate (sec: 4) now sits inside active vocal —
  // findEntryCandidates() must still reject it even under planStemTransition.
  const incoming = richIncoming({ firstVocalStartSec: 1 });
  const stemPlan = planStemTransition(outgoing, incoming);
  assert.equal(stemPlan.eligible, false);
  assert.deepEqual(stemPlan.reasons, ['no-entry-candidate']);
});

test('planStemTransition returns null (no eligible flag confusion) when vocal analysis itself failed', () => {
  const outgoing = richOutgoing({ analysisSource: 'none', lastVocalEndSec: null });
  const incoming = richIncoming();
  const stemPlan = planStemTransition(outgoing, incoming);
  assert.equal(stemPlan.eligible, false);
  assert.deepEqual(stemPlan.reasons, ['no-exit-candidate']);
});

test('buildStemEnvelopes: outVocal fades out over exactly the remaining native vocal tail, converted to playback seconds', () => {
  const outgoing = richOutgoing(); // lastVocalEndSec 165
  const plan = {
    fadeSec: 8,
    gain: { curve: 'equal-power' },
    outgoing: { exitStartSec: 158, tempoRatioApplied: 1 },
  };
  const stems = buildStemEnvelopes(outgoing, plan);
  assert.equal(stems.outVocal.fadeSec, 7); // 165 - 158, ratio 1
  assert.equal(stems.outVocal.startOffsetSec, 0);
  assert.equal(stems.outInstrumental.fadeSec, 8);
  assert.equal(stems.outInstrumental.startOffsetSec, 0);
  assert.equal(stems.inInstrumental.fadeSec, 8);
  assert.equal(stems.inInstrumental.startOffsetSec, 0);
  assert.equal(stems.inVocal.startOffsetSec, 7 + DEFAULT_VOCAL_CROSSOVER_MARGIN_SEC);
  assert.equal(stems.inVocal.fadeSec, 8 - (7 + DEFAULT_VOCAL_CROSSOVER_MARGIN_SEC));
});

test('buildStemEnvelopes: outVocal fadeSec is 0 (not negative) when the exit point is already past the last vocal frame', () => {
  // Reproduces today's exact pre-Phase-8 "already vocal-safe" case.
  const outgoing = richOutgoing({ lastVocalEndSec: 100 }); // well before the exit point
  const plan = {
    fadeSec: 8,
    gain: { curve: 'equal-power' },
    outgoing: { exitStartSec: 158, tempoRatioApplied: 1 },
  };
  const stems = buildStemEnvelopes(outgoing, plan);
  assert.equal(stems.outVocal.fadeSec, 0);
  assert.equal(stems.inVocal.startOffsetSec, DEFAULT_VOCAL_CROSSOVER_MARGIN_SEC);
});

test('buildStemEnvelopes: outVocal tail is converted from native to playback seconds via tempoRatioApplied', () => {
  const outgoing = richOutgoing({ lastVocalEndSec: 172 }); // 14 native seconds of tail past the exit point
  const plan = {
    fadeSec: 8,
    gain: { curve: 'equal-power' },
    // A stretched (2x) outgoing means 14 native seconds only takes 7 playback seconds.
    outgoing: { exitStartSec: 158, tempoRatioApplied: 2 },
  };
  const stems = buildStemEnvelopes(outgoing, plan);
  assert.equal(stems.outVocal.fadeSec, 7);
});

// --- Phase 9G §9.1/9.2: TransitionPlan v3 (mixZone/events) -------------

test('buildMixZone expresses the overlap window in bar/tempo terms', () => {
  const plan = {
    fadeSec: 16,
    outgoing: { exitStartSec: 182.4 },
    sync: { bars: 8, beatsPerBar: 4 },
    targetBpm: 120,
  };
  assert.deepEqual(buildMixZone(plan), {
    startSec: 182.4, durationSec: 16, bars: 8, beatsPerBar: 4, targetBpm: 120,
  });
});

test('buildMixZone fills missing fields with null rather than throwing on a bare/legacy plan', () => {
  assert.deepEqual(buildMixZone({}), {
    startSec: null, durationSec: null, bars: null, beatsPerBar: null, targetBpm: null,
  });
});

test('buildTransitionEvents converts each stem envelope timestamp to its bar position, sorted ascending', () => {
  // 120 BPM, 4 beats/bar -> barSec = 2s/bar.
  const plan = { sync: { bars: 8, beatsPerBar: 4 }, targetBpm: 120, eq: { swapBar: 4 } };
  const stems = {
    inInstrumental: { startOffsetSec: 0 },
    outVocal: { startOffsetSec: 0, fadeSec: 4 }, // reaches silence at 4s -> bar 2
    inVocal: { startOffsetSec: 6 }, // bar 3
  };
  const events = buildTransitionEvents(plan, stems);
  assert.deepEqual(events, [
    { bar: 0, action: 'incoming-instrumental-start' },
    { bar: 2, action: 'outgoing-vocal-release' },
    { bar: 3, action: 'incoming-vocal-handoff' },
    { bar: 4, action: 'bass-swap' },
  ]);
});

test('buildTransitionEvents omits bass-swap when the plan has no eq.swapBar (e.g. a non-beatmix caller)', () => {
  const plan = { sync: { bars: 8, beatsPerBar: 4 }, targetBpm: 120 };
  const stems = {
    inInstrumental: { startOffsetSec: 0 },
    outVocal: { startOffsetSec: 0, fadeSec: 0 },
    inVocal: { startOffsetSec: 0 },
  };
  const events = buildTransitionEvents(plan, stems);
  assert.ok(!events.some((e) => e.action === 'bass-swap'));
});

test('buildTransitionEvents returns an empty schedule when the plan has no bar-clock data (missing sync/targetBpm)', () => {
  const stems = {
    inInstrumental: { startOffsetSec: 0 },
    outVocal: { startOffsetSec: 0, fadeSec: 4 },
    inVocal: { startOffsetSec: 6 },
  };
  assert.deepEqual(buildTransitionEvents({}, stems), []);
  assert.deepEqual(buildTransitionEvents({ sync: { beatsPerBar: 4 } }, stems), []); // targetBpm missing
});

test('planStemTransition attaches a populated mixZone/events schedule to an eligible plan', () => {
  const outgoing = richOutgoing();
  const incoming = richIncoming();
  const stemPlan = planStemTransition(outgoing, incoming);
  assert.equal(stemPlan.eligible, true);
  assert.equal(stemPlan.mixZone.bars, stemPlan.sync.bars);
  assert.equal(stemPlan.mixZone.startSec, stemPlan.outgoing.exitStartSec);
  assert.ok(stemPlan.events.length > 0, 'expected at least one scheduled bar-event');
  assert.ok(
    stemPlan.events.every((e, i) => i === 0 || e.bar >= stemPlan.events[i - 1].bar),
    'expected events sorted ascending by bar',
  );
});

test('buildStemEnvelopes clamps inVocal to a zero-length window (not negative) when the vocal tail leaves no room at all', () => {
  const outgoing = richOutgoing({ lastVocalEndSec: 500 }); // far past the whole overlap window
  const plan = {
    fadeSec: 8,
    gain: { curve: 'equal-power' },
    outgoing: { exitStartSec: 158, tempoRatioApplied: 1 },
  };
  const stems = buildStemEnvelopes(outgoing, plan);
  assert.equal(stems.outVocal.fadeSec, 8); // clamped to the full window
  assert.equal(stems.inVocal.startOffsetSec, 8); // clamped, never exceeds fadeSec
  assert.equal(stems.inVocal.fadeSec, 0);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rankTransitionCandidates, transitionModeBonus } from './transitionCandidates.js';

function makeAnalysis({
  bpm = 120,
  headBpm = null,
  beatConfidence = 0.7,
  downbeatMeter = 4,
  downbeatConfidence = 0.6,
  durationSec = 200,
  lastVocalEndSec = null,
  firstVocalStartSec = null,
  phrasesTail = null,
  phrasesHead = null,
  harmonicConfidence = 0,
  analysisSource = 'demucs',
} = {}) {
  return {
    bpm,
    headBpm,
    beatConfidence,
    durationSec,
    downbeatGrid: {
      meter: downbeatMeter,
      confidence: downbeatConfidence,
      head: { downbeatsSec: [] },
      tail: { downbeatsSec: [] },
    },
    phrases: { head: phrasesHead ?? [], tail: phrasesTail ?? [] },
    lastVocalEndSec,
    firstVocalStartSec,
    harmonicConfidence,
    analysisSource,
  };
}

// --- rankTransitionCandidates: the fix must actually change the winner ----
//
// planPhraseCrossfade()'s own `confidence` used to be just `phraseAlignment`
// — tier 2 never scores tempo sync or downbeat alignment at all. Comparing
// that directly against beatmix's six-term weighted confidence during
// ranking let a clean phrase match (phraseAlignment: 1) beat a genuinely
// strong beatmix candidate purely because tier 2's score wasn't penalized
// for having no tempo sync whatsoever — the exact thing beatmix's
// tempoCompatibility/downbeatConfidence terms exist to credit.
// planPhraseCrossfade() now computes its own `confidence` as the full
// weighted comparable score directly (charging 0, not excluding, for the
// tempoCompatibility/downbeatConfidence terms it structurally lacks), so
// there is no separate post-hoc correction to unit-test here anymore — see
// beatmixTransition.test.js for direct coverage of the search itself.

test('rankTransitionCandidates: a genuinely well-synced beatmix candidate beats a phrase-crossfade candidate whose confidence is inflated by skipping the tempo-sync penalty', () => {
  const outgoing = makeAnalysis({
    bpm: 120,
    beatConfidence: 0.6,
    downbeatConfidence: 0.5,
    durationSec: 200,
    lastVocalEndSec: 180,
    phrasesTail: [
      { sec: 184, barIndex: 0, score: 1.0, reasons: ['bar-multiple'] },
    ],
  });
  const incoming = makeAnalysis({
    bpm: 124,
    headBpm: 124,
    beatConfidence: 0.55,
    downbeatConfidence: 0.45,
    durationSec: 200,
    firstVocalStartSec: 15,
    phrasesHead: [
      { sec: 4, barIndex: 0, score: 1.0, reasons: ['bar-multiple'] },
    ],
  });

  // Real planning for both modes runs against this fixture. beatmix is
  // genuinely eligible with a real confidence of ~0.772 (rank ~0.822 with
  // its +0.05 bonus) — a slight tempo mismatch (120 vs 124 BPM) and modest
  // downbeat confidence keep it below 1, exactly what its weighted-average
  // scoring is supposed to do. phrase-crossfade shares the same clean phrase
  // boundary (score 1.0 on both sides), but its own confidence is now the
  // full weighted comparable score — ~0.571 (rank ~0.591 with its +0.02
  // bonus), charged for having no tempo/downbeat terms at all — rather than
  // the pre-fix raw phraseAlignment of 1 (rank 1.02), which always won
  // despite never even attempting tempo sync. Confirmed by direct
  // computation.
  const { candidates, selectedPlan, plans } = rankTransitionCandidates(outgoing, incoming, {
    outgoingPlaybackBpm: 120,
    tempoBackend: 'rubberband',
    stemsAvailable: false,
  });

  assert.equal(candidates.beatmix.eligible, true, 'expected beatmix to be genuinely eligible on this fixture');
  assert.equal(candidates.phraseCrossfade.eligible, true, 'expected phrase-crossfade to be genuinely eligible on this fixture');
  // No override — the Candidate struct's score is the plan's own confidence,
  // which is already comparable by the time it reaches the ranker.
  assert.equal(candidates.phraseCrossfade.score, plans.phraseCrossfade.confidence);
  assert.ok(candidates.phraseCrossfade.score < 1,
    `expected phrase-crossfade's own confidence to be charged for its missing tempo/downbeat terms, got ${candidates.phraseCrossfade.score}`);
  assert.ok(candidates.phraseCrossfade.score + 0.02 < candidates.beatmix.score + 0.05,
    'sanity check: the corrected+bonus phrase-crossfade rank must actually be lower than beatmix\'s, or this test would prove nothing');
  // The actual point of this fix: beatmix must win once phrase-crossfade's
  // score is no longer artificially inflated by skipping the tempo/downbeat
  // penalty entirely.
  assert.equal(selectedPlan.mode, 'beatmix',
    `expected beatmix to win now that phrase-crossfade's missing tempo-sync terms are scored comparably — selected ${selectedPlan.mode} instead`);
});

test('rankTransitionCandidates: a genuinely high-quality phrase-crossfade candidate still wins over beatmix (fix does not just always favor beatmix)', () => {
  const outgoing = makeAnalysis({
    bpm: 120,
    beatConfidence: 0.8,
    downbeatConfidence: 0.7,
    durationSec: 200,
    lastVocalEndSec: 180,
    phrasesTail: [
      { sec: 184, barIndex: 0, score: 0.6, reasons: ['bar-multiple-4'] },
    ],
  });
  const incoming = makeAnalysis({
    // No usable BPM at all on the incoming side -> beatmix can never be
    // eligible (bpm-unavailable), leaving phrase-crossfade (which doesn't
    // need tempo data) as the only real candidate — a genuine win, not an
    // artifact of miscalibration.
    bpm: null,
    durationSec: 200,
    firstVocalStartSec: 15,
    phrasesHead: [
      { sec: 4, barIndex: 0, score: 0.5, reasons: ['bar-multiple-4'] },
    ],
  });

  const { candidates, selectedPlan } = rankTransitionCandidates(outgoing, incoming, {
    outgoingPlaybackBpm: 120,
    tempoBackend: 'rubberband',
    stemsAvailable: false,
  });

  assert.equal(candidates.beatmix.eligible, false, 'expected beatmix to be ineligible (no incoming BPM) on this fixture');
  assert.equal(candidates.phraseCrossfade.eligible, true);
  assert.equal(selectedPlan.mode, 'phrase-crossfade');
});

// --- stem-mix: no ranking override, plan.confidence is used directly ------
//
// Codex review (PR #46, round 2): the earlier post-hoc comparableStemMixConfidence()
// correction was removed once planBeatmixTransition()'s own pair SEARCH
// started ranking stem-mix candidates by strict (non-relaxed) scoring (see
// beatmixTransition.js's pairScore comment and its dedicated coverage in
// beatmixTransition.test.js) — a stem-mix plan's `confidence` is already
// cross-mode-comparable by the time it reaches the ranker, so toCandidate()
// takes it verbatim, same as beatmix.

test('rankTransitionCandidates: a stem-mix candidate wins on its own (uncorrected) confidence when it is genuinely the best candidate', () => {
  const outgoing = makeAnalysis({ bpm: 120, beatConfidence: 0.5, downbeatConfidence: 0.4, durationSec: 200 });
  const incoming = makeAnalysis({ bpm: null, durationSec: 200 }); // beatmix/phrase-crossfade both ineligible
  const stemMixPlanFn = () => ({
    mode: 'stem-mix',
    eligible: true,
    confidence: 0.9,
    quality: {
      phraseAlignment: 0.9, tempoCompatibility: 0.9, vocalSafety: 0.9,
      downbeatConfidence: 0.9, harmonicCompatibility: null, energyContinuity: 0.9,
    },
    fadeSec: 8,
    sync: { bars: 4 },
    outgoing: { exitStartSec: 190 },
    incoming: { entrySec: 4 },
  });

  const { candidates, selectedPlan, plans } = rankTransitionCandidates(outgoing, incoming, {
    stemsAvailable: true,
    planStemTransitionFn: stemMixPlanFn,
  });

  assert.equal(candidates.stemMix.eligible, true);
  assert.equal(candidates.stemMix.score, plans.stemMix.confidence, 'expected no override — the plan\'s own confidence is used verbatim');
  assert.equal(selectedPlan.mode, 'stem-mix');
});

test('transitionModeBonus: §6.4 exact values', () => {
  assert.equal(transitionModeBonus('stem-mix'), 0.10);
  assert.equal(transitionModeBonus('beatmix'), 0.05);
  assert.equal(transitionModeBonus('phrase-crossfade'), 0.02);
  assert.equal(transitionModeBonus('gapless'), 0);
});

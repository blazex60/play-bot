import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rankTransitionCandidates, transitionModeBonus } from './transitionCandidates.js';
import { comparableStemMixConfidence } from './beatmixTransition.js';

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

// --- comparableStemMixConfidence (Codex review, PR #46, P2) ----------------
//
// planStemTransition() scores vocalSafety with the exit-side check relaxed
// (stemAware: true in scoreTransitionPairDetail — see that function's own
// comment) since a mid-vocal exit is genuinely safe once per-stem
// separation handles the outgoing vocal's own fade-out schedule. That
// relaxed score is correct for stem-mix's OWN eligibility, but comparing it
// directly against beatmix/phrase-crossfade's strict scoring during ranking
// meant stem-mix's score could only ever be >= a strict score for the same
// pair — combined with §6.4's own bonus (+0.10 vs +0.05), stem-mix could
// never lose to beatmix on quality, making the documented "unless clearly
// lower quality" exception unreachable.

test('comparableStemMixConfidence: lowers the ranking score when the winning exit sits mid-vocal', () => {
  const outgoing = { lastVocalEndSec: 5 };
  const stemPlan = {
    eligible: true,
    confidence: 0.9,
    quality: { vocalSafety: 1.0, harmonicCompatibility: null },
    outgoing: { exitStartSec: 1.0 }, // 4s before lastVocalEndSec -> exit is well inside the vocal
  };
  const corrected = comparableStemMixConfidence(stemPlan, outgoing);
  assert.ok(corrected < stemPlan.confidence,
    `expected the mid-vocal exit to lower the comparable score below the relaxed confidence (${stemPlan.confidence}), got ${corrected}`);
});

test('comparableStemMixConfidence: leaves confidence untouched when the exit is already vocal-safe under strict rules too', () => {
  const outgoing = { lastVocalEndSec: 5 };
  const stemPlan = {
    eligible: true,
    confidence: 0.9,
    quality: { vocalSafety: 1.0, harmonicCompatibility: null },
    outgoing: { exitStartSec: 8.0 }, // well past lastVocalEndSec -> strict and relaxed agree
  };
  assert.equal(comparableStemMixConfidence(stemPlan, outgoing), stemPlan.confidence);
});

test('comparableStemMixConfidence: a non-eligible or malformed plan passes through unchanged', () => {
  assert.equal(comparableStemMixConfidence({ eligible: false, confidence: 0.9 }, {}), 0.9);
  assert.equal(comparableStemMixConfidence(null, {}), 0);
  assert.equal(comparableStemMixConfidence({ eligible: true, confidence: 0.9 }, {}), 0.9); // no outgoing.exitStartSec
});

// --- rankTransitionCandidates: the fix must actually change the winner ----

test('rankTransitionCandidates: a clean beatmix candidate beats a stem-mix candidate whose only pair sits mid-vocal', () => {
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
    bpm: 122,
    headBpm: 122,
    beatConfidence: 0.75,
    downbeatConfidence: 0.65,
    durationSec: 200,
    firstVocalStartSec: 15,
    phrasesHead: [
      { sec: 4, barIndex: 0, score: 0.5, reasons: ['bar-multiple-4'] },
    ],
  });

  // Real beatmix planning runs against the fixture above and is genuinely
  // eligible with a solid (but not maxed) confidence. stemMix is DI-mocked
  // (rankTransitionCandidates()'s existing planStemTransitionFn hook) to
  // return a plan whose RELAXED confidence is deliberately higher than
  // beatmix's — the exact shape that, pre-fix, always won on
  // score + transitionModeBonus() alone — but whose winning exit sits well
  // inside the outgoing track's vocal (exitStartSec 1.0s vs lastVocalEndSec
  // 180s), which a strict (beatmix-comparable) scoring would rate poorly.
  // beatmix's own confidence on this exact fixture is ~0.766 (rank ~0.816
  // with its +0.05 bonus) — confirmed by direct computation. 0.85 is chosen
  // so that, uncorrected, stem-mix's rank (0.85+0.10=0.95) clearly beats
  // beatmix (reproducing the pre-fix bug), but once corrected for the
  // mid-vocal exit (delta = 1.0 * VOCAL_SAFETY_WEIGHT / totalWeight(4.2)
  // ≈ 0.238), its rank (~0.612+0.10=0.712) clearly loses.
  const stemMixPlanFn = () => ({
    mode: 'stem-mix',
    eligible: true,
    confidence: 0.85,
    quality: {
      phraseAlignment: 0.9, tempoCompatibility: 0.95, vocalSafety: 1.0,
      downbeatConfidence: 0.9, harmonicCompatibility: null, energyContinuity: 0.9,
    },
    fadeSec: 8,
    sync: { bars: 4 },
    outgoing: { exitStartSec: 1.0 },
    incoming: { entrySec: 4 },
  });

  const { candidates, selectedPlan, plans } = rankTransitionCandidates(outgoing, incoming, {
    outgoingPlaybackBpm: 120,
    tempoBackend: 'rubberband',
    stemsAvailable: true,
    planStemTransitionFn: stemMixPlanFn,
  });

  assert.equal(candidates.beatmix.eligible, true, 'expected beatmix to be genuinely eligible on this fixture');
  assert.equal(candidates.stemMix.eligible, true);
  // The raw plan's own confidence must stay untouched — only the Candidate
  // struct's ranking/reporting `score` is corrected.
  assert.equal(plans.stemMix.confidence, 0.85);
  assert.ok(candidates.stemMix.score < 0.85,
    `expected the reported/ranked stem-mix score to be corrected down from the relaxed confidence, got ${candidates.stemMix.score}`);
  assert.ok(candidates.stemMix.score + 0.10 < candidates.beatmix.score + 0.05,
    'sanity check: the corrected+bonus stem-mix rank must actually be lower than beatmix\'s, or this test would prove nothing');
  // The actual point of this fix: beatmix must win once stem-mix's score is
  // no longer artificially inflated by its relaxed exit-vocal scoring.
  assert.equal(selectedPlan.mode, 'beatmix',
    `expected beatmix to win now that stem-mix's mid-vocal-exit pair is scored comparably — selected ${selectedPlan.mode} instead`);
});

test('rankTransitionCandidates: a genuinely high-quality stem-mix candidate still wins over beatmix (fix does not just always favor beatmix)', () => {
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
    bpm: 122,
    headBpm: 122,
    beatConfidence: 0.75,
    downbeatConfidence: 0.65,
    durationSec: 200,
    firstVocalStartSec: 15,
    phrasesHead: [
      { sec: 4, barIndex: 0, score: 0.5, reasons: ['bar-multiple-4'] },
    ],
  });

  // Same overall quality as beatmix's own pair (exit at 184s, well past
  // lastVocalEndSec 180s) — strict and relaxed scoring agree here, so the
  // correction is a no-op and the §6.4 stem-mix preference bonus should
  // still let it win a genuine near-tie.
  const stemMixPlanFn = () => ({
    mode: 'stem-mix',
    eligible: true,
    confidence: 0.85,
    quality: {
      phraseAlignment: 0.9, tempoCompatibility: 0.95, vocalSafety: 1.0,
      downbeatConfidence: 0.9, harmonicCompatibility: null, energyContinuity: 0.9,
    },
    fadeSec: 8,
    sync: { bars: 4 },
    outgoing: { exitStartSec: 184 },
    incoming: { entrySec: 4 },
  });

  const { candidates, selectedPlan } = rankTransitionCandidates(outgoing, incoming, {
    outgoingPlaybackBpm: 120,
    tempoBackend: 'rubberband',
    stemsAvailable: true,
    planStemTransitionFn: stemMixPlanFn,
  });

  assert.equal(candidates.stemMix.score, 0.85, 'a vocal-safe-under-strict-rules exit must not be corrected');
  assert.equal(selectedPlan.mode, 'stem-mix');
});

test('transitionModeBonus: §6.4 exact values', () => {
  assert.equal(transitionModeBonus('stem-mix'), 0.10);
  assert.equal(transitionModeBonus('beatmix'), 0.05);
  assert.equal(transitionModeBonus('phrase-crossfade'), 0.02);
  assert.equal(transitionModeBonus('gapless'), 0);
});

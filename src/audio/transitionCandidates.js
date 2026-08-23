import { planBeatmixTransition, planPhraseCrossfade, comparablePhraseCrossfadeConfidence } from './beatmixTransition.js';
import { planStemTransition } from './stemTransition.js';
import { planTransition } from './transition.js';

/**
 * Phase 9D (docs/mix-transition-phase9.md §6): the Candidate Ranker.
 *
 * §6.1's pre-Phase-9D shape was a waterfall: planBeatSyncedTransition()
 * (src/audio/beatmixTransition.js) tried beatmix first and returned
 * immediately if eligible, only falling through to phrase-crossfade (and
 * then the legacy planTransition() ladder) when beatmix rejected; stem-mix
 * was bolted on separately in player.js, attempted only when beatmix had
 * NOT already won. That meant a stem-mix candidate could never even be
 * considered once beatmix succeeded, no matter how much better it might
 * have been (§6.2's whole motivation).
 *
 * This module evaluates beatmix / stem-mix / phrase-crossfade independently
 * — each is planned regardless of whether the others are eligible — reduces
 * each to a §6.3 Candidate struct, and picks a winner among the eligible
 * ones by `score + transitionModeBonus(mode)` (§6.4). The legacy
 * planTransition() ladder (crossfade/tail-fade/simple-fade/gapless) is
 * always planned too (it never truly rejects — it is the deterministic
 * fallback of last resort) but is deliberately NOT ranked competitively
 * against the other three: it has no beat-sync/phrase-alignment quality
 * model of its own (planTransition()'s `confidence` is just the outgoing
 * analysis's raw confidence field, not a transition-fit score), so
 * comparing it score-for-score against a real quality-weighted beatmix/
 * stem-mix/phrase-crossfade candidate would risk it winning on an
 * unrelated, higher raw number even when a genuinely better beat-synced
 * candidate was eligible. It is only ever selected when none of the three
 * are — exactly the bottom tier the pre-Phase-9D ladder already gave it.
 * See docs/mix-transition-phase9.md's Phase 9D implementation notes for the
 * full reasoning.
 */

/** §6.4: nudges ties/close calls toward the mode a listener would generally
 * prefer when quality is comparable — stem-mix (real per-stem crossfade)
 * over beatmix (bar-synced but single mixed stream) over phrase-crossfade
 * (no tempo sync). A large quality gap still wins on raw score: the bonus
 * deltas here (0.10/0.05/0.02) are small relative to the 0..1 score range,
 * so this never overrides a candidate that is genuinely much better. */
export function transitionModeBonus(mode) {
  switch (mode) {
    case 'stem-mix': return 0.10;
    case 'beatmix': return 0.05;
    case 'phrase-crossfade': return 0.02;
    default: return 0;
  }
}

/** Reduce a beatmix/stem-mix/phrase-crossfade plan to its §6.3 Candidate
 * struct. `mode` is passed explicitly (not read off `plan.mode`) because a
 * rejected plan's own `mode` is always null (see beatmixTransition.js's
 * `rejected()`) — the caller always knows which slot it's building.
 * `scoreOverride`, when given, replaces `plan.confidence` as the reported/
 * ranked `score` — used for phrase-crossfade (see
 * comparablePhraseCrossfadeConfidence()'s docstring in beatmixTransition.js):
 * tier 2's own `confidence` is just `phraseAlignment` (it never scores tempo
 * sync or downbeat alignment at all), which isn't comparable to beatmix/
 * stem-mix's six-term weighted confidence for cross-mode ranking. Stem-mix
 * needs no override here — its pair SEARCH now ranks by the same strict
 * scoring beatmix uses (see planBeatmixTransition()'s pairScore comment),
 * so `plan.confidence` is already comparable. */
function toCandidate(mode, plan, scoreOverride = null) {
  if (!plan?.eligible) {
    return { mode, eligible: false, reasons: plan?.reasons ?? ['unknown'] };
  }
  return {
    mode,
    eligible: true,
    score: scoreOverride ?? plan.confidence,
    quality: plan.quality ?? null,
    fadeSec: plan.fadeSec,
    bars: plan.sync?.bars ?? null,
  };
}

/** argmax(candidate.score + transitionModeBonus(mode)) over `keys`, falling
 * back to `legacyPlan` when none of `keys` are eligible. Shared by the main
 * three-way selection and by the "best non-stem-mix" fallback player.js
 * needs when a committed stem-mix plan later turns out unusable (see
 * `bestNonStemPlan` below). */
function selectWinner(candidates, plans, keys, legacyPlan) {
  let winnerKey = null;
  let winnerRank = -Infinity;
  for (const key of keys) {
    const candidate = candidates[key];
    if (!candidate.eligible) continue;
    const rank = candidate.score + transitionModeBonus(candidate.mode);
    if (rank > winnerRank) {
      winnerRank = rank;
      winnerKey = key;
    }
  }
  return winnerKey ? plans[winnerKey] : legacyPlan;
}

/**
 * Independently evaluates all four transition modes and picks a winner.
 *
 * @param {object} outgoing analysis
 * @param {object} incoming analysis
 * @param {object} [options]
 * @param {number|null} [options.outgoingPlaybackBpm]
 * @param {string|null} [options.tempoBackend]
 * @param {number} [options.maxOverlapSec]
 * @param {boolean} [options.stemsAvailable] whether both sides' stems are
 *   cached — planStemTransitionFn() is only invoked when true. Checking the
 *   cache itself is the caller's job (an async fs lookup — see player.js's
 *   #maybeStartCrossfade()); this function stays synchronous like
 *   planBeatSyncedTransition() before it.
 * @param {Function} [options.planStemTransitionFn] DI hook, defaults to the
 *   real planStemTransition() — mirrors player.js's existing
 *   `#planStemTransitionFn` constructor injection point.
 * @returns {{
 *   candidates: {beatmix: object, stemMix: object, phraseCrossfade: object},
 *   plans: {beatmix: object, stemMix: object, phraseCrossfade: object, legacy: object},
 *   selectedPlan: object,
 *   bestNonStemPlan: object,
 * }}
 */
export function rankTransitionCandidates(outgoing, incoming, {
  outgoingPlaybackBpm = null,
  tempoBackend = 'rubberband',
  maxOverlapSec = 6,
  stemsAvailable = false,
  planStemTransitionFn = planStemTransition,
} = {}) {
  const beatmixPlan = planBeatmixTransition(outgoing, incoming, { outgoingPlaybackBpm, tempoBackend });
  const phraseCrossfadePlan = planPhraseCrossfade(outgoing, incoming, { outgoingPlaybackBpm, maxOverlapSec });
  const stemMixPlan = stemsAvailable
    ? planStemTransitionFn(outgoing, incoming, { outgoingPlaybackBpm, tempoBackend })
    : { mode: null, eligible: false, reasons: ['stems-unavailable'] };
  const legacyPlan = planTransition(outgoing, incoming, { maxOverlapSec });

  const candidates = {
    beatmix: toCandidate('beatmix', beatmixPlan),
    stemMix: toCandidate('stem-mix', stemMixPlan),
    phraseCrossfade: toCandidate('phrase-crossfade', phraseCrossfadePlan, comparablePhraseCrossfadeConfidence(phraseCrossfadePlan)),
  };
  const plans = {
    beatmix: beatmixPlan, stemMix: stemMixPlan, phraseCrossfade: phraseCrossfadePlan, legacy: legacyPlan,
  };

  const selectedPlan = selectWinner(candidates, plans, ['beatmix', 'stemMix', 'phraseCrossfade'], legacyPlan);
  // §8 (docs/mix-transition-phase8.md): stem-mix's exitStartSec/entrySec are
  // chosen with vocal-safety relaxed (requireExitVocalSafe/
  // requireEntryForwardSafe: false) — that window is only safe WITH stem-
  // mix's own per-stem vocal envelope keeping the outgoing vocal tail clear
  // of the incoming track's own start. If a committed stem-mix plan later
  // turns out unusable (TRACK loop mode re-deriving the entry, or an
  // incoming source that couldn't honor the seek/stretch), player.js must
  // re-plan from the best of the OTHER candidates rather than reuse that
  // window under a plain (non-stem) crossfade — see #maybeStartCrossfade().
  const bestNonStemPlan = selectWinner(candidates, plans, ['beatmix', 'phraseCrossfade'], legacyPlan);

  return {
    candidates, plans, selectedPlan, bestNonStemPlan,
  };
}

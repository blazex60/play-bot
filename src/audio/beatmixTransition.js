import { canTempoMatch, buildTempoFilter, tempoRatio, HARD_LIMIT_RATIO } from './tempo.js';
import { camelotDistance } from '../mix/camelot.js';
import { planTransition } from './transition.js';
import { isHalfDouble } from './trackAnalysis.js';
import { HEAD_WINDOW_SEC } from './vocalActivity.js';

/**
 * Phase 7C (docs/mix-transition-phase7.md §9-10, §16): the beatmix planner.
 *
 * This module is additive and self-contained — transition.js/MixStream/
 * player.js are untouched. planBeatSyncedTransition() is the intended
 * eventual replacement for player.js's planTransition() call, but nothing
 * in this repo calls it yet: Phase 7D (MixStream bar-envelope/tempo-synced
 * execution) has to exist first, since a "beatmix" plan's sync/eq/gain
 * fields need real bar-timed mixing to mean anything. Until then this is a
 * fully-built, fully-tested planning layer with no live-playback impact.
 */

// §9.2 minimums (provisional; real-track calibration is Phase 7E).
export const BEAT_CONFIDENCE_MIN = 0.5;
export const DOWNBEAT_CONFIDENCE_MIN = 0.4;
export const HARMONIC_CONFIDENCE_MIN = 0.55; // matches src/mix/ordering.js's harmonicOk threshold

/**
 * Phase 9E (docs/mix-transition-phase9.md §7.2): the beatmix bar-count
 * search space. `preferred`/`minimum` are the same two-tier sweep that
 * existed before this phase (renamed from the standalone
 * BEATMIX_OVERLAP_BARS=4/MIN_OVERLAP_BARS=2 constants, kept exported below
 * for every existing call site — src/mix/ordering.js, this file's own
 * default params, both modules' tests — that already imports them by name).
 * `extended` is new: a third, wider starting point the search only reaches
 * for a pair that clears extendedTierEligible() below. See that function's
 * docstring for what "16 bars only when phrase confidence is high, stems
 * are available, and the vocal plan is usable" (§7.2) maps onto in this
 * codebase's actual analysis fields.
 */
export const MIX_BARS = {
  preferred: 8,
  minimum: 4,
  extended: 16,
};
export const BEATMIX_OVERLAP_BARS = MIX_BARS.preferred;
export const MIN_OVERLAP_BARS = MIX_BARS.minimum;
/**
 * §7.2 "phrase confidence high" gate for the extended (16-bar) tier. This
 * codebase has no standalone aggregate phrase-confidence field — phrase
 * candidates (buildPhraseCandidates() in trackAnalysis.js) are built
 * directly from each side's downbeat grid, so downbeatGrid.confidence (the
 * same field DOWNBEAT_CONFIDENCE_MIN already gates bar-1 eligibility on) is
 * the closest existing signal to "how much do we trust phrase alignment."
 * Set well above DOWNBEAT_CONFIDENCE_MIN (0.4) — a bare pass on the
 * eligibility floor is not the same as "high" — reusing the same 0.7
 * "confident enough for an extended/non-default tier" precedent
 * MARGINAL_TEMPO_MIN_SCORE below already sets for §8.3's marginal-tempo
 * tier in this exact file.
 */
export const EXTENDED_PHRASE_CONFIDENCE_MIN = 0.7;
/**
 * §7.2 "vocal plan usable" gate for the extended (16-bar) tier.
 * vocalActivity.js's classifyVocalEnvelope() only reports its top
 * vocalConfidence tier (0.85) when at least 5 RMS frames were classified —
 * enough real vocal-envelope data to trust the resulting
 * lastVocalEndSec/firstVocalStartSec timing for a vocal fade schedule this
 * long (up to 32s at 120 BPM); the lower 0.5 tier ("some frames, not enough
 * to be confident") is not. This is deliberately a stronger requirement
 * than hasVocalAnalysis() (analysisSource !== 'none', already required for
 * ANY exit/entry candidate to exist at all) — a real-but-thin reading and a
 * well-sampled one both pass hasVocalAnalysis(), but only the latter should
 * be trusted with a full extended-tier overlap.
 */
export const EXTENDED_VOCAL_CONFIDENCE_MIN = 0.85;
/** Vocal margin (seconds past/before the vocal boundary) for full vocal-safety credit. */
const VOCAL_MARGIN_FULL_CREDIT_SEC = 2;
/** Max camelotDistance() value (opposite wheel position + mode penalty). */
const MAX_CAMELOT_DISTANCE = 6.5;

const VOCAL_SAFETY_WEIGHT = 1;
const PHRASE_ALIGNMENT_WEIGHT = 1;
const TEMPO_COMPATIBILITY_WEIGHT = 1;
const DOWNBEAT_CONFIDENCE_WEIGHT = 0.8;
const HARMONIC_WEIGHT = 0.6;
const ENERGY_CONTINUITY_WEIGHT = 0.4;
/** §16 tier 1 requires "high confidence" specifically for the 4-6% marginal tempo tier (§8.3). */
export const MARGINAL_TEMPO_MIN_SCORE = 0.7;

function clamp01(n) {
  return Math.max(0, Math.min(1, n));
}

/**
 * Vocal-safety margin (seconds) for an entry candidate. findEntryCandidates()
 * already guarantees `entrySec` is either before firstVocalStartSec or
 * inside a headVocalGaps window — for the gap case, `firstVocalStartSec -
 * entrySec` is negative (the gap sits after singing already started), which
 * would wrongly zero out the credit for a genuinely safe gap entry. Measure
 * from the containing gap's edges instead when that's where entrySec is.
 */
function entryVocalMargin(incoming, entrySec) {
  const firstVocal = incoming?.firstVocalStartSec;
  if (!Number.isFinite(firstVocal) || entrySec <= firstVocal - 1e-6) {
    return Number.isFinite(firstVocal) ? firstVocal - entrySec : VOCAL_MARGIN_FULL_CREDIT_SEC;
  }
  const gaps = Array.isArray(incoming?.headVocalGaps) ? incoming.headVocalGaps : [];
  const gap = gaps.find((g) => entrySec >= g.startSec - 1e-6 && entrySec <= g.endSec + 1e-6);
  if (!gap) return 0; // defensive: findEntryCandidates should never offer an unsafe entry
  return Math.min(entrySec - gap.startSec, gap.endSec - entrySec);
}

/**
 * How many native seconds of vocal-free room follow `entrySec` before the
 * next vocal boundary. findEntryCandidates() only checks that `entrySec`
 * itself is safe (before firstVocalStartSec, or inside a headVocalGaps
 * window) — it says nothing about whether the *rest* of an overlap
 * starting there stays clear. An entry 0.1s before firstVocalStartSec, or
 * 0.1s before the end of a gap, is technically a "safe" candidate but has
 * almost no forward room; a multi-second fadeSec from there would spend
 * most of the overlap under vocals despite the plan being labeled
 * vocal-safe. A null firstVocalStartSec only proves the analyzed head
 * window (HEAD_WINDOW_SEC, e.g. the first 30s) came back clear — it says
 * nothing about what happens after that window ends, so the room is capped
 * there rather than treated as unbounded.
 */
export function entryForwardSafeSec(incoming, entrySec) {
  const firstVocal = incoming?.firstVocalStartSec;
  if (!Number.isFinite(firstVocal)) return Math.max(0, HEAD_WINDOW_SEC - entrySec);
  if (entrySec <= firstVocal - 1e-6) return firstVocal - entrySec;
  const gaps = Array.isArray(incoming?.headVocalGaps) ? incoming.headVocalGaps : [];
  const gap = gaps.find((g) => entrySec >= g.startSec - 1e-6 && entrySec <= g.endSec + 1e-6);
  return gap ? gap.endSec - entrySec : 0; // defensive: findEntryCandidates should never offer an unsafe entry
}

/**
 * §2.3/§8.4: tempo is fixed once at spawn time and holds for a source's
 * entire remaining playback. `outgoingPlaybackBpm` reflects the stretch the
 * outgoing track was spawned with — calibrated against its own HEAD BPM at
 * whatever earlier transition promoted it to current (see
 * planBeatmixTransition's incoming.headBpm handling below, which is exactly
 * that calibration on the other side of a transition). If outgoing's native
 * head and tail BPM drift apart, that same fixed ratio still carries through
 * unchanged to the tail — so `outgoingPlaybackBpm` is what the head matched,
 * not what the tail (where the exit point lives) is actually playing right
 * now. Reconstructs the tail's real current tempo: nativeTailBpm *
 * (outgoingPlaybackBpm / nativeHeadBpm). Falls back to `outgoingPlaybackBpm`
 * unchanged when head/tail BPM isn't available to compute the drift.
 */
function outgoingActualTargetBpm(outgoing, outgoingPlaybackBpm) {
  if (outgoingPlaybackBpm == null) return null;
  const nativeHead = outgoing?.headBpm;
  const nativeTail = outgoing?.tailBpm ?? outgoing?.bpm;
  if (!(nativeHead > 0) || !(nativeTail > 0)) return outgoingPlaybackBpm;
  return nativeTail * (outgoingPlaybackBpm / nativeHead);
}

/**
 * §10's energy term, at the resolution the v3 analysis payload actually
 * offers: phrase candidates carry a 'near-silence' reason tag (a boolean
 * threshold on RMS at that point — see phraseAnalysis.js), not a raw energy
 * value. This is a coarse proxy, not true RMS continuity — full credit when
 * both candidates agree on being near-silence or not, partial credit on a
 * potential level mismatch when only one side is.
 */
function energyContinuity(exit, entry) {
  const exitSilent = (exit?.reasons ?? []).includes('near-silence');
  const entrySilent = (entry?.reasons ?? []).includes('near-silence');
  return exitSilent === entrySilent ? 1 : 0.5;
}

/**
 * `analyzeVocalActivity()` runs one Demucs pass covering both the head and
 * tail windows; on total failure (ffmpeg/Demucs pipeline error) it returns
 * `lastVocalEndSec: null, firstVocalStartSec: null, vocalConfidence: 0,
 * source: 'none'` for BOTH — the same null a genuinely fully-instrumental
 * head window (a real, trustworthy analysis result) can also produce for
 * `firstVocalStartSec`. `analysisSource !== 'none'` disambiguates "no
 * vocals were verifiably found" from "vocal safety could not be verified
 * at all", which the two candidate-search functions below must never
 * conflate — a failed analysis has zero evidence of being vocal-safe.
 */
export function hasVocalAnalysis(analysis) {
  return Boolean(analysis?.analysisSource) && analysis.analysisSource !== 'none';
}

/**
 * Outgoing tail candidates: phrase boundaries (with their existing bar-
 * multiple/structural/vocal-boundary/near-silence scoring) filtered to the
 * vocal-free window with enough room left for `minOverlapSec`. Degrades to
 * plain downbeats (score 0) when phrase candidates are unavailable, rather
 * than rejecting outright — a downbeat-only exit point is still usable.
 * Returns nothing when vocal analysis failed outright (see
 * hasVocalAnalysis()) — there is no verifiably vocal-safe window to offer.
 * @returns {{ sec: number, barIndex: number, score: number, reasons: string[] }[]} sorted best-first
 */
export function findExitCandidates(outgoing, { minOverlapSec = 2, requireVocalSafe = true } = {}) {
  if (!outgoing) return [];
  const durationSec = outgoing.durationSec;
  if (!(durationSec > 0)) return [];
  // Phase 8 (docs/mix-transition-phase8.md): requireVocalSafe=false still
  // needs hasVocalAnalysis() true — planStemTransition()'s vocal-fade-out
  // timing reads lastVocalEndSec, so a candidate can only be offered when
  // that's a real reading, not a failed-analysis null (see this function's
  // own docstring above and hasVocalAnalysis()'s).
  if (!hasVocalAnalysis(outgoing)) return [];
  const vocalFloor = Number.isFinite(outgoing.lastVocalEndSec) ? outgoing.lastVocalEndSec : 0;
  const phrasePool = Array.isArray(outgoing.phrases?.tail) ? outgoing.phrases.tail : [];
  const pool = phrasePool.length > 0
    ? phrasePool
    : (outgoing.downbeatGrid?.tail?.downbeatsSec ?? []).map((sec, barIndex) => (
      { sec, barIndex, score: 0, reasons: ['downbeat-only'] }
    ));

  return pool
    .filter((c) => (
      (!requireVocalSafe || c.sec >= vocalFloor - 1e-6) && durationSec - c.sec >= minOverlapSec - 1e-6
    ))
    .sort((a, b) => b.score - a.score || a.sec - b.sec);
}

/**
 * Incoming head candidates: phrase boundaries filtered to vocal-safe
 * positions (before firstVocalStartSec, or inside a headVocalGaps window).
 * A null firstVocalStartSec means no singing was detected in the head
 * window at all — every candidate is safe, but only once hasVocalAnalysis()
 * confirms that null came from a real result and not a failed analysis (see
 * findExitCandidates()'s docstring). Degrades to plain downbeats the same
 * way findExitCandidates() does.
 * @returns {{ sec: number, barIndex: number, score: number, reasons: string[] }[]} sorted best-first
 */
export function findEntryCandidates(incoming) {
  if (!incoming) return [];
  if (!hasVocalAnalysis(incoming)) return [];
  const phrasePool = Array.isArray(incoming.phrases?.head) ? incoming.phrases.head : [];
  const pool = phrasePool.length > 0
    ? phrasePool
    : (incoming.downbeatGrid?.head?.downbeatsSec ?? []).map((sec, barIndex) => (
      { sec, barIndex, score: 0, reasons: ['downbeat-only'] }
    ));

  const firstVocal = incoming.firstVocalStartSec;
  const gaps = Array.isArray(incoming.headVocalGaps) ? incoming.headVocalGaps : [];
  const isVocalSafe = (sec) => {
    if (firstVocal == null || !Number.isFinite(firstVocal)) return true;
    if (sec <= firstVocal - 1e-6) return true;
    return gaps.some((g) => sec >= g.startSec - 1e-6 && sec <= g.endSec + 1e-6);
  };

  return pool
    .filter((c) => isVocalSafe(c.sec))
    .sort((a, b) => b.score - a.score || a.sec - b.sec);
}

/**
 * §10 transitionScore, normalized to 0..1 so it doubles as the resulting
 * plan's `confidence`. Key compatibility is scored when available but never
 * gates eligibility (§9.2: "キー一致は必須条件にしない").
 *
 * Phase 9D (docs/mix-transition-phase9.md §6.3): this used to compute and
 * discard every sub-term, returning only the weighted total. The Candidate
 * struct now needs those sub-terms (`quality.phraseAlignment`/
 * `tempoCompatibility`/etc.) for observability, so the actual math moved
 * into scoreTransitionPairDetail() below; this function is now a thin
 * wrapper that keeps returning exactly the same scalar it always did (same
 * rounding, same call signature) — every existing caller/test that treats
 * this as "the score, a number" is unaffected.
 */
export function scoreTransitionPair(params) {
  return scoreTransitionPairDetail(params).total;
}

/**
 * Phase 9D: same computation as scoreTransitionPair(), but returns every
 * weighted sub-term alongside the total — this is what planBeatmixTransition()
 * uses to populate a winning pair's `quality` object (§6.3). Not exported
 * under a "public API" expectation beyond that internal use (see
 * scoreTransitionPairDetailed() for the exported wrapper tests/other
 * modules should use if they need the breakdown directly).
 */
function scoreTransitionPairDetail({
  outgoing, incoming, exit, entry, targetBpm, match = null, stemAware = false,
}) {
  // Phase 8: a stem-mix candidate's outgoing exit is allowed to sit mid-
  // vocal (findExitCandidates({requireVocalSafe:false})) — the outgoing
  // vocal stem simply fades out on its own schedule instead of needing to
  // already be silent by the exit point. Scoring that exit margin the same
  // way a plain (non-stem) candidate is scored would wrongly tank a
  // perfectly fine stem-mix pair, so only the entry-side margin (which
  // Phase 8 does NOT relax — see beatmixTransition.js's planBeatmixTransition
  // docstring) still contributes to vocalSafety here.
  const entryMargin = entryVocalMargin(incoming, entry.sec);
  const entryVocalSafety = clamp01(entryMargin / VOCAL_MARGIN_FULL_CREDIT_SEC);
  const vocalSafety = stemAware ? entryVocalSafety : Math.min(
    clamp01((exit.sec - (Number.isFinite(outgoing?.lastVocalEndSec) ? outgoing.lastVocalEndSec : 0)) / VOCAL_MARGIN_FULL_CREDIT_SEC),
    entryVocalSafety,
  );

  const phraseAlignment = clamp01(((exit.score ?? 0) + (entry.score ?? 0)) / 2);

  const tempoInfo = match ?? canTempoMatch(incoming?.bpm, targetBpm);
  const tempoCompatibility = tempoInfo?.ratio == null
    ? 0
    : clamp01(1 - Math.abs(tempoInfo.ratio - 1) / HARD_LIMIT_RATIO);

  const downbeatConfidence = clamp01((
    (outgoing?.downbeatGrid?.confidence ?? 0) + (incoming?.downbeatGrid?.confidence ?? 0)
  ) / 2);

  const energy = energyContinuity(exit, entry);

  let total = vocalSafety * VOCAL_SAFETY_WEIGHT
    + phraseAlignment * PHRASE_ALIGNMENT_WEIGHT
    + tempoCompatibility * TEMPO_COMPATIBILITY_WEIGHT
    + downbeatConfidence * DOWNBEAT_CONFIDENCE_WEIGHT
    + energy * ENERGY_CONTINUITY_WEIGHT;
  let totalWeight = VOCAL_SAFETY_WEIGHT + PHRASE_ALIGNMENT_WEIGHT + TEMPO_COMPATIBILITY_WEIGHT
    + DOWNBEAT_CONFIDENCE_WEIGHT + ENERGY_CONTINUITY_WEIGHT;

  const harmonicOk = (outgoing?.harmonicConfidence ?? 0) >= HARMONIC_CONFIDENCE_MIN
    && (incoming?.harmonicConfidence ?? 0) >= HARMONIC_CONFIDENCE_MIN;
  let harmonicCompatibility = null;
  if (harmonicOk) {
    const dist = camelotDistance(outgoing?.tailKey, incoming?.headKey);
    if (dist != null) {
      harmonicCompatibility = clamp01(1 - dist / MAX_CAMELOT_DISTANCE);
      total += harmonicCompatibility * HARMONIC_WEIGHT;
      totalWeight += HARMONIC_WEIGHT;
    }
  }

  return {
    total: Number(clamp01(total / totalWeight).toFixed(3)),
    phraseAlignment: Number(phraseAlignment.toFixed(3)),
    tempoCompatibility: Number(tempoCompatibility.toFixed(3)),
    vocalSafety: Number(vocalSafety.toFixed(3)),
    downbeatConfidence: Number(downbeatConfidence.toFixed(3)),
    // null (not 0) when harmonic confidence didn't clear the threshold on
    // both sides — §9.2's "key match is never required" means "we didn't
    // score this at all" is a different fact than "we scored it and it was
    // bad", and the Candidate struct (§6.3) must keep that distinction
    // rather than fabricating a 0.
    harmonicCompatibility,
    energyContinuity: Number(energy.toFixed(3)),
  };
}

/**
 * Phase 9D (docs/mix-transition-phase9.md §6.3): the same breakdown
 * scoreTransitionPairDetail() computes internally, exposed for anything
 * outside this module that wants the sub-terms directly rather than reading
 * them back off a winning plan's `.quality` (tests, mainly — planBeatmixTransition()
 * itself is the only production caller, and it already gets the breakdown
 * from the internal function without going through this export).
 */
export function scoreTransitionPairDetailed(params) {
  return scoreTransitionPairDetail(params);
}

/**
 * Codex review (PR #46, Phase 9D §6.4, round 2): planPhraseCrossfade()'s
 * `confidence` is just `phraseAlignment` (tier 2 never scores tempo sync or
 * downbeat alignment at all) — not comparable to beatmix's six-term weighted
 * confidence when RANKING across modes. A clean shared phrase boundary can
 * report `phraseAlignment: 1` even with no tempo sync whatsoever, beating an
 * otherwise-strong beatmix candidate that scores lower only because its
 * tempoCompatibility/downbeatConfidence terms pull its weighted average down
 * — the exact thing those terms exist to penalize.
 *
 * Recomputes a cross-mode-comparable score using the same weighted formula
 * scoreTransitionPairDetail() uses, crediting phrase-crossfade's real
 * phraseAlignment/vocalSafety/energyContinuity terms (already on
 * `phrasePlan.quality`) but explicitly zero-crediting tempoCompatibility and
 * downbeatConfidence — tier 2 structurally has neither, so a comparable
 * score must charge for their absence rather than excluding them from the
 * weighted average (excluding them is what inflated the score in the first
 * place). harmonicCompatibility stays excluded from the weight entirely
 * (tier 2 never even attempts it, unlike beatmix/stem-mix where a `null`
 * specifically means "confidence didn't clear the threshold").
 */
export function comparablePhraseCrossfadeConfidence(phrasePlan) {
  if (!phrasePlan?.eligible) return phrasePlan?.confidence ?? 0;
  const q = phrasePlan.quality ?? {};
  const total = (q.vocalSafety ?? 0) * VOCAL_SAFETY_WEIGHT
    + (q.phraseAlignment ?? 0) * PHRASE_ALIGNMENT_WEIGHT
    + (q.energyContinuity ?? 0) * ENERGY_CONTINUITY_WEIGHT;
    // tempoCompatibility/downbeatConfidence contribute 0, not excluded.
  const totalWeight = VOCAL_SAFETY_WEIGHT + PHRASE_ALIGNMENT_WEIGHT + TEMPO_COMPATIBILITY_WEIGHT
    + DOWNBEAT_CONFIDENCE_WEIGHT + ENERGY_CONTINUITY_WEIGHT;
  return clamp01(total / totalWeight);
}

function rejected(reasons) {
  return { mode: null, eligible: false, reasons };
}

/**
 * Phase 9E (docs/mix-transition-phase9.md §7.2): the three extended-tier
 * (16-bar) gates, evaluated up front — the bar search loop's own starting
 * point depends on this, so it can't wait for a winning exit/entry pair the
 * way per-pair scoring does. This is a coarse, TRACK-WIDE prefilter only:
 * it decides whether the search is even allowed to START looking at 16
 * bars, not whether any particular candidate pair actually deserves it —
 * see the per-pair `pairPhraseAlignment` check in the search loop below
 * (Codex review, PR #48, round 1) for the pair-specific reinforcement of
 * the "phrase confidence high" gate.
 *
 * - phrase confidence high: EXTENDED_PHRASE_CONFIDENCE_MIN, see its
 *   docstring.
 * - stem available: `stemAware`. planBeatmixTransition() is only ever
 *   called with stemAware:true from planStemTransition() (see
 *   stemTransition.js), whose own docstring makes "both sides' stems are
 *   already cached" a precondition the CALLER (player.js /
 *   transitionCandidates.js's rankTransitionCandidates()) must have already
 *   verified before invoking it — by the time stemAware is true here, stems
 *   being available is already an established fact, not something this
 *   function needs to re-check itself. A plain (non-stem) beatmix call
 *   never sets stemAware, so it never claims stems are available and never
 *   qualifies for the extended tier — deliberately: a 32-second (at 120
 *   BPM) single-stream crossfade with both tracks' vocals overlapping for
 *   the whole overlap is exactly the failure mode per-stem vocal envelopes
 *   (buildStemEnvelopes() in stemTransition.js) exist to prevent, so a
 *   plain crossfade that long is not something this codebase should ever
 *   plan even when phrase/vocal confidence happen to be high.
 * - vocal plan usable: EXTENDED_VOCAL_CONFIDENCE_MIN, see its docstring.
 */
function extendedTierEligible(outgoing, incoming, stemAware) {
  if (!stemAware) return false;
  const phraseConfidenceHigh = (outgoing?.downbeatGrid?.confidence ?? 0) >= EXTENDED_PHRASE_CONFIDENCE_MIN
    && (incoming?.downbeatGrid?.confidence ?? 0) >= EXTENDED_PHRASE_CONFIDENCE_MIN;
  const vocalPlanUsable = (outgoing?.vocalConfidence ?? 0) >= EXTENDED_VOCAL_CONFIDENCE_MIN
    && (incoming?.vocalConfidence ?? 0) >= EXTENDED_VOCAL_CONFIDENCE_MIN;
  return phraseConfidenceHigh && vocalPlanUsable;
}

/**
 * §9.2/§9.3: Tier 1 of the §16 fallback ladder. Requires valid BPM on both
 * sides, sufficient beat/downbeat confidence, a tempo ratio within
 * HARD_LIMIT_RATIO (session tempo — incoming stretches to outgoing's
 * current playback BPM, never the reverse, per §2.3/§8.4), and a
 * vocal-safe candidate pair with room for at least MIN_OVERLAP_BARS.
 * @returns {object} a TransitionPlan v2 (mode: 'beatmix') when eligible, or
 *   `{ mode: null, eligible: false, reasons: string[] }` when not.
 */
export function planBeatmixTransition(outgoing, incoming, {
  outgoingPlaybackBpm = null,
  minOverlapSec = 2,
  overlapBars = BEATMIX_OVERLAP_BARS,
  minOverlapBars = MIN_OVERLAP_BARS,
  tempoBackend = 'rubberband',
  // Phase 8 (docs/mix-transition-phase8.md): all three default to today's
  // exact tier-1 behavior. planStemTransition() is the only caller that
  // passes false/true here — a stem-mix candidate's outgoing vocal simply
  // fades out on its own schedule instead of needing to already be silent
  // by the exit point, so the whole-overlap vocal-avoidance this tier
  // otherwise enforces on the OUTGOING side becomes unnecessary once stems
  // let the two tracks' vocal layers never actually collide in the mixed
  // output. Only the outgoing side is relaxed — findEntryCandidates()'s
  // incoming-entry vocal-safety check is untouched (a deliberate scope cut,
  // see the doc's 未決事項).
  requireExitVocalSafe = true,
  requireEntryForwardSafe = true,
  stemAware = false,
} = {}) {
  if (!outgoing || !incoming) return rejected(['missing-analysis']);

  // trackAnalysis.js's aggregate `bpm` field prefers tailBpm (falling back
  // to headBpm only when the tail window failed) — a reasonable default for
  // the outgoing side, whose exit point lives in its own tail, but backwards
  // for incoming: its entry point lives in its HEAD window, so a head/tail
  // tempo difference (e.g. a slower intro) must stretch against headBpm, not
  // the tail-biased aggregate, or the entry will be spawned at the wrong
  // native tempo and drift out of sync from the first beat.
  const outgoingBpm = outgoing.bpm;
  const incomingBpm = incoming.headBpm ?? incoming.bpm;
  if (!(outgoingBpm > 0) || !(incomingBpm > 0)) return rejected(['bpm-unavailable']);

  if ((outgoing.beatConfidence ?? 0) < BEAT_CONFIDENCE_MIN || (incoming.beatConfidence ?? 0) < BEAT_CONFIDENCE_MIN) {
    return rejected(['beat-confidence-low']);
  }

  const downbeatConfOutgoing = outgoing.downbeatGrid?.confidence ?? 0;
  const downbeatConfIncoming = incoming.downbeatGrid?.confidence ?? 0;
  if (downbeatConfOutgoing < DOWNBEAT_CONFIDENCE_MIN || downbeatConfIncoming < DOWNBEAT_CONFIDENCE_MIN) {
    return rejected(['downbeat-confidence-low']);
  }

  // Both readings must agree once both sides are confident enough to
  // report one — bar boundaries land every `meter` beats, so a 4/4 outgoing
  // paired with a 3/4 incoming would put sync.bars/the bass-swap bar on the
  // wrong beat for the incoming track from the second bar onward.
  const outgoingMeter = outgoing.downbeatGrid?.meter ?? null;
  const incomingMeter = incoming.downbeatGrid?.meter ?? null;
  if (outgoingMeter != null && incomingMeter != null && outgoingMeter !== incomingMeter) {
    return rejected(['meter-mismatch']);
  }
  const beatsPerBar = outgoingMeter ?? incomingMeter ?? 4;

  const targetBpm = outgoingActualTargetBpm(outgoing, outgoingPlaybackBpm) ?? outgoingBpm;
  const match = canTempoMatch(incomingBpm, targetBpm);
  if (!match.ok) return rejected([`tempo-ratio-${match.tier ?? 'unrelated'}`]);

  // canTempoMatch()/tempoRatio() octave-normalize incomingBpm before taking
  // a ratio (§8.1 half/double handling) — correct for "is this tempo close
  // enough to stretch," but `barSec` below is derived from targetBpm alone
  // and assumes incoming's OWN downbeat grid also has that same bar length.
  // When incomingBpm only matched via a 2x/0.5x octave correction (e.g. a
  // 60 BPM grid — 4s bars — matched against a 120 BPM target's 2s bars),
  // the incoming track's real downbeats land on only every other computed
  // bar boundary: sync.bars/the bass-swap bar would be built against a bar
  // length the incoming track doesn't actually have.
  if (isHalfDouble(incomingBpm, targetBpm)) {
    return rejected(['octave-bar-mismatch']);
  }

  // §8.3: the 4-6% marginal tier is only meant to be taken "when confidence/
  // transition conditions are high" — gated below once a candidate pair's
  // full score (vocal safety + phrase + downbeat + harmonic) is known,
  // rather than on the raw BPM-confidence minimums alone.
  const isMarginalTempo = match.tier === 'marginal';

  const built = buildTempoFilter({ nativeBpm: incomingBpm, targetBpm, backend: tempoBackend });
  // A non-1 ratio with no filter (backend unavailable, or atempo's soft-only
  // range exceeded) cannot actually be played back stretched — reject
  // rather than silently emit a plan whose incoming.playbackBpm lies about
  // what will really play.
  if (built.filter == null && Math.abs(match.ratio - 1) > 1e-9) {
    return rejected(['tempo-filter-unavailable']);
  }

  const barSec = (60 / targetBpm) * beatsPerBar;
  if (!(barSec > 0)) return rejected(['invalid-bar-length']);

  // fadeSec (and the minimum overlap requirement below) are playback-domain
  // (post-stretch) durations. Native seconds of remaining source content
  // convert to playback seconds by dividing by that side's own tempo ratio
  // — outgoing may itself already be stretched (a chained beatmix) relative
  // to its native BPM, and incoming stretches by `match.ratio`. Comparing
  // playback-domain durations against unconverted native seconds would
  // accept an overlap the source doesn't actually have enough playback time
  // left to cover. Uses tempoRatio()'s octave normalization (not a plain
  // division) for the same reason canTempoMatch() needs it for incoming: a
  // half/double BPM misdetection between outgoingBpm and targetBpm would
  // otherwise produce a ratio nowhere near the real stretch (e.g. detected
  // 240 vs a 120 target naively divides to 0.5, when the physical stretch
  // is really ~1). Falls back to 1 (assume unstretched) if the two aren't
  // octave-related at all — a conservative default, not a silent wrong
  // answer, since native room is what pre-Phase-7C code always used.
  const outgoingRatio = tempoRatio(outgoingBpm, targetBpm) ?? 1;

  // Coarse prefilter — findExitCandidates() compares against native
  // durationSec, so the playback-domain minimum overlap must be converted
  // back to native seconds here, or a candidate with enough real playback
  // room (once outgoingRatio stretches/compresses it) gets excluded before
  // the precise, per-pair room check below ever sees it.
  const exitCandidates = findExitCandidates(outgoing, {
    minOverlapSec: Math.max(minOverlapSec, barSec * minOverlapBars * outgoingRatio),
    requireVocalSafe: requireExitVocalSafe,
  });
  if (exitCandidates.length === 0) return rejected(['no-exit-candidate']);

  const entryCandidates = findEntryCandidates(incoming);
  if (entryCandidates.length === 0) return rejected(['no-entry-candidate']);

  const durationSec = outgoing.durationSec;
  const incomingDurationSec = Number.isFinite(incoming.durationSec) ? incoming.durationSec : Infinity;

  // Codex review (PR #48, round 1): "search order 16 -> 8 -> 4 -> fallback"
  // (§7.2) names three specific tiers, not every integer bar count between
  // them — a dense sweep could land on an unadvertised width like 15 or 10
  // bars. tierBars restricts the per-pair loop below to just the
  // configured stops that are both reachable (<= startBars) and above the
  // hard floor (>= minOverlapBars), widest first.
  const startBars = extendedTierEligible(outgoing, incoming, stemAware) ? MIX_BARS.extended : overlapBars;
  const tierBars = [...new Set([startBars, overlapBars, minOverlapBars])]
    .filter((bars) => bars <= startBars && bars >= minOverlapBars)
    .sort((a, b) => b - a);

  let best = null;
  for (const exit of exitCandidates) {
    const roomAfterExitPlayback = (durationSec - exit.sec) / outgoingRatio;
    for (const entry of entryCandidates) {
      const roomInIncomingPlayback = (incomingDurationSec - entry.sec) / match.ratio;
      // entry.sec itself being vocal-safe (findEntryCandidates()) says
      // nothing about whether the overlap that FOLLOWS it stays clear — an
      // entry 0.1s before firstVocalStartSec, or 0.1s before a gap ends,
      // would otherwise let a multi-bar overlap run straight into vocals.
      // requireEntryForwardSafe=false (stem-mix only) skips this cap: the
      // incoming vocal stem's own delayed start (buildStemEnvelopes()) is
      // what keeps it clear of the outgoing vocal, not forward room in the
      // incoming track's OWN head window.
      const forwardSafePlayback = requireEntryForwardSafe
        ? entryForwardSafeSec(incoming, entry.sec) / match.ratio
        : Infinity;
      for (const bars of tierBars) {
        const fadeSec = barSec * bars;
        if (
          fadeSec > roomAfterExitPlayback + 1e-6
          || fadeSec > roomInIncomingPlayback + 1e-6
          || fadeSec > forwardSafePlayback + 1e-6
        ) continue;
        // Codex review (PR #48, round 1): the extended (16-bar) tier's own
        // eligibility gate (extendedTierEligible(), above) only sees
        // TRACK-WIDE proxies (downbeatGrid.confidence, vocalConfidence) —
        // it has no idea yet which exit/entry pair will actually win. A
        // pair with a strong grid but only a weak/default phrase score
        // (buildPhraseCandidates() scores phrase alignment separately from
        // downbeat-grid confidence) could still reach 16 bars on a track
        // whose overall phrase confidence is high. Gate the 16-bar
        // candidacy on THIS pair's own phraseAlignment specifically; a pair
        // that fails this falls through to the next (narrower) tier in
        // tierBars instead of being rejected outright.
        if (bars === MIX_BARS.extended) {
          const pairPhraseAlignment = clamp01(((exit.score ?? 0) + (entry.score ?? 0)) / 2);
          if (pairPhraseAlignment < EXTENDED_PHRASE_CONFIDENCE_MIN) continue;
        }
        // Codex review (PR #46, round 2): rank pairs by the STRICT (non-
        // relaxed) score even in stem-mix mode. `stemAware` only needs to
        // widen which exits are ELIGIBLE (findExitCandidates() above already
        // does that via requireExitVocalSafe:false) — it must not also make
        // the search itself prefer a mid-vocal exit over an available
        // vocal-safe one of similar quality. Ranking with the relaxed score
        // here let the search settle on a mid-vocal-optimal pair before
        // cross-mode ranking ever ran, which a post-hoc correction on just
        // the single surviving winner (the previous fix) couldn't recover —
        // a pair discarded during this search never comes back.
        const pairScore = scoreTransitionPair({ outgoing, incoming, exit, entry, targetBpm, match, stemAware: false });
        if (!best || pairScore > best.pairScore) best = { exit, entry, bars, fadeSec, pairScore };
        break; // widest bar count that fits this pair is the one worth scoring
      }
    }
  }
  if (!best) return rejected(['no-overlap-fit']);
  if (isMarginalTempo && best.pairScore < MARGINAL_TEMPO_MIN_SCORE) {
    return rejected(['marginal-tempo-low-confidence']);
  }

  // Phase 9D (docs/mix-transition-phase9.md §6.3): the Candidate Ranker
  // needs the winning pair's full quality breakdown, not just its weighted
  // total (`best.pairScore`, which the search loop above used via
  // scoreTransitionPair() for speed — recomputing the detail on every
  // exit/entry/bars combination would be wasted work when only the winner's
  // breakdown is ever surfaced). One extra call here, on the winner alone.
  const quality = scoreTransitionPairDetail({
    outgoing, incoming, exit: best.exit, entry: best.entry, targetBpm, match, stemAware,
  });

  return {
    mode: 'beatmix',
    eligible: true,
    confidence: best.pairScore,
    quality: {
      phraseAlignment: quality.phraseAlignment,
      tempoCompatibility: quality.tempoCompatibility,
      vocalSafety: quality.vocalSafety,
      downbeatConfidence: quality.downbeatConfidence,
      harmonicCompatibility: quality.harmonicCompatibility,
      energyContinuity: quality.energyContinuity,
    },
    targetBpm,
    fadeSec: best.fadeSec,
    outgoing: {
      nativeBpm: outgoingBpm,
      playbackBpm: targetBpm,
      exitStartSec: best.exit.sec,
      exitDownbeatSec: best.exit.sec,
      exitBarIndex: best.exit.barIndex,
      // Phase 8: planStemTransition()'s buildStemEnvelopes() converts native
      // vocal-tail seconds to playback seconds — exposed here so that
      // conversion can reuse the exact ratio this function already computed
      // rather than recomputing it separately (which could silently diverge).
      tempoRatioApplied: outgoingRatio,
    },
    incoming: {
      nativeBpm: incomingBpm,
      playbackBpm: targetBpm,
      tempoRatio: match.ratio,
      tempoFilter: built.filter,
      entrySec: best.entry.sec,
      entryDownbeatSec: best.entry.sec,
      entryBarIndex: best.entry.barIndex,
    },
    sync: { bars: best.bars, beatsPerBar, phaseOffsetSec: 0 },
    eq: { type: 'bass-swap', swapBar: Math.ceil(best.bars / 2), highpassHz: 120 },
    gain: { curve: 'equal-power', fadeInBars: best.bars, fadeOutBars: best.bars },
    reason: ['vocal-safe', 'tempo-compatible', 'downbeat-aligned', ...(best.exit.score > 0 || best.entry.score > 0 ? ['phrase-boundary'] : [])],
  };
}

/**
 * §16 tier 2: phrase + vocal-safe alignment, no tempo sync. Reuses the same
 * candidate search as beatmix but drops the BPM/downbeat-confidence gate —
 * this is meant to still work for tracks with a shaky beat grid as long as
 * phrase boundaries and vocal safety are known.
 */
export function planPhraseCrossfade(outgoing, incoming, {
  minOverlapSec = 1,
  maxOverlapSec = 6,
  outgoingPlaybackBpm = null,
} = {}) {
  if (!outgoing || !incoming) return rejected(['missing-analysis']);

  // Tier 2 is specifically "phrase + vocal-safe" (§16) — unlike tier 1, it
  // must not silently accept findExitCandidates()/findEntryCandidates()'s
  // bare-downbeat degrade, or it stops being distinguishable from a plain
  // downbeat-snapped crossfade when phrase analysis simply never ran.
  const hasTailPhrases = Array.isArray(outgoing.phrases?.tail) && outgoing.phrases.tail.length > 0;
  const hasHeadPhrases = Array.isArray(incoming.phrases?.head) && incoming.phrases.head.length > 0;
  if (!hasTailPhrases || !hasHeadPhrases) return rejected(['no-phrase-data']);

  // Tier 2 applies no NEW tempo stretch, but the outgoing source may already
  // be running at a non-native rate from an earlier (chained) beatmix —
  // fadeSec is a wall-clock/playback duration, so native-timeline room on
  // the outgoing side still needs the same conversion tier 1 uses.
  const outgoingBpm = outgoing.bpm;
  const outgoingTargetBpm = outgoingActualTargetBpm(outgoing, outgoingPlaybackBpm) ?? outgoingBpm;
  const outgoingRatio = outgoingBpm > 0 ? (tempoRatio(outgoingBpm, outgoingTargetBpm) ?? 1) : 1;

  const exitCandidates = findExitCandidates(outgoing, { minOverlapSec: minOverlapSec * outgoingRatio });
  if (exitCandidates.length === 0) return rejected(['no-exit-candidate']);
  const entryCandidates = findEntryCandidates(incoming);
  if (entryCandidates.length === 0) return rejected(['no-entry-candidate']);

  const durationSec = outgoing.durationSec ?? 60;
  const incomingDurationSec = Number.isFinite(incoming.durationSec) ? incoming.durationSec : Infinity;

  // The top-scored exit/entry are not necessarily a *feasible* pair — the
  // highest-scoring entry might sit right before firstVocalStartSec (or a
  // gap's end) with almost no forward room, or close to the incoming
  // source's own end. Search pairs instead of taking [0]/[0] blindly, and
  // cap fadeSec by whichever constraint (outgoing room, incoming source
  // duration, forward vocal-free room) is tightest. Incoming stays in
  // native seconds (tier 2 never stretches it); outgoing room is converted
  // like tier 1's.
  let best = null;
  for (const exit of exitCandidates) {
    const roomAfterExit = (durationSec - exit.sec) / outgoingRatio;
    for (const entry of entryCandidates) {
      const roomInIncoming = incomingDurationSec - entry.sec;
      const forwardSafe = entryForwardSafeSec(incoming, entry.sec);
      const fadeSec = Math.min(maxOverlapSec, roomAfterExit, roomInIncoming, forwardSafe);
      if (fadeSec < minOverlapSec) continue;
      const phraseAlignment = clamp01(((exit.score ?? 0) + (entry.score ?? 0)) / 2);
      if (!best || phraseAlignment > best.phraseAlignment) best = { exit, entry, fadeSec, phraseAlignment };
    }
  }
  if (!best) return rejected(['no-overlap-fit']);

  // Phase 9D (docs/mix-transition-phase9.md §6.3): tier 2 has no tempo sync
  // or downbeat-grid requirement (its whole point is to still work when
  // those aren't available), and doesn't score harmonic compatibility at
  // all — those three quality sub-terms stay null (never fabricated) rather
  // than a misleading 0. vocalSafety/energyContinuity ARE meaningful here
  // (this tier's candidate search enforces the same vocal-safe windows
  // beatmix does) and are computed the same way beatmix's scorer does, from
  // the same winning exit/entry pair.
  const entryMargin = entryVocalMargin(incoming, best.entry.sec);
  const entryVocalSafety = clamp01(entryMargin / VOCAL_MARGIN_FULL_CREDIT_SEC);
  const exitVocalSafety = clamp01(
    (best.exit.sec - (Number.isFinite(outgoing?.lastVocalEndSec) ? outgoing.lastVocalEndSec : 0)) / VOCAL_MARGIN_FULL_CREDIT_SEC,
  );
  const vocalSafety = Math.min(exitVocalSafety, entryVocalSafety);
  const energy = energyContinuity(best.exit, best.entry);

  return {
    mode: 'phrase-crossfade',
    eligible: true,
    confidence: Number(best.phraseAlignment.toFixed(3)),
    quality: {
      phraseAlignment: Number(best.phraseAlignment.toFixed(3)),
      tempoCompatibility: null,
      vocalSafety: Number(vocalSafety.toFixed(3)),
      downbeatConfidence: null,
      harmonicCompatibility: null,
      energyContinuity: Number(energy.toFixed(3)),
    },
    fadeSec: best.fadeSec,
    startSec: best.exit.sec,
    curve: 'equal-power',
    baseSwap: true,
    highpassHz: 120,
    lowshelfGainDb: 2,
    entrySec: best.entry.sec,
    exitBarIndex: best.exit.barIndex,
    entryBarIndex: best.entry.barIndex,
    incomingOffsetSec: 0,
    reason: ['phrase-aligned', 'vocal-safe'],
    outgoingBpm: outgoing.bpm ?? null,
    incomingBpm: incoming.bpm ?? null,
    lastVocalEndSec: outgoing.lastVocalEndSec ?? null,
  };
}

/**
 * The full §16 fallback ladder: beatmix -> phrase-crossfade -> the existing
 * (untouched) planTransition() for crossfade/tail-fade/simple-fade/gapless.
 *
 * Phase 9D (docs/mix-transition-phase9.md §6): player.js no longer calls
 * this — #maybeStartCrossfade() evaluates beatmix/stem-mix/phrase-crossfade
 * as independent candidates via src/audio/transitionCandidates.js's
 * rankTransitionCandidates() and picks a winner by score, rather than
 * taking whichever tier is eligible first. This function (and its own
 * waterfall-shaped tests) is kept exactly as it was — still a fully-built,
 * correct standalone planner, just no longer the one driving live playback.
 */
export function planBeatSyncedTransition(outgoing, incoming, options = {}) {
  const beatmix = planBeatmixTransition(outgoing, incoming, options);
  if (beatmix.eligible) return beatmix;

  const phraseCrossfade = planPhraseCrossfade(outgoing, incoming, options);
  if (phraseCrossfade.eligible) {
    return { ...phraseCrossfade, fallbackFrom: beatmix.reasons };
  }

  const fallback = planTransition(outgoing, incoming, options);
  return { ...fallback, fallbackFrom: [...(beatmix.reasons ?? []), ...(phraseCrossfade.reasons ?? [])] };
}

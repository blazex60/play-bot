import { planBeatmixTransition } from './beatmixTransition.js';

/**
 * Phase 8 (docs/mix-transition-phase8.md): margin (playback seconds) kept
 * between the outgoing vocal stem reaching silence and the incoming vocal
 * stem starting to fade in, so the two never overlap even at a boundary
 * rounding edge. Provisional — see the doc's 未決事項.
 */
export const DEFAULT_VOCAL_CROSSOVER_MARGIN_SEC = 0.2;
/**
 * Codex review (PR #48, round 1): the minimum inVocal.fadeSec that still
 * reads as an actual fade rather than a near-instant onset. The previous
 * check only rejected an EXACTLY zero fade — a long outgoing vocal tail
 * (e.g. ending just before the overlap window closes) can leave inVocal
 * with a few tenths of a second, technically nonzero but audibly
 * indistinguishable from a hard cut once gainForStemPosition() ramps it.
 * Applies uniformly across all bar tiers (not just the Phase 9E extended
 * one) — any tier's stem-mix plan can produce a too-short fade given the
 * right vocal-tail timing, not only 16-bar ones.
 */
export const MIN_MEANINGFUL_INVOCAL_FADE_SEC = 0.5;

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}

/**
 * Shared by buildStemEnvelopes() (final envelope, on the winning pair) and
 * planStemTransition()'s pairFilter (every candidate pair, during the
 * search) — a single source of truth for "how much of this pair's fade
 * window would inVocal actually get" so the two can never silently diverge.
 * @param {object} outgoing analysis (needs lastVocalEndSec)
 * @param {{ exitStartSec: number, outgoingRatio: number, fadeSec: number }} pair
 * @param {number} vocalCrossoverMarginSec
 * @returns {number} inVocal's fadeSec for this pair
 */
function estimateInVocalFadeSec(outgoing, { exitStartSec, outgoingRatio, fadeSec }, vocalCrossoverMarginSec) {
  const lastVocalEndSec = outgoing?.lastVocalEndSec;
  const outVocalTailNativeSec = Number.isFinite(lastVocalEndSec)
    ? Math.max(0, lastVocalEndSec - exitStartSec)
    : 0;
  const outVocalFadeSec = clamp(outVocalTailNativeSec / outgoingRatio, 0, fadeSec);
  const inVocalDelaySec = clamp(outVocalFadeSec + vocalCrossoverMarginSec, 0, fadeSec);
  return Math.max(0, fadeSec - inVocalDelaySec);
}

/**
 * Per-stem gain-envelope descriptors for a `mode: 'stem-mix'` plan. The
 * instrumental pair keeps the plan's own single fadeSec/curve — identical
 * to a plain (non-stem) crossfade's envelope. The vocal pair is where
 * Phase 8's actual behavior lives: outVocal fades out only as long as the
 * outgoing track genuinely still has vocal left at the exit point (0 when
 * it was already vocal-safe — the pre-Phase-8 case, reproduced exactly),
 * and inVocal's start is delayed until outVocal has reached silence (plus
 * a small margin), rather than needing the whole overlap to be vocal-free
 * on both sides the way a plain beatmix transition requires.
 * @param {object} outgoing analysis (needs lastVocalEndSec)
 * @param {object} plan a `planBeatmixTransition()`-shaped eligible plan
 *   (specifically `plan.outgoing.exitStartSec`/`tempoRatioApplied`,
 *   `plan.fadeSec`, `plan.gain.curve`)
 * @param {{ vocalCrossoverMarginSec?: number }} [options]
 * @returns {{ outVocal: object, outInstrumental: object, inInstrumental: object, inVocal: object }}
 */
export function buildStemEnvelopes(outgoing, plan, {
  vocalCrossoverMarginSec = DEFAULT_VOCAL_CROSSOVER_MARGIN_SEC,
} = {}) {
  const fadeSec = plan.fadeSec;
  const curve = plan.gain?.curve ?? 'equal-power';
  const outgoingRatio = plan.outgoing?.tempoRatioApplied ?? 1;
  const exitStartSec = plan.outgoing?.exitStartSec ?? 0;

  const lastVocalEndSec = outgoing?.lastVocalEndSec;
  // Native seconds of outgoing vocal remaining past the exit point, then
  // converted to playback (post-stretch) seconds — same conversion
  // planBeatmixTransition() itself uses for room checks (see its
  // outgoingRatio docstring). 0 (not negative) when the exit point is
  // already past the last vocal frame — today's exact vocal-safe case.
  const outVocalTailNativeSec = Number.isFinite(lastVocalEndSec)
    ? Math.max(0, lastVocalEndSec - exitStartSec)
    : 0;
  const outVocalFadeSec = clamp(outVocalTailNativeSec / outgoingRatio, 0, fadeSec);
  const inVocalDelaySec = clamp(outVocalFadeSec + vocalCrossoverMarginSec, 0, fadeSec);
  const inVocalFadeSec = estimateInVocalFadeSec(
    outgoing, { exitStartSec, outgoingRatio, fadeSec }, vocalCrossoverMarginSec,
  );

  return {
    outVocal: { role: 'out', fadeSec: outVocalFadeSec, curve, startOffsetSec: 0 },
    outInstrumental: { role: 'out', fadeSec, curve, startOffsetSec: 0 },
    inInstrumental: { role: 'in', fadeSec, curve, startOffsetSec: 0 },
    inVocal: {
      role: 'in',
      fadeSec: inVocalFadeSec,
      curve,
      startOffsetSec: inVocalDelaySec,
    },
  };
}

/**
 * Phase 8's actual new capability: a transition where the outgoing track
 * still has vocals active at the exit point is not rejected outright the
 * way a plain beatmix transition must (docs/mix-transition-phase7.md 禁止5
 * — see docs/mix-transition-phase8.md for why this doesn't violate that
 * prohibition's actual intent). Reuses 100% of planBeatmixTransition()'s
 * tempo/downbeat/meter gating and bar-fitting (satisfies 禁止1: still real
 * downbeat alignment, not just BPM match) via its requireExitVocalSafe/
 * requireEntryForwardSafe/stemAware options, then layers the per-stem gain
 * schedule on top. Callers are responsible for only invoking this when both
 * sides' stem audio is actually cached (see stemCache.js) — this function
 * does no caching/availability check itself.
 * @param {object} outgoing analysis
 * @param {object} incoming analysis
 * @param {object} [options] forwarded to planBeatmixTransition()
 * @returns {object} a plan (mode: 'stem-mix', with a `stems` sub-object) when
 *   eligible, or the same `{ mode: null, eligible: false, reasons }` shape
 *   planBeatmixTransition() returns when not.
 */
export function planStemTransition(outgoing, incoming, options = {}) {
  const vocalCrossoverMarginSec = options.vocalCrossoverMarginSec ?? DEFAULT_VOCAL_CROSSOVER_MARGIN_SEC;
  const plan = planBeatmixTransition(outgoing, incoming, {
    ...options,
    requireExitVocalSafe: false,
    requireEntryForwardSafe: false,
    stemAware: true,
    // Codex (round 1) / Codex review (PR #48, round 1 then round 5): when
    // the outgoing vocal tail is long enough to need most or all of the
    // overlap just to fade out, inVocal's own fadeSec shrinks toward 0 —
    // gainForStemPosition() then holds inVocal silent for nearly the entire
    // window and ramps it up over a sliver of a second right as promotion
    // switches to incoming.full (already at its native volume there). That
    // reads as a hard vocal onset, not a fade, even when the fade window is
    // technically nonzero — the whole point of this plan is a genuine fade.
    //
    // Round 1 rejected the whole plan post-hoc, on only the single pair the
    // search had already committed to — the same "post-hoc check can't
    // recover a pair the search already discarded" bug hit independently by
    // stem-mix/phrase-crossfade ranking (rounds 2-3) and the marginal-tempo
    // gate (round 6): a different pair the strict-score race didn't pick
    // (or a narrower tier) could well leave a usable inVocal window. Now
    // filtered per pair, during the search itself, via planBeatmixTransition
    // ()'s generic pairFilter hook — a pair failing this check is simply
    // skipped, letting the search fall through to the next candidate/tier
    // instead of rejecting the whole plan outright.
    pairFilter: ({ exit, fadeSec, outgoingRatio }) => estimateInVocalFadeSec(
      outgoing, { exitStartSec: exit.sec, outgoingRatio, fadeSec }, vocalCrossoverMarginSec,
    ) >= MIN_MEANINGFUL_INVOCAL_FADE_SEC,
  });
  if (!plan.eligible) {
    // Surface the same specific reason external callers/tests have always
    // seen for this case — pairFilter itself is a generic beatmixTransition
    // ()-level concept with no idea WHY a pair was rejected, so the mapping
    // back to this plan's own domain-specific rejection reason happens here.
    if (plan.reasons?.includes('pair-filter-rejected')) {
      return { mode: null, eligible: false, reasons: ['stem-mix-no-invocal-fade-room'] };
    }
    return plan;
  }
  const stems = buildStemEnvelopes(outgoing, plan, options);
  return {
    ...plan,
    mode: 'stem-mix',
    stems,
  };
}

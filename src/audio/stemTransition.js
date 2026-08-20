import { planBeatmixTransition } from './beatmixTransition.js';

/**
 * Phase 8 (docs/mix-transition-phase8.md): margin (playback seconds) kept
 * between the outgoing vocal stem reaching silence and the incoming vocal
 * stem starting to fade in, so the two never overlap even at a boundary
 * rounding edge. Provisional — see the doc's 未決事項.
 */
export const DEFAULT_VOCAL_CROSSOVER_MARGIN_SEC = 0.2;

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
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

  return {
    outVocal: { role: 'out', fadeSec: outVocalFadeSec, curve, startOffsetSec: 0 },
    outInstrumental: { role: 'out', fadeSec, curve, startOffsetSec: 0 },
    inInstrumental: { role: 'in', fadeSec, curve, startOffsetSec: 0 },
    inVocal: {
      role: 'in',
      fadeSec: Math.max(0, fadeSec - inVocalDelaySec),
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
  const plan = planBeatmixTransition(outgoing, incoming, {
    ...options,
    requireExitVocalSafe: false,
    requireEntryForwardSafe: false,
    stemAware: true,
  });
  if (!plan.eligible) return plan;
  const stems = buildStemEnvelopes(outgoing, plan, options);
  // Codex: when the outgoing vocal tail is long enough to need the whole
  // (or more than the) overlap just to fade out, inVocalDelaySec clamps to
  // fadeSec and inVocal's own fadeSec clamps to 0 — gainForStemPosition()
  // then holds inVocal silent for the entire window and jumps it straight
  // to full gain only on the last frame, right as promotion switches to
  // incoming.full (already at its native volume there). That's a hard
  // vocal onset, not a fade — the whole point of this plan. Reject rather
  // than produce a degenerate envelope; the caller's existing ladder falls
  // back to a plain crossfade for a pair like this.
  if (!(stems.inVocal.fadeSec > 0)) {
    return { mode: null, eligible: false, reasons: ['stem-mix-no-invocal-fade-room'] };
  }
  return {
    ...plan,
    mode: 'stem-mix',
    stems,
  };
}

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
/**
 * Phase 9H (docs/mix-transition-phase9.md §10.3): outVocal's release
 * duration once it starts leaving — a short cut near the very end of the
 * remaining vocal, not a fade spanning the whole window (see
 * buildStemEnvelopes() below). §10.4 gives a 200-800ms range; 0.5s is
 * §10.3's own worked example and a reasonable default within that range.
 */
export const DEFAULT_OUTVOCAL_RELEASE_SEC = 0.5;

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
/**
 * Phase 9H (docs/mix-transition-phase9.md §10): splits outVocal's total
 * time-to-silence into hold (full volume) then release, shared by both
 * estimateInVocalFadeSec() (pairFilter-time, during the search) and
 * buildStemEnvelopes() (the final envelope) so the two can never disagree
 * about how much room inVocal actually gets (Codex review, PR #54, P2).
 * Release is gated on holdSec > 0 — when there is no vocal left to hold
 * (the already-vocal-safe case, holdSec 0), there is nothing to release
 * either; adding one anyway would only delay inVocal's own start for no
 * audible reason, regressing Phase 8's original behavior for that case.
 */
function outVocalHoldRelease(outVocalTailNativeSec, outgoingRatio, fadeSec, outVocalReleaseSec) {
  const holdSec = clamp(outVocalTailNativeSec / outgoingRatio, 0, fadeSec);
  const releaseSec = holdSec > 0 ? clamp(outVocalReleaseSec, 0, fadeSec - holdSec) : 0;
  return { holdSec, releaseSec };
}

function estimateInVocalFadeSec(
  outgoing, { exitStartSec, outgoingRatio, fadeSec }, vocalCrossoverMarginSec,
  outVocalReleaseSec = DEFAULT_OUTVOCAL_RELEASE_SEC,
) {
  const lastVocalEndSec = outgoing?.lastVocalEndSec;
  const outVocalTailNativeSec = Number.isFinite(lastVocalEndSec)
    ? Math.max(0, lastVocalEndSec - exitStartSec)
    : 0;
  const { holdSec, releaseSec } = outVocalHoldRelease(outVocalTailNativeSec, outgoingRatio, fadeSec, outVocalReleaseSec);
  const inVocalDelaySec = clamp(holdSec + releaseSec + vocalCrossoverMarginSec, 0, fadeSec);
  return Math.max(0, fadeSec - inVocalDelaySec);
}

/**
 * Per-stem gain-envelope descriptors for a `mode: 'stem-mix'` plan. The
 * instrumental pair keeps the plan's own single fadeSec/curve — identical
 * to a plain (non-stem) crossfade's envelope. The vocal pair is where
 * Phase 8's actual behavior lives: outVocal leaves only as long as the
 * outgoing track genuinely still has vocal left at the exit point (0 when
 * it was already vocal-safe — the pre-Phase-8 case, reproduced exactly),
 * and inVocal's start is delayed until outVocal has reached silence (plus
 * a small margin), rather than needing the whole overlap to be vocal-free
 * on both sides the way a plain beatmix transition requires.
 *
 * Phase 9H (docs/mix-transition-phase9.md §10): outVocal HOLDS at full,
 * unattenuated volume through its entire actual audible duration (through
 * `lastVocalEndSec` itself) instead of fading continuously from bar 0 —
 * §10.1's complaint is that a fade spanning the entire window already
 * audibly weakens the last singing well before the vocal itself ends (by
 * its midpoint, an equal-power curve is already down ~30%). §10.2/§10.4's
 * "hold → phrase end → short release" sequence means the release comes
 * strictly AFTER the vocal's own end, not carved out of its last moments
 * (Codex review, PR #54, P2: an earlier version subtracted the release from
 * the hold instead of adding it after, so the last `outVocalReleaseSec` of
 * real singing was still measurably attenuated — the exact defect §10.1
 * describes, just shrunk to a shorter window instead of eliminated). The
 * release is clamped to whatever room remains in `fadeSec` after the hold
 * — 0 when the vocal already runs to the edge of the transition window,
 * same graceful degradation as Phase 8's own clamp. This pushes the instant
 * outVocal reaches silence PAST Phase 8's original `outVocalFadeSec` (by up
 * to `outVocalReleaseSec`), so `inVocalDelaySec` and
 * `estimateInVocalFadeSec()` (the pairFilter-time twin of this
 * computation, used during candidate search) both now add the release too
 * — they must stay in sync with whatever this function actually produces,
 * or a candidate the search accepted could end up with less inVocal room
 * than it validated.
 * @param {object} outgoing analysis (needs lastVocalEndSec)
 * @param {object} plan a `planBeatmixTransition()`-shaped eligible plan
 *   (specifically `plan.outgoing.exitStartSec`/`tempoRatioApplied`,
 *   `plan.fadeSec`, `plan.gain.curve`)
 * @param {{ vocalCrossoverMarginSec?: number, outVocalReleaseSec?: number }} [options]
 * @returns {{ outVocal: object, outInstrumental: object, inInstrumental: object, inVocal: object }}
 */
export function buildStemEnvelopes(outgoing, plan, {
  vocalCrossoverMarginSec = DEFAULT_VOCAL_CROSSOVER_MARGIN_SEC,
  outVocalReleaseSec = DEFAULT_OUTVOCAL_RELEASE_SEC,
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
  const { holdSec, releaseSec } = outVocalHoldRelease(outVocalTailNativeSec, outgoingRatio, fadeSec, outVocalReleaseSec);
  const inVocalDelaySec = clamp(holdSec + releaseSec + vocalCrossoverMarginSec, 0, fadeSec);
  const inVocalFadeSec = estimateInVocalFadeSec(
    outgoing, { exitStartSec, outgoingRatio, fadeSec }, vocalCrossoverMarginSec, outVocalReleaseSec,
  );

  return {
    outVocal: { role: 'out', fadeSec: releaseSec, curve, startOffsetSec: holdSec },
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
 * Phase 9G (docs/mix-transition-phase9.md §9.1): TransitionPlan v3's
 * `mixZone` descriptor — the overlap window expressed in bar/tempo terms
 * instead of only raw seconds, so MixStream's bar clock (see mixStream.js's
 * #tickStemCrossfade()) and downstream consumers (§9.2's event schedule,
 * future Phase 9H/9I work) have one shared frame of reference.
 * @param {object} plan a planBeatmixTransition()-shaped eligible plan
 * @returns {{ startSec: number|null, durationSec: number|null, bars: number|null, beatsPerBar: number|null, targetBpm: number|null }}
 */
export function buildMixZone(plan) {
  return {
    startSec: plan.outgoing?.exitStartSec ?? null,
    durationSec: plan.fadeSec ?? null,
    bars: plan.sync?.bars ?? null,
    beatsPerBar: plan.sync?.beatsPerBar ?? null,
    targetBpm: plan.targetBpm ?? null,
  };
}

/**
 * Phase 9G §9.2: TransitionPlan v3's `events` array — the bar-timestamped
 * schedule the per-stem envelope timings buildStemEnvelopes() already
 * computes (startOffsetSec/fadeSec, in seconds) implicitly encode, made
 * explicit and consumable by MixStream's bar clock instead of staying
 * buried in raw seconds. MixStream's #tickStemCrossfade() reconstructs its
 * actual per-tick gain envelopes FROM this array (see
 * deriveStemEnvelopesFromEvents() below) rather than reading
 * buildStemEnvelopes()'s raw seconds directly — this array is the thing
 * that drives gain state, not a side-channel notification log layered on
 * top of an unrelated computation (Codex review, PR #53, P1).
 *
 * §9.2's illustrative example also lists 'outgoing-instrumental-duck' —
 * this envelope model has no separate pre-duck hold stage (outInstrumental
 * fades from bar 0 the same as it always has), so that action is omitted
 * rather than emitting a redundant same-bar duplicate of
 * 'incoming-instrumental-start'.
 *
 * 'outgoing-vocal-release' marks the START of outVocal's fade — since
 * Phase 9H (§10), that's `stems.outVocal.startOffsetSec`'s hold boundary,
 * not bar 0: outVocal now holds at full volume until shortly before the
 * vocal's own end, so this event fires much later in the window than it
 * used to (see buildStemEnvelopes()'s holdSec/releaseSec split) — not its
 * completion — "release" names the moment release BEGINS, matching §10.4's
 * own "phrase終了→short release" planner sketch. A separate
 * 'outgoing-vocal-silent' marks the bar outVocal
 * actually reaches silence, for any consumer that needs that instant
 * specifically (Codex review, PR #53, P2: the original version fired
 * 'outgoing-vocal-release' only after the fade had already completed, so
 * an automation consumer acting on it would have found the vocal already
 * gone instead of just starting to leave).
 * @param {object} plan a planBeatmixTransition()-shaped eligible plan
 *   (needs `sync.beatsPerBar`, `targetBpm`, `eq.swapBar`)
 * @param {object} stems buildStemEnvelopes()'s return value
 * @returns {{ bar: number, action: string }[]} sorted ascending by bar
 */
export function buildTransitionEvents(plan, stems) {
  const beatsPerBar = plan.sync?.beatsPerBar;
  const targetBpm = plan.targetBpm;
  const barSec = Number.isFinite(beatsPerBar) && targetBpm > 0
    ? (60 / targetBpm) * beatsPerBar
    : null;
  if (!(barSec > 0)) return [];
  // 6 decimal places (microsecond precision at realistic tempos) keeps
  // deriveStemEnvelopesFromEvents()'s bar->seconds round-trip well under
  // one audio sample's worth of drift from buildStemEnvelopes()'s own
  // seconds-domain numbers.
  const toBar = (sec) => Number((sec / barSec).toFixed(6));

  const events = [
    { bar: toBar(stems.inInstrumental.startOffsetSec), action: 'incoming-instrumental-start' },
    { bar: toBar(stems.outVocal.startOffsetSec), action: 'outgoing-vocal-release' },
    { bar: toBar(stems.outVocal.startOffsetSec + stems.outVocal.fadeSec), action: 'outgoing-vocal-silent' },
    { bar: toBar(stems.inVocal.startOffsetSec), action: 'incoming-vocal-handoff' },
  ];
  if (Number.isFinite(plan.eq?.swapBar)) {
    events.push({ bar: plan.eq.swapBar, action: 'bass-swap' });
  }
  return events.sort((a, b) => a.bar - b.bar);
}

function findEventBar(events, action, fallbackBar) {
  const found = events.find((e) => e.action === action);
  return found ? found.bar : fallbackBar;
}

/**
 * Phase 9G (Codex review, PR #53, P1): the inverse of buildTransitionEvents()
 * — reconstructs the four per-stem gain-envelope descriptors
 * gainForStemPosition() needs FROM the events schedule (+ mixZone for the
 * bar->seconds conversion), instead of reading buildStemEnvelopes()'s raw
 * seconds directly. MixStream.startStemCrossfade() calls this whenever a
 * plan carries events/mixZone, making the schedule the actual thing that
 * drives gain state on every tick — not a side-channel notification stream
 * layered on top of an unrelated computation. Falls back to bar 0 / the
 * window's own start-or-end for any event this schedule doesn't carry
 * (e.g. a hand-built plan missing one action), so a partial schedule still
 * produces a usable (if degenerate) envelope rather than throwing.
 * @param {{ bar: number, action: string }[]} events buildTransitionEvents()'s return value
 * @param {{ bars: number, durationSec: number }} mixZone buildMixZone()'s return value
 * @param {string} [curve]
 * @returns {{ outVocal: object, outInstrumental: object, inInstrumental: object, inVocal: object }}
 */
export function deriveStemEnvelopesFromEvents(events, mixZone, curve = 'equal-power') {
  const barSec = mixZone.durationSec / mixZone.bars;
  const toSec = (bar) => bar * barSec;
  const windowStartBar = findEventBar(events, 'incoming-instrumental-start', 0);
  const windowEndBar = mixZone.bars;
  const outVocalStartBar = findEventBar(events, 'outgoing-vocal-release', windowStartBar);
  const outVocalEndBar = findEventBar(events, 'outgoing-vocal-silent', outVocalStartBar);
  const inVocalStartBar = findEventBar(events, 'incoming-vocal-handoff', windowEndBar);

  const windowStartSec = toSec(windowStartBar);
  const windowFadeSec = Math.max(0, toSec(windowEndBar) - windowStartSec);
  const outVocalStartSec = toSec(outVocalStartBar);
  const outVocalFadeSec = Math.max(0, toSec(outVocalEndBar) - outVocalStartSec);
  const inVocalStartSec = toSec(inVocalStartBar);
  const inVocalFadeSec = Math.max(0, toSec(windowEndBar) - inVocalStartSec);

  return {
    outVocal: { role: 'out', curve, startOffsetSec: outVocalStartSec, fadeSec: outVocalFadeSec },
    outInstrumental: { role: 'out', curve, startOffsetSec: windowStartSec, fadeSec: windowFadeSec },
    inInstrumental: { role: 'in', curve, startOffsetSec: windowStartSec, fadeSec: windowFadeSec },
    inVocal: { role: 'in', curve, startOffsetSec: inVocalStartSec, fadeSec: inVocalFadeSec },
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
  const outVocalReleaseSec = options.outVocalReleaseSec ?? DEFAULT_OUTVOCAL_RELEASE_SEC;
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
    // Codex review (PR #54, P2): must pass the same outVocalReleaseSec
    // buildStemEnvelopes() below will end up using — otherwise a caller
    // overriding it would have the search validate room against one
    // release duration while the final envelope build uses another.
    pairFilter: ({ exit, fadeSec, outgoingRatio }) => estimateInVocalFadeSec(
      outgoing, { exitStartSec: exit.sec, outgoingRatio, fadeSec }, vocalCrossoverMarginSec, outVocalReleaseSec,
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
    mixZone: buildMixZone(plan),
    events: buildTransitionEvents(plan, stems),
  };
}

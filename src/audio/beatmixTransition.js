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
export const BEATMIX_OVERLAP_BARS = 4;
export const MIN_OVERLAP_BARS = 2;
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
 */
export function scoreTransitionPair({
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
  if (harmonicOk) {
    const dist = camelotDistance(outgoing?.tailKey, incoming?.headKey);
    if (dist != null) {
      total += clamp01(1 - dist / MAX_CAMELOT_DISTANCE) * HARMONIC_WEIGHT;
      totalWeight += HARMONIC_WEIGHT;
    }
  }

  return Number(clamp01(total / totalWeight).toFixed(3));
}

function rejected(reasons) {
  return { mode: null, eligible: false, reasons };
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
      for (let bars = overlapBars; bars >= minOverlapBars; bars -= 1) {
        const fadeSec = barSec * bars;
        if (
          fadeSec > roomAfterExitPlayback + 1e-6
          || fadeSec > roomInIncomingPlayback + 1e-6
          || fadeSec > forwardSafePlayback + 1e-6
        ) continue;
        const pairScore = scoreTransitionPair({ outgoing, incoming, exit, entry, targetBpm, match, stemAware });
        if (!best || pairScore > best.pairScore) best = { exit, entry, bars, fadeSec, pairScore };
        break; // widest bar count that fits this pair is the one worth scoring
      }
    }
  }
  if (!best) return rejected(['no-overlap-fit']);
  if (isMarginalTempo && best.pairScore < MARGINAL_TEMPO_MIN_SCORE) {
    return rejected(['marginal-tempo-low-confidence']);
  }

  return {
    mode: 'beatmix',
    eligible: true,
    confidence: best.pairScore,
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

  return {
    mode: 'phrase-crossfade',
    eligible: true,
    confidence: Number(best.phraseAlignment.toFixed(3)),
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
 * Not called from player.js yet — see the module docstring.
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

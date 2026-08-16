import { canTempoMatch, buildTempoFilter, HARD_LIMIT_RATIO } from './tempo.js';
import { camelotDistance } from '../mix/camelot.js';
import { planTransition } from './transition.js';

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

function clamp01(n) {
  return Math.max(0, Math.min(1, n));
}

/**
 * Outgoing tail candidates: phrase boundaries (with their existing bar-
 * multiple/structural/vocal-boundary/near-silence scoring) filtered to the
 * vocal-free window with enough room left for `minOverlapSec`. Degrades to
 * plain downbeats (score 0) when phrase candidates are unavailable, rather
 * than rejecting outright — a downbeat-only exit point is still usable.
 * @returns {{ sec: number, barIndex: number, score: number, reasons: string[] }[]} sorted best-first
 */
export function findExitCandidates(outgoing, { minOverlapSec = 2 } = {}) {
  if (!outgoing) return [];
  const durationSec = outgoing.durationSec;
  if (!(durationSec > 0)) return [];
  const vocalFloor = Number.isFinite(outgoing.lastVocalEndSec) ? outgoing.lastVocalEndSec : 0;
  const phrasePool = Array.isArray(outgoing.phrases?.tail) ? outgoing.phrases.tail : [];
  const pool = phrasePool.length > 0
    ? phrasePool
    : (outgoing.downbeatGrid?.tail?.downbeatsSec ?? []).map((sec, barIndex) => (
      { sec, barIndex, score: 0, reasons: ['downbeat-only'] }
    ));

  return pool
    .filter((c) => c.sec >= vocalFloor - 1e-6 && durationSec - c.sec >= minOverlapSec - 1e-6)
    .sort((a, b) => b.score - a.score || a.sec - b.sec);
}

/**
 * Incoming head candidates: phrase boundaries filtered to vocal-safe
 * positions (before firstVocalStartSec, or inside a headVocalGaps window).
 * A null firstVocalStartSec means no singing was detected in the head
 * window at all — every candidate is safe. Degrades to plain downbeats the
 * same way findExitCandidates() does.
 * @returns {{ sec: number, barIndex: number, score: number, reasons: string[] }[]} sorted best-first
 */
export function findEntryCandidates(incoming) {
  if (!incoming) return [];
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
export function scoreTransitionPair({ outgoing, incoming, exit, entry, targetBpm, match = null }) {
  const exitMargin = exit.sec - (Number.isFinite(outgoing?.lastVocalEndSec) ? outgoing.lastVocalEndSec : 0);
  const entryMargin = Number.isFinite(incoming?.firstVocalStartSec)
    ? incoming.firstVocalStartSec - entry.sec
    : VOCAL_MARGIN_FULL_CREDIT_SEC;
  const vocalSafety = Math.min(
    clamp01(exitMargin / VOCAL_MARGIN_FULL_CREDIT_SEC),
    clamp01(entryMargin / VOCAL_MARGIN_FULL_CREDIT_SEC),
  );

  const phraseAlignment = clamp01(((exit.score ?? 0) + (entry.score ?? 0)) / 2);

  const tempoInfo = match ?? canTempoMatch(incoming?.bpm, targetBpm);
  const tempoCompatibility = tempoInfo?.ratio == null
    ? 0
    : clamp01(1 - Math.abs(tempoInfo.ratio - 1) / HARD_LIMIT_RATIO);

  const downbeatConfidence = clamp01((
    (outgoing?.downbeatGrid?.confidence ?? 0) + (incoming?.downbeatGrid?.confidence ?? 0)
  ) / 2);

  let total = vocalSafety * VOCAL_SAFETY_WEIGHT
    + phraseAlignment * PHRASE_ALIGNMENT_WEIGHT
    + tempoCompatibility * TEMPO_COMPATIBILITY_WEIGHT
    + downbeatConfidence * DOWNBEAT_CONFIDENCE_WEIGHT;
  let totalWeight = VOCAL_SAFETY_WEIGHT + PHRASE_ALIGNMENT_WEIGHT + TEMPO_COMPATIBILITY_WEIGHT + DOWNBEAT_CONFIDENCE_WEIGHT;

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
} = {}) {
  if (!outgoing || !incoming) return rejected(['missing-analysis']);

  const outgoingBpm = outgoing.bpm;
  const incomingBpm = incoming.bpm;
  if (!(outgoingBpm > 0) || !(incomingBpm > 0)) return rejected(['bpm-unavailable']);

  if ((outgoing.beatConfidence ?? 0) < BEAT_CONFIDENCE_MIN || (incoming.beatConfidence ?? 0) < BEAT_CONFIDENCE_MIN) {
    return rejected(['beat-confidence-low']);
  }

  const downbeatConfOutgoing = outgoing.downbeatGrid?.confidence ?? 0;
  const downbeatConfIncoming = incoming.downbeatGrid?.confidence ?? 0;
  if (downbeatConfOutgoing < DOWNBEAT_CONFIDENCE_MIN || downbeatConfIncoming < DOWNBEAT_CONFIDENCE_MIN) {
    return rejected(['downbeat-confidence-low']);
  }

  const targetBpm = outgoingPlaybackBpm ?? outgoingBpm;
  const match = canTempoMatch(incomingBpm, targetBpm);
  if (!match.ok) return rejected([`tempo-ratio-${match.tier ?? 'unrelated'}`]);

  const beatsPerBar = outgoing.downbeatGrid?.meter ?? incoming.downbeatGrid?.meter ?? 4;
  const barSec = (60 / targetBpm) * beatsPerBar;
  if (!(barSec > 0)) return rejected(['invalid-bar-length']);

  const exitCandidates = findExitCandidates(outgoing, { minOverlapSec: Math.max(minOverlapSec, barSec * minOverlapBars) });
  if (exitCandidates.length === 0) return rejected(['no-exit-candidate']);

  const entryCandidates = findEntryCandidates(incoming);
  if (entryCandidates.length === 0) return rejected(['no-entry-candidate']);

  const durationSec = outgoing.durationSec;
  const incomingDurationSec = Number.isFinite(incoming.durationSec) ? incoming.durationSec : Infinity;

  let best = null;
  for (const exit of exitCandidates) {
    const roomAfterExit = durationSec - exit.sec;
    for (const entry of entryCandidates) {
      const roomInIncoming = incomingDurationSec - entry.sec;
      for (let bars = overlapBars; bars >= minOverlapBars; bars -= 1) {
        const fadeSec = barSec * bars;
        if (fadeSec > roomAfterExit + 1e-6 || fadeSec > roomInIncoming + 1e-6) continue;
        const pairScore = scoreTransitionPair({ outgoing, incoming, exit, entry, targetBpm, match });
        if (!best || pairScore > best.pairScore) best = { exit, entry, bars, fadeSec, pairScore };
        break; // widest bar count that fits this pair is the one worth scoring
      }
    }
  }
  if (!best) return rejected(['no-overlap-fit']);

  const built = buildTempoFilter({ nativeBpm: incomingBpm, targetBpm, backend: tempoBackend });

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
export function planPhraseCrossfade(outgoing, incoming, { minOverlapSec = 1, maxOverlapSec = 6 } = {}) {
  if (!outgoing || !incoming) return rejected(['missing-analysis']);

  const exitCandidates = findExitCandidates(outgoing, { minOverlapSec });
  if (exitCandidates.length === 0) return rejected(['no-exit-candidate']);
  const entryCandidates = findEntryCandidates(incoming);
  if (entryCandidates.length === 0) return rejected(['no-entry-candidate']);

  const exit = exitCandidates[0];
  const entry = entryCandidates[0];
  const durationSec = outgoing.durationSec ?? 60;
  const fadeSec = Math.max(minOverlapSec, Math.min(maxOverlapSec, durationSec - exit.sec));
  const phraseAlignment = clamp01(((exit.score ?? 0) + (entry.score ?? 0)) / 2);

  return {
    mode: 'phrase-crossfade',
    eligible: true,
    confidence: Number(phraseAlignment.toFixed(3)),
    fadeSec,
    startSec: exit.sec,
    curve: 'equal-power',
    baseSwap: true,
    highpassHz: 120,
    lowshelfGainDb: 2,
    entrySec: entry.sec,
    exitBarIndex: exit.barIndex,
    entryBarIndex: entry.barIndex,
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

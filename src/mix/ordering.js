import { camelotDistance } from './camelot.js';
import {
  findExitCandidates,
  findEntryCandidates,
  scoreTransitionPair,
  HARMONIC_CONFIDENCE_MIN,
  MIN_OVERLAP_BARS,
} from '../audio/beatmixTransition.js';
import { canTempoMatch } from '../audio/tempo.js';

const DEFAULT_BPM_WEIGHT = 1;
const DEFAULT_KEY_WEIGHT = 1.2;
const DEFAULT_ENERGY_WEIGHT = 0.3;
/**
 * Phase 7E (docs/mix-transition-phase7.md §12): weighted highest of the four
 * terms since scoreTransitionPair() aggregates five sub-signals (vocal
 * safety, phrase alignment, tempo compatibility, downbeat confidence,
 * energy continuity, plus harmonic distance when available) into one
 * richer-than-any-single-term quality signal — provisional pending
 * real-track calibration (§21, same caveat as SOFT_LIMIT_RATIO/
 * HARD_LIMIT_RATIO in tempo.js and BEAT_CONFIDENCE_MIN/
 * DOWNBEAT_CONFIDENCE_MIN in beatmixTransition.js).
 */
const DEFAULT_BEATMIX_WEIGHT = 1.5;
/**
 * Fallback floor only for the (rare) case neither side reports a usable
 * target BPM at all — otherwise minOverlapSecFor() below derives the real
 * MIN_OVERLAP_BARS-based minimum from targetBpm/meter, the same as
 * planBeatmixTransition() does, so ordering doesn't score an edge highly
 * that the live planner would reject outright with no-exit-candidate
 * (Codex round-1 on PR #35).
 */
const MIN_OVERLAP_SEC_FOR_ORDERING = 2;
const MISSING_ANALYSIS_PENALTY = 0.35;
/** Cap greedy/exact work so large imported playlists cannot O(n²)-block the event loop. */
export const MAX_OPTIMIZE_TRACKS = 40;

/**
 * @param {number | null | undefined} bpm
 * @returns {number | null}
 */
function normalizeBpm(bpm) {
  if (!Number.isFinite(bpm) || bpm <= 0) return null;
  return bpm;
}

/**
 * Min BPM delta allowing half/double tempo ambiguity.
 * @param {number | null | undefined} a
 * @param {number | null | undefined} b
 * @returns {number | null}
 */
export function bpmDelta(a, b) {
  const left = normalizeBpm(a);
  const right = normalizeBpm(b);
  if (left == null || right == null) return null;
  const candidates = [
    Math.abs(left - right),
    Math.abs(left - right * 2),
    Math.abs(left * 2 - right),
    Math.abs(left - right / 2),
    Math.abs(left / 2 - right),
  ].filter((n) => Number.isFinite(n));
  return Math.min(...candidates);
}

/**
 * Same targetBpm-derived bar length planBeatmixTransition() uses for its own
 * exit-candidate minimum, so ordering doesn't admit a candidate the live
 * planner would reject with no-exit-candidate for having too little room
 * (Codex round-1 on PR #35). Falls back to the cheap fixed floor only when
 * targetBpm itself is unusable (no bar length can be derived at all).
 * @param {number | null} targetBpm
 * @param {object | null | undefined} fromAnalysis
 * @param {object | null | undefined} toAnalysis
 * @returns {number}
 */
function minOverlapSecFor(targetBpm, fromAnalysis, toAnalysis) {
  if (!(targetBpm > 0)) return MIN_OVERLAP_SEC_FOR_ORDERING;
  const beatsPerBar = fromAnalysis?.downbeatGrid?.meter ?? toAnalysis?.downbeatGrid?.meter ?? 4;
  const barSec = (60 / targetBpm) * beatsPerBar;
  if (!(barSec > 0)) return MIN_OVERLAP_SEC_FOR_ORDERING;
  return Math.max(MIN_OVERLAP_SEC_FOR_ORDERING, barSec * MIN_OVERLAP_BARS);
}

/**
 * Phase 7E: an additional, opt-in cost term layered on top of the base bpm/
 * key/energy terms below, built by reusing Phase 7C's beatmix planner
 * building blocks (findExitCandidates/findEntryCandidates/
 * scoreTransitionPair) rather than reimplementing "tempo stretch required +
 * beatmix feasibility + usable transition window + phrase compatibility" as
 * separate terms — scoreTransitionPair() already combines exactly those
 * signals (plus harmonic distance and energy continuity) into one pure,
 * cached-metadata-only 0..1 quality score.
 *
 * Returns null (not zero) when either side lacks phrase/vocal analysis
 * (pre-v3 cached analysis, or a track whose vocal separation failed), or
 * when outgoing/incoming report incompatible meters (e.g. 3/4 vs 4/4 — bar
 * alignment can never stay synchronized, the same hard-reject
 * planBeatmixTransition() applies) — treated the same as the harmonic
 * term's confidence gate below: an unavailable/inapplicable *richer* signal
 * is skipped rather than penalized, since the base bpm/key/energy terms
 * already cover that pair on their own (Codex round-1 on PR #35).
 * @param {object | null | undefined} fromAnalysis
 * @param {object | null | undefined} toAnalysis
 * @returns {number | null} 0 (great fit) .. 1 (poor fit), or null if unusable
 */
function beatmixCompatibilityCost(fromAnalysis, toAnalysis) {
  const fromMeter = fromAnalysis?.downbeatGrid?.meter ?? null;
  const toMeter = toAnalysis?.downbeatGrid?.meter ?? null;
  if (fromMeter != null && toMeter != null && fromMeter !== toMeter) return null;

  // Ordering has no resolved session tempo (that only exists once a
  // transition is actually armed) — targetBpm/incomingBpm mirror the same
  // tail/head preference planBeatmixTransition() uses, and canTempoMatch()
  // (which tempoRatio() itself is built on) applies the same octave
  // normalization bpmDelta() below already relies on, so the two terms
  // never disagree about a half/double pair being "close" (§12 note).
  //
  // This does NOT account for a chained beatmix having already stretched
  // `fromAnalysis`'s track away from its native tail BPM by the time it
  // would actually play as "outgoing" — ordering has no notion of session
  // tempo propagating through a multi-track path (the DP/greedy loops below
  // only ever look up each track's own native analysis, never a
  // path-dependent stretched tempo). This is a pre-existing property of the
  // whole transitionCost() design (the bpmDelta-based term above has the
  // identical limitation, unchanged since before this term existed) rather
  // than something new here; modeling it correctly needs the DP state
  // itself to carry a running session BPM, a larger change than this
  // opt-in term warrants on its own (Codex round-1 on PR #35).
  const targetBpm = fromAnalysis?.tailBpm ?? fromAnalysis?.bpm ?? null;
  const incomingBpm = toAnalysis?.headBpm ?? toAnalysis?.bpm ?? null;
  const match = canTempoMatch(incomingBpm, targetBpm);

  const exitCandidates = findExitCandidates(fromAnalysis, {
    minOverlapSec: minOverlapSecFor(targetBpm, fromAnalysis, toAnalysis),
  });
  if (exitCandidates.length === 0) return null;
  const entryCandidates = findEntryCandidates(toAnalysis);
  if (entryCandidates.length === 0) return null;

  // Best-scoring exit×entry combination, matching how
  // planBeatmixTransition()/planPhraseCrossfade() themselves search pairs —
  // the single top-ranked phrase candidate on each side isn't necessarily
  // the best-scoring PAIR together (Codex round-1 on PR #35). Candidate
  // pools are small (bounded by phrase analysis output), so this stays
  // cheap even inside optimizeTrackOrder()'s O(n·2^n) exact search.
  let bestScore = 0;
  for (const exit of exitCandidates) {
    for (const entry of entryCandidates) {
      const score = scoreTransitionPair({
        outgoing: fromAnalysis,
        incoming: toAnalysis,
        exit,
        entry,
        targetBpm,
        match,
      });
      if (score > bestScore) bestScore = score;
    }
  }
  return 1 - bestScore;
}

/**
 * @param {object | null | undefined} fromAnalysis
 * @param {object | null | undefined} toAnalysis
 * @param {{ bpmWeight?: number, keyWeight?: number, energyWeight?: number, beatmixWeight?: number }} [weights]
 * @returns {number}
 */
export function transitionCost(fromAnalysis, toAnalysis, weights = {}) {
  const bpmWeight = weights.bpmWeight ?? DEFAULT_BPM_WEIGHT;
  const keyWeight = weights.keyWeight ?? DEFAULT_KEY_WEIGHT;
  const energyWeight = weights.energyWeight ?? DEFAULT_ENERGY_WEIGHT;
  const beatmixWeight = weights.beatmixWeight ?? DEFAULT_BEATMIX_WEIGHT;

  let cost = 0;
  let parts = 0;

  const delta = bpmDelta(fromAnalysis?.bpm, toAnalysis?.bpm);
  if (delta != null) {
    // 20 BPM difference ≈ cost 1.0
    cost += bpmWeight * Math.min(2, delta / 20);
    parts += 1;
  } else {
    cost += MISSING_ANALYSIS_PENALTY * bpmWeight;
  }

  const harmonicOk = (fromAnalysis?.harmonicConfidence ?? 0) >= HARMONIC_CONFIDENCE_MIN
    && (toAnalysis?.harmonicConfidence ?? 0) >= HARMONIC_CONFIDENCE_MIN;
  if (harmonicOk) {
    const keyDist = camelotDistance(
      fromAnalysis?.tailKey ?? fromAnalysis?.headKey,
      toAnalysis?.headKey,
    );
    if (keyDist != null) {
      cost += keyWeight * Math.min(2, keyDist / 2);
      parts += 1;
    } else {
      cost += MISSING_ANALYSIS_PENALTY * keyWeight;
    }
  }

  const fromEnergy = fromAnalysis?.lastRms;
  const toEnergy = toAnalysis?.lastRms;
  if (Number.isFinite(fromEnergy) && Number.isFinite(toEnergy)) {
    cost += energyWeight * Math.min(1, Math.abs(fromEnergy - toEnergy) / 12);
    parts += 1;
  }

  const beatmixCost = beatmixCompatibilityCost(fromAnalysis, toAnalysis);
  if (beatmixCost != null) {
    cost += beatmixWeight * beatmixCost;
    parts += 1;
  }

  return parts > 0 ? cost / parts : 1;
}

/**
 * @param {number[]} order
 * @param {number} length
 * @returns {boolean}
 */
export function isValidPermutation(order, length) {
  if (!Array.isArray(order) || order.length !== length) return false;
  const seen = new Set();
  for (const idx of order) {
    if (!Number.isInteger(idx) || idx < 0 || idx >= length || seen.has(idx)) return false;
    seen.add(idx);
  }
  return seen.size === length;
}

/**
 * Held-Karp TSP for small upcoming queues; greedy fallback for larger ones.
 * Queues longer than `maxTracks` only optimize a prefix; the rest keep original order.
 * @param {{
 *   anchorAnalysis?: object | null,
 *   tracks: object[],
 *   analyses?: (object | null)[],
 *   maxExact?: number,
 *   maxTracks?: number,
 * }} args
 * @returns {number[]} permutation of track indices (0..n-1)
 */
export function optimizeTrackOrder({
  anchorAnalysis = null,
  tracks,
  analyses = [],
  maxExact = 10,
  maxTracks = MAX_OPTIMIZE_TRACKS,
}) {
  const n = tracks.length;
  if (n <= 1) return [...Array(n).keys()];

  if (n > maxTracks) {
    const headOrder = optimizeTrackOrder({
      anchorAnalysis,
      tracks: tracks.slice(0, maxTracks),
      analyses: analyses.slice(0, maxTracks),
      maxExact,
      maxTracks,
    });
    const tail = Array.from({ length: n - maxTracks }, (_, i) => i + maxTracks);
    return [...headOrder, ...tail];
  }

  const analysisAt = (idx) => analyses[idx] ?? null;

  if (n <= maxExact) {
    const memo = new Map();

    /** @param {number} mask @param {number} lastIdx @returns {number} */
    function dpCost(mask, lastIdx) {
      if (mask === (1 << n) - 1) return 0;
      const key = `${mask}:${lastIdx}`;
      if (memo.has(key)) return memo.get(key);

      let best = Infinity;
      for (let next = 0; next < n; next += 1) {
        if (mask & (1 << next)) continue;
        const from = lastIdx === -1 ? anchorAnalysis : analysisAt(lastIdx);
        const edge = transitionCost(from, analysisAt(next));
        const rest = dpCost(mask | (1 << next), next);
        best = Math.min(best, edge + rest);
      }
      memo.set(key, best);
      return best;
    }

    /** @param {number} mask @param {number} lastIdx @returns {number[]} */
    function reconstruct(mask, lastIdx) {
      if (mask === (1 << n) - 1) return [];
      let bestNext = -1;
      let bestCost = Infinity;
      for (let next = 0; next < n; next += 1) {
        if (mask & (1 << next)) continue;
        const from = lastIdx === -1 ? anchorAnalysis : analysisAt(lastIdx);
        const edge = transitionCost(from, analysisAt(next));
        const rest = dpCost(mask | (1 << next), next);
        const total = edge + rest;
        if (total < bestCost) {
          bestCost = total;
          bestNext = next;
        }
      }
      return [bestNext, ...reconstruct(mask | (1 << bestNext), bestNext)];
    }

    return reconstruct(0, -1);
  }

  // Greedy nearest-neighbor from anchor/current.
  const remaining = new Set(Array.from({ length: n }, (_, i) => i));
  const order = [];
  let lastAnalysis = anchorAnalysis;
  while (remaining.size > 0) {
    let bestIdx = null;
    let bestCost = Infinity;
    for (const idx of remaining) {
      const cost = transitionCost(lastAnalysis, analysisAt(idx));
      if (cost < bestCost) {
        bestCost = cost;
        bestIdx = idx;
      }
    }
    order.push(bestIdx);
    remaining.delete(bestIdx);
    lastAnalysis = analysisAt(bestIdx);
  }
  return order;
}

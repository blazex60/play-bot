import { camelotDistance } from './camelot.js';
import {
  findExitCandidates,
  findEntryCandidates,
  scoreTransitionPair,
  entryForwardSafeSec,
  hasVocalAnalysis,
  HARMONIC_CONFIDENCE_MIN,
  BEAT_CONFIDENCE_MIN,
  DOWNBEAT_CONFIDENCE_MIN,
  MARGINAL_TEMPO_MIN_SCORE,
  MIN_OVERLAP_BARS,
} from '../audio/beatmixTransition.js';
import { canTempoMatch, buildTempoFilter } from '../audio/tempo.js';
import { isHalfDouble } from '../audio/trackAnalysis.js';

export const DEFAULT_BPM_WEIGHT = 1;
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
export const DEFAULT_BEATMIX_WEIGHT = 1.5;
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

/** Full penalty for a positively-identified beatmix infeasibility (see below). */
export const BEATMIX_INFEASIBLE_COST = 1;

/**
 * hasVocalAnalysis() alone only proves vocal separation succeeded — that
 * field predates v3 (Phase 6), so a v2-cached row has
 * `analysisSource: 'demucs'` too, despite having none of v3's
 * beatConfidence/downbeatGrid/phrases fields at all. Requiring a finite
 * beatConfidence (v3-only, set unconditionally whenever v3 analysis ran)
 * distinguishes "real v3 data" from "just has a valid vocal-analysis
 * result," so a v2 row correctly falls through to null (skipped) below
 * instead of every one of its edges getting the full infeasibility penalty
 * for fields it was never actually evaluated against (Codex round-5 on
 * PR #35).
 * @param {object | null | undefined} analysis
 * @returns {boolean}
 */
function hasBeatmixAnalysis(analysis) {
  return hasVocalAnalysis(analysis) && Number.isFinite(analysis?.beatConfidence);
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
 * Returns null (not zero, not penalized — the term is simply skipped, same
 * treatment as the harmonic term's confidence gate below) only when either
 * side lacks real v3 beatmix analysis entirely (pre-v3/v2 cached analysis,
 * or a track whose vocal separation failed) — checked via
 * hasBeatmixAnalysis() FIRST, before any other gate below runs, so a track
 * with e.g. a leftover downbeatGrid.meter but analysisSource:'none' (vocal
 * separation failed), or a v2 row with no v3 fields at all, can't get
 * flagged as a "confirmed" infeasibility it was never actually evaluated
 * for (Codex round-3/round-5 on PR #35).
 *
 * Once both sides are confirmed to carry real v3 data, every *positively
 * identified* incompatibility below — incompatible meters, sub-threshold
 * beat/downbeat-grid confidence, a tempo ratio beyond the hard stretch
 * limit or genuinely unrelated to the target's octave, an octave-related-
 * but-bar-mismatched tempo, a stretch the given tempoBackend can't actually
 * build a filter for, or no exit/entry pair with enough forward room —
 * gets the maximum penalty (BEATMIX_INFEASIBLE_COST) rather than null.
 * Returning null there would make a confirmed-bad pair cost exactly the
 * same as "no data" and cheaper than a genuinely good but imperfectly-
 * scored pair, since transitionCost() averages only the terms that fire —
 * the optimizer must never prefer a transition planBeatmixTransition()
 * would hard-reject over one it would actually accept (Codex round-2/
 * round-3/round-5/round-6, CodeRabbit round-2 on PR #35).
 * @param {object | null | undefined} fromAnalysis
 * @param {object | null | undefined} toAnalysis
 * @param {string | null} [tempoBackend] Result of tempo.js's
 *   probeTempoBackend() ('rubberband'|'atempo'|null) — the tempo-filter
 *   gate below only runs when this is explicitly passed (including an
 *   explicit `null` meaning "probed, nothing usable found"); when the
 *   caller hasn't done the probe at all (undefined, the default), the
 *   backend is genuinely unknown rather than positively identified as
 *   unavailable, so the gate is skipped — consistent with every other gate
 *   here only penalizing confirmed infeasibilities, never mere unknowns
 *   (Codex round-6 on PR #35).
 * @returns {number | null} 0 (great fit) .. 1 (poor fit), or null if unusable
 */
function beatmixCompatibilityCost(fromAnalysis, toAnalysis, tempoBackend) {
  if (!hasBeatmixAnalysis(fromAnalysis) || !hasBeatmixAnalysis(toAnalysis)) return null;

  const fromMeter = fromAnalysis.downbeatGrid?.meter ?? null;
  const toMeter = toAnalysis.downbeatGrid?.meter ?? null;
  if (fromMeter != null && toMeter != null && fromMeter !== toMeter) {
    return BEATMIX_INFEASIBLE_COST;
  }

  if (
    (fromAnalysis.beatConfidence ?? 0) < BEAT_CONFIDENCE_MIN
    || (toAnalysis.beatConfidence ?? 0) < BEAT_CONFIDENCE_MIN
  ) {
    return BEATMIX_INFEASIBLE_COST;
  }
  if (
    (fromAnalysis.downbeatGrid?.confidence ?? 0) < DOWNBEAT_CONFIDENCE_MIN
    || (toAnalysis.downbeatGrid?.confidence ?? 0) < DOWNBEAT_CONFIDENCE_MIN
  ) {
    return BEATMIX_INFEASIBLE_COST;
  }

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
  const targetBpm = fromAnalysis.tailBpm ?? fromAnalysis.bpm ?? null;
  const incomingBpm = toAnalysis.headBpm ?? toAnalysis.bpm ?? null;
  const match = canTempoMatch(incomingBpm, targetBpm);

  // !match.ok covers two distinct cases planBeatmixTransition() rejects
  // identically via its own `if (!match.ok)` check: a real ratio beyond the
  // hard stretch limit (tier: 'exceeds-hard', match.ratio non-null), and a
  // target/incoming pair with NO octave relation at all (canTempoMatch()
  // itself applies the octave normalization that makes a half/double pair
  // look "related" in the first place, so failing to find any candidate in
  // range means genuinely unrelated tempos, tier: null, match.ratio null).
  // scoreTransitionPair() only folds tempo into ONE of five weighted
  // sub-signals (tempoCompatibility), so vocal safety/phrase/downbeat/
  // energy can still add up to a deceptively decent score for a pair that
  // can never actually beatmix in either case.
  //
  // The targetBpm/incomingBpm != null guard is what keeps this from
  // over-penalizing: canTempoMatch() returns the identical
  // { ok: false, ratio: null } shape whether the BPMs are genuinely
  // unrelated OR one side's BPM is simply missing (a "no data" case the
  // base bpm/key/energy terms already cover, not a positively identified
  // incompatibility) — only having both real BPM values in hand lets us
  // tell those two apart (CodeRabbit round-2, Codex round-5 on PR #35).
  if (!match.ok && targetBpm != null && incomingBpm != null) return BEATMIX_INFEASIBLE_COST;

  // canTempoMatch()/tempoRatio() normalize incomingBpm into targetBpm's
  // octave band before taking a ratio, so a genuine half/double pair (e.g.
  // 60 vs 120) reads as an excellent match.ratio here — but the incoming
  // track's REAL downbeat grid has a bar length built on its own (unhalved/
  // undoubled) native BPM, so its actual downbeats only land on every other
  // (or every 2nd-of-half) computed bar boundary. planBeatmixTransition()
  // separately hard-rejects this with 'octave-bar-mismatch' even when
  // match.ok is true (Codex round-3 on PR #35).
  if (isHalfDouble(incomingBpm, targetBpm)) return BEATMIX_INFEASIBLE_COST;

  // planBeatmixTransition() rejects with 'tempo-filter-unavailable' when a
  // non-identity stretch is needed but buildTempoFilter() can't produce a
  // filter for the ACTUAL runtime backend — rubberband covers the full
  // hard-limit range, atempo only the narrower soft-limit (marginal-tier
  // stretches fail), and no backend at all rejects any stretch outright.
  // scoreTransitionPair() has no notion of backend, so without this a
  // marginal-tempo pair could still score decently and get prioritized in
  // an environment where the only available backend can't actually build
  // its filter (Codex round-6 on PR #35).
  if (tempoBackend !== undefined) {
    const built = buildTempoFilter({ nativeBpm: incomingBpm, targetBpm, backend: tempoBackend });
    if (built.filter == null && Math.abs((match.ratio ?? 1) - 1) > 1e-9) {
      return BEATMIX_INFEASIBLE_COST;
    }
  }

  const minOverlapSec = minOverlapSecFor(targetBpm, fromAnalysis, toAnalysis);
  const exitCandidates = findExitCandidates(fromAnalysis, { minOverlapSec });
  const entryCandidates = findEntryCandidates(toAnalysis);
  // Both sides are already confirmed to carry real v3 data (the
  // hasVocalAnalysis() check at the top) — an empty result here means every
  // candidate was conclusively filtered out (too close to vocals, not
  // enough room), a positively identified no-fit, not missing analysis
  // (Codex round-3 on PR #35).
  if (exitCandidates.length === 0 || entryCandidates.length === 0) {
    return BEATMIX_INFEASIBLE_COST;
  }

  // Best-scoring exit×entry combination, matching how
  // planBeatmixTransition()/planPhraseCrossfade() themselves search pairs —
  // the single top-ranked phrase candidate on each side isn't necessarily
  // the best-scoring PAIR together (Codex round-1 on PR #35). Candidate
  // pools are small (bounded by phrase analysis output), so this stays
  // cheap even inside optimizeTrackOrder()'s O(n·2^n) exact search (edge
  // costs are themselves cached per (from, to) pair there — see
  // optimizeTrackOrder()'s edgeCost()).
  //
  // entryForwardSafeSec() mirrors findExitCandidates()'s own minOverlapSec
  // filter but for the incoming side: findEntryCandidates() only checks
  // that entry.sec itself is vocal-safe, not that enough vocal-free room
  // follows it for a real overlap — planBeatmixTransition() applies this
  // exact check (forwardSafePlayback) before ever scoring a pair (Codex
  // round-2 on PR #35). Both this and the incoming-duration room below are
  // divided by match.ratio to convert native seconds into playback-domain
  // seconds (the incoming source is being stretched by that ratio) before
  // comparing against minOverlapSec, which is itself already a
  // playback-domain (target-BPM-derived) duration — planBeatmixTransition()
  // applies the identical conversion (Codex round-3 on PR #35). A candidate
  // that fails either filter on every exit partner naturally leaves
  // bestScore at 0, i.e. the same BEATMIX_INFEASIBLE_COST as any other
  // confirmed no-fit case.
  const incomingDurationSec = Number.isFinite(toAnalysis.durationSec) ? toAnalysis.durationSec : Infinity;
  let bestScore = 0;
  for (const exit of exitCandidates) {
    for (const entry of entryCandidates) {
      const forwardSafePlayback = match.ratio != null
        ? entryForwardSafeSec(toAnalysis, entry.sec) / match.ratio
        : entryForwardSafeSec(toAnalysis, entry.sec);
      if (forwardSafePlayback + 1e-6 < minOverlapSec) continue;
      const roomInIncomingPlayback = match.ratio != null
        ? (incomingDurationSec - entry.sec) / match.ratio
        : (incomingDurationSec - entry.sec);
      if (roomInIncomingPlayback + 1e-6 < minOverlapSec) continue;
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

  // §8.3: planBeatmixTransition() only takes the 4-6% "marginal" tempo tier
  // "when confidence/transition conditions are high" — it rejects the best
  // pair outright (marginal-tempo-low-confidence) if its score falls below
  // MARGINAL_TEMPO_MIN_SCORE, regardless of how good the other sub-signals
  // are. Without this gate a marginal-tempo pair with a mediocre overall
  // score would still get partial credit here instead of the full
  // infeasibility penalty the live planner would apply (Codex round-4 on
  // PR #35).
  if (match.tier === 'marginal' && bestScore < MARGINAL_TEMPO_MIN_SCORE) {
    return BEATMIX_INFEASIBLE_COST;
  }

  return 1 - bestScore;
}

/**
 * @param {object | null | undefined} fromAnalysis
 * @param {object | null | undefined} toAnalysis
 * @param {{
 *   bpmWeight?: number, keyWeight?: number, energyWeight?: number, beatmixWeight?: number,
 *   tempoBackend?: string | null,
 * }} [weights] `tempoBackend` is tempo.js's probeTempoBackend() result — see
 *   beatmixCompatibilityCost()'s docstring for why leaving it unset differs
 *   from explicitly passing `null`.
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

  const beatmixCost = beatmixCompatibilityCost(fromAnalysis, toAnalysis, weights.tempoBackend);
  if (beatmixCost != null) {
    if (beatmixCost === BEATMIX_INFEASIBLE_COST) {
      // Codex round-7 on PR #35: bpm/key/energy sub-scores cap at 2, 2, and 1
      // respectively (before weighting), while beatmixCost caps at 1 — so
      // blending a maxed-out beatmix term into the same cost/parts average
      // as already-near-capped bpm/key terms can *lower* the average versus
      // leaving beatmix out entirely (a maxed lower-ceiling term dilutes an
      // already-maxed higher-ceiling set). A positively identified
      // infeasibility must never make an edge look better than the same
      // edge scored without beatmix data, so add its penalty on top of the
      // other terms' own average instead of folding it into a shared
      // denominator.
      const baseCost = parts > 0 ? cost / parts : 1;
      return baseCost + beatmixWeight * BEATMIX_INFEASIBLE_COST;
    }
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
 *   tempoBackend?: string | null,
 * }} args `tempoBackend` should be the caller's own tempo.js probeTempoBackend()
 *   result (probed once, before calling this — see transitionCost()'s
 *   docstring); omit it to leave the beatmix term's tempo-filter
 *   availability gate unapplied.
 * @returns {number[]} permutation of track indices (0..n-1)
 */
export function optimizeTrackOrder({
  anchorAnalysis = null,
  tracks,
  analyses = [],
  maxExact = 10,
  maxTracks = MAX_OPTIMIZE_TRACKS,
  tempoBackend,
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
      tempoBackend,
    });
    const tail = Array.from({ length: n - maxTracks }, (_, i) => i + maxTracks);
    return [...headOrder, ...tail];
  }

  const analysisAt = (idx) => analyses[idx] ?? null;

  if (n <= maxExact) {
    const memo = new Map();
    // transitionCost(from, next) only depends on the (lastIdx, next) pair,
    // never on `mask` — but dpCost()/reconstruct() are called once per DP
    // state, so without this cache the same edge (and, since Phase 7E, its
    // O(exitCandidates * entryCandidates) beatmix pair search) gets
    // recomputed once per state that reaches it: O(2^n * n) edge
    // evaluations instead of the O(n^2) distinct directed edges that
    // actually exist. At n=maxExact=10 that's ~10x more DP states alone,
    // each potentially re-running a beatmix search over real-world
    // candidate pools (~20-25 tail x ~15-20 head), which was measured to
    // block the event loop past the /internal/optimize-order route's 5s
    // timeout (Codex round-2 on PR #35).
    const edgeCostCache = new Map();
    /** @param {number} lastIdx @param {number} next @returns {number} */
    function edgeCost(lastIdx, next) {
      const key = `${lastIdx}:${next}`;
      if (edgeCostCache.has(key)) return edgeCostCache.get(key);
      const from = lastIdx === -1 ? anchorAnalysis : analysisAt(lastIdx);
      const cost = transitionCost(from, analysisAt(next), { tempoBackend });
      edgeCostCache.set(key, cost);
      return cost;
    }

    /** @param {number} mask @param {number} lastIdx @returns {number} */
    function dpCost(mask, lastIdx) {
      if (mask === (1 << n) - 1) return 0;
      const key = `${mask}:${lastIdx}`;
      if (memo.has(key)) return memo.get(key);

      let best = Infinity;
      for (let next = 0; next < n; next += 1) {
        if (mask & (1 << next)) continue;
        const edge = edgeCost(lastIdx, next);
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
        const edge = edgeCost(lastIdx, next);
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
      const cost = transitionCost(lastAnalysis, analysisAt(idx), { tempoBackend });
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

import { recordTransition } from './transitionMetrics.js';

/**
 * Phase 9A (docs/mix-transition-phase9.md §3): transition observability.
 * This module is pure presentation/bookkeeping — it does not decide
 * anything about which transition mode gets used (that judgment stays in
 * beatmixTransition.js/stemTransition.js/transition.js, called from
 * player.js's existing fallback ladder). It only describes, after the fact,
 * a decision player.js already made.
 */

function num(n, digits = 2) {
  return Number.isFinite(n) ? n.toFixed(digits) : 'null';
}

function fmtBool(b) {
  return b == null ? 'null' : String(b);
}

// Codex review (PR #43, round 7): track titles come from yt-dlp/YouTube
// metadata and are not trusted — a title containing a quote or newline,
// interpolated raw into `from="..."`, could forge fields or fake an
// additional `[MIX PLAN]` entry in the MIX_DEBUG log output. JSON.stringify
// produces a properly quoted, escaped representation (quotes, backslashes,
// newlines all escaped) while staying readable in a log line.
function escapeLogTitle(title) {
  return title == null ? 'unknown' : JSON.stringify(String(title));
}

/**
 * Reduce a beatmix-shaped plan (`planBeatmixTransition()`/`planStemTransition()`
 * output) to the §3.2 candidate fields. `mode` is the plan's own `mode`
 * string ('beatmix' or 'stem-mix') — pass the plan only when it's the one
 * actually produced for that slot; pass null with a reason string when the
 * slot was never evaluated at all (short-circuited by the fallback ladder),
 * which is itself useful observability distinct from "evaluated and
 * rejected".
 */
function barredCandidate(plan, notEvaluatedReason) {
  if (!plan) return { eligible: false, reason: notEvaluatedReason };
  if (plan.eligible) {
    return {
      eligible: true,
      bars: plan.sync?.bars ?? null,
      fadeSec: plan.fadeSec,
      score: plan.confidence,
    };
  }
  return { eligible: false, reason: plan.reasons?.[0] ?? 'unknown' };
}

/**
 * Same idea as barredCandidate() for planPhraseCrossfade()'s plan shape,
 * which has no bar/downbeat concept (tier 2 never requires a beat grid).
 */
function phraseCandidate(eligiblePlan, rejectedReason, notEvaluatedReason) {
  if (eligiblePlan) {
    return {
      eligible: true,
      fadeSec: eligiblePlan.fadeSec,
      score: eligiblePlan.confidence,
    };
  }
  if (rejectedReason !== undefined) return { eligible: false, reason: rejectedReason ?? 'unknown' };
  return { eligible: false, reason: notEvaluatedReason };
}

/**
 * Build the observability payload for one transition decision.
 *
 * `rawPlan` is planBeatSyncedTransition()'s return value (the §16 ladder:
 * beatmix -> phrase-crossfade -> legacy planTransition()). `stemPlan` is
 * player.js's independent planStemTransition() attempt (Phase 8), or null
 * when it was never attempted (beatmix already won, or the pair is marked
 * `#stemMixUnavailableKey`, or the stem cache lookup itself was never run).
 *
 * Only beatmix/phrase-crossfade's OWN eligibility is read from rawPlan —
 * this never calls planBeatmixTransition()/planPhraseCrossfade() a second
 * time. When rawPlan.mode === 'beatmix', tier 2 was short-circuited by the
 * ladder (see beatmixTransition.js's planBeatSyncedTransition()) and
 * genuinely was not evaluated; that is reported as such rather than
 * guessed at.
 *
 * @param {object} params
 * @param {{title:string}} params.outgoingTrack
 * @param {{title:string}} params.incomingTrack
 * @param {object} params.outgoingAnalysis
 * @param {object} params.incomingAnalysis
 * @param {object} params.rawPlan
 * @param {object|null} params.stemPlan
 * @param {boolean} params.stemCacheAttempted whether the stem-cache lookup
 *   actually ran this tick (false when short-circuited by beatmix already
 *   winning, or by `#stemMixUnavailableKey`).
 * @param {boolean} params.outgoingStemsCached
 * @param {boolean} params.incomingStemsCached
 * @param {string} params.plannedMode the ladder's initial choice
 *   ('stem-mix' when stemPlan is eligible, else rawPlan.mode) — before any
 *   later downgrade (TRACK loop mode / an incoming source that couldn't
 *   honor a seek+stretch). player.js fills in `.selected`/`.downgradedFrom`
 *   itself once the final, actually-executed mode is known.
 * @returns {object} the structured report — pass to logTransitionPlan().
 */
export function buildTransitionPlanReport({
  outgoingTrack,
  incomingTrack,
  outgoingAnalysis,
  incomingAnalysis,
  rawPlan,
  stemPlan,
  stemCacheAttempted,
  outgoingStemsCached,
  incomingStemsCached,
  plannedMode,
  // Codex review (PR #43, round 5): the outgoing session's tempo stretch
  // ratio, so the legacy-plan exit fallback (a native-file position) can
  // convert player.js's playback-domain fadeSec back to native seconds the
  // same way #maybeStartCrossfade()'s own compensateDurationSec() call
  // does — 1 (no stretch) when the caller doesn't pass one.
  outgoingTempoRatio = 1,
}) {
  const beatmixEligiblePlan = rawPlan.mode === 'beatmix' ? rawPlan : null;
  const beatmixNotEvaluatedReason = rawPlan.fallbackFrom?.[0] ?? 'unknown';
  const beatmix = barredCandidate(beatmixEligiblePlan, beatmixNotEvaluatedReason);

  const phraseEligiblePlan = rawPlan.mode === 'phrase-crossfade' ? rawPlan : null;
  const phraseCrossfade = rawPlan.mode === 'beatmix'
    ? phraseCandidate(null, undefined, 'not-evaluated-beatmix-selected')
    : phraseCandidate(phraseEligiblePlan, rawPlan.fallbackFrom?.[1] ?? 'unknown');

  let stemMix;
  if (!stemCacheAttempted) {
    stemMix = { eligible: false, reason: rawPlan.mode === 'beatmix' ? 'not-evaluated-beatmix-selected' : 'not-evaluated-stem-mix-unavailable' };
  } else if (!(outgoingStemsCached && incomingStemsCached)) {
    stemMix = { eligible: false, reason: 'stem-cache-miss' };
  } else {
    stemMix = barredCandidate(stemPlan, 'unknown');
  }

  const stemCache = {
    outgoing: stemCacheAttempted ? (outgoingStemsCached ? 'hit' : 'miss') : null,
    incoming: stemCacheAttempted ? (incomingStemsCached ? 'hit' : 'miss') : null,
  };

  const plannedSource = stemPlan?.eligible ? stemPlan : rawPlan;
  const exit = exitInfo(plannedSource, outgoingAnalysis, outgoingTempoRatio);
  const entry = entryInfo(plannedSource, incomingAnalysis);

  return {
    from: outgoingTrack?.title ?? null,
    to: incomingTrack?.title ?? null,
    selected: plannedMode,
    downgradedFrom: null,
    candidates: { beatmix, stemMix, phraseCrossfade },
    stemCache,
    exit,
    entry,
  };
}

/**
 * Codex review (PR #43): `lastVocalEndSec > sec` alone only proves *some*
 * later vocal exists — the exit itself can sit inside a `vocalGaps` window
 * (silence between phrases), where treating it as "vocal active" mislabels
 * why a transition was selected. An exit sec inside a recorded gap counts
 * as inactive even when a later vocal phrase would still make
 * `lastVocalEndSec > sec` true.
 */
function isInsideVocalGap(sec, vocalGaps) {
  if (!Array.isArray(vocalGaps) || sec == null) return false;
  return vocalGaps.some((gap) => sec >= gap.startSec && sec < gap.endSec);
}

function exitInfo(plan, outgoingAnalysis, outgoingTempoRatio = 1) {
  let sec = null;
  let bar = null;
  if (plan.mode === 'beatmix' || plan.mode === 'stem-mix') {
    sec = plan.outgoing?.exitStartSec ?? null;
    bar = plan.outgoing?.exitBarIndex ?? null;
  } else if (plan.mode === 'phrase-crossfade') {
    sec = plan.startSec ?? null;
    bar = plan.exitBarIndex ?? null;
  } else {
    // Codex review (PR #43): legacy plans (simple-fade/tail-fade/crossfade)
    // carry no exit timestamp of their own — player.js itself falls back to
    // a tempo-compensated `durationSec - fadeSec * tempoRatio` (native-file
    // seconds; see #maybeStartCrossfade's own `startSec`/`compensateDurationSec`
    // computation) when arming these. Mirror that same fallback here rather
    // than reporting a null exit for the common analysis-not-ready path.
    // Round 5: the plain `fadeSec` subtraction (no ratio) was wrong for a
    // chained beatmix→simple-fade where the outgoing source is stretched —
    // fadeSec is a playback-domain duration, but this `sec` is native-domain.
    const tempoRatio = Number.isFinite(outgoingTempoRatio) && outgoingTempoRatio > 0 ? outgoingTempoRatio : 1;
    sec = plan.startSec
      ?? (Number.isFinite(outgoingAnalysis?.durationSec) && Number.isFinite(plan.fadeSec)
        ? Math.max(0, outgoingAnalysis.durationSec - plan.fadeSec * tempoRatio)
        : null);
  }
  const lastVocalEndSec = outgoingAnalysis?.lastVocalEndSec;
  const vocalActive = Number.isFinite(lastVocalEndSec) && sec != null
    ? lastVocalEndSec > sec && !isInsideVocalGap(sec, outgoingAnalysis?.vocalGaps)
    : null;
  return { sec, bar, vocalActive };
}

function entryInfo(plan, incomingAnalysis) {
  let sec = 0;
  let bar = null;
  if (plan.mode === 'beatmix' || plan.mode === 'stem-mix') {
    sec = plan.incoming?.entrySec ?? 0;
    bar = plan.incoming?.entryBarIndex ?? null;
  } else if (plan.mode === 'phrase-crossfade') {
    sec = plan.entrySec ?? 0;
    bar = plan.entryBarIndex ?? null;
  } else if (plan.mode === 'crossfade') {
    // Codex review (PR #43, round 6): a legacy (non-phrase, non-beatmix)
    // `crossfade` plan can still carry a nonzero incomingOffsetSec (from
    // the incoming track's headBeatOffsetSec) — MixStream.startCrossfade()
    // actually discards that many seconds of incoming PCM before the
    // overlap becomes audible (see normalizeTransitionPlan()'s legacy
    // branch, which carries it straight into mixPlan.incomingOffsetSec).
    // tail-fade's mixer path ignores this field entirely, so it correctly
    // stays 0 there (the `else` default below, untouched).
    sec = plan.incomingOffsetSec ?? 0;
  }
  return { sec, bar, firstVocalSec: incomingAnalysis?.firstVocalStartSec ?? null };
}

function formatCandidate(name, candidate) {
  const lines = [`${name}:`, `  eligible=${fmtBool(candidate.eligible)}`];
  if (candidate.eligible) {
    if (candidate.bars != null) lines.push(`  bars=${candidate.bars}`);
    if (candidate.fadeSec != null) lines.push(`  fadeSec=${num(candidate.fadeSec)}`);
    if (candidate.score != null) lines.push(`  score=${num(candidate.score, 3)}`);
  } else {
    lines.push(`  reason=${candidate.reason ?? 'unknown'}`);
  }
  return lines.join('\n');
}

/** @returns {string} the `[MIX PLAN]` block described in docs/mix-transition-phase9.md §3.2. */
export function formatTransitionPlanLog(report) {
  const lines = [
    '[MIX PLAN]',
    `from=${escapeLogTitle(report.from)}`,
    `to=${escapeLogTitle(report.to)}`,
    '',
    `selected=${report.selected ?? 'unknown'}`,
  ];
  if (report.downgradedFrom) lines.push(`downgradedFrom=${report.downgradedFrom}`);
  lines.push('');
  lines.push(formatCandidate('beatmix', report.candidates.beatmix));
  lines.push('');
  lines.push(formatCandidate('stemMix', report.candidates.stemMix));
  lines.push('');
  lines.push(formatCandidate('phraseCrossfade', report.candidates.phraseCrossfade));
  lines.push('');
  lines.push('stemCache:');
  lines.push(`  outgoing=${(report.stemCache.outgoing ?? 'unknown').toUpperCase()}`);
  lines.push(`  incoming=${(report.stemCache.incoming ?? 'unknown').toUpperCase()}`);
  if (report.exit) {
    lines.push('');
    lines.push('exit:');
    lines.push(`  sec=${num(report.exit.sec)}`);
    lines.push(`  bar=${report.exit.bar ?? 'null'}`);
    lines.push(`  vocalActive=${fmtBool(report.exit.vocalActive)}`);
  }
  if (report.entry) {
    lines.push('');
    lines.push('entry:');
    lines.push(`  sec=${num(report.entry.sec)}`);
    lines.push(`  bar=${report.entry.bar ?? 'null'}`);
    lines.push(`  firstVocalSec=${num(report.entry.firstVocalSec)}`);
  }
  return lines.join('\n');
}

/**
 * Always records the metrics accumulator (§3.3 — must stay always-on).
 * Only prints the verbose `[MIX PLAN]` block (§3.2) when MIX_DEBUG=true
 * (§19 debug-mode convention) — matches this repo's existing
 * `env.FOO === 'true'` boolean-env pattern (see
 * src/web/server/config.js's DEMO_LOGIN_ENABLED).
 * @param {object} report from buildTransitionPlanReport(), with `.selected`/
 *   `.downgradedFrom` finalized by the caller.
 * @param {{ debug?: boolean, logger?: { log: Function } }} [options]
 */
export function logTransitionPlan(report, { debug = process.env.MIX_DEBUG === 'true', logger = console } = {}) {
  recordTransition({ selected: report.selected, stemCache: report.stemCache });
  if (!debug) return;
  logger.log(formatTransitionPlanLog(report));
}

/**
 * Codex review (PR #43): a "snap handoff" (`#onSnapHandoff()` in player.js —
 * a prepared incoming source naturally winning the race to EOF, outside the
 * crossfade arm/plan machinery entirely) is a real, committed track handoff
 * that never goes through buildTransitionPlanReport()/logTransitionPlan()
 * above — no candidate evaluation happens there at all, so there is no plan
 * to build a full report from. Without this, `totalTransitions` undercounts
 * real playback and the `selected.gapless` bucket is never populated.
 * Records the same always-on metrics entry as logTransitionPlan(), plus an
 * abbreviated `[MIX PLAN]` line under MIX_DEBUG (no candidate/exit/entry
 * detail exists to print for this path).
 * @param {{ outgoingTrack?: {title?: string}, incomingTrack?: {title?: string} }} tracks
 * @param {{ debug?: boolean, logger?: { log: Function }, kind?: 'snap-handoff'|'hard-handoff' }} [options]
 *   `kind` (Codex review, PR #43 round 5): the two call sites in player.js
 *   are genuinely different events — `#onSnapHandoff()`'s successful adopt
 *   (a prepared source winning the race to EOF) vs. `#playNextMixer()`'s
 *   fallback (no prepared source existed, or it was rejected). Defaults to
 *   'hard-handoff' since that is the more general/common case.
 */
export function logGaplessTransition({ outgoingTrack, incomingTrack } = {}, { debug = process.env.MIX_DEBUG === 'true', logger = console, kind = 'hard-handoff' } = {}) {
  recordTransition({ selected: 'gapless', stemCache: {} });
  if (!debug) return;
  const description = kind === 'snap-handoff'
    ? '(natural snap handoff — a prepared incoming source won the race to EOF; no candidate evaluation, no crossfade plan)'
    : '(hard handoff — no prepared source was available/accepted at EOF; no candidate evaluation, no crossfade plan)';
  logger.log([
    '[MIX PLAN]',
    `from=${escapeLogTitle(outgoingTrack?.title)}`,
    `to=${escapeLogTitle(incomingTrack?.title)}`,
    '',
    'selected=gapless',
    description,
  ].join('\n'));
}

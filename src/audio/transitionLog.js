import { recordTransition } from './transitionMetrics.js';

/**
 * Phase 9A (docs/mix-transition-phase9.md §3): transition observability.
 * This module is pure presentation/bookkeeping — it does not decide
 * anything about which transition mode gets used (that judgment stays in
 * src/audio/transitionCandidates.js's rankTransitionCandidates(), called
 * from player.js). It only describes, after the fact, a decision player.js
 * already made.
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
 * Reduce a §6.3 Candidate struct (rankTransitionCandidates()'s
 * `candidates.beatmix`/`.stemMix`/`.phraseCrossfade` — see
 * src/audio/transitionCandidates.js) to the §3.2 report fields.
 */
function candidateToReportShape(candidate) {
  if (!candidate?.eligible) return { eligible: false, reason: candidate?.reasons?.[0] ?? 'unknown' };
  return {
    eligible: true,
    bars: candidate.bars ?? null,
    fadeSec: candidate.fadeSec,
    score: candidate.score,
  };
}

/**
 * Build the observability payload for one transition decision.
 *
 * Phase 9D (docs/mix-transition-phase9.md §6): beatmix/stem-mix/phrase-
 * crossfade are evaluated independently by rankTransitionCandidates()
 * (src/audio/transitionCandidates.js) rather than a waterfall — `candidates`
 * carries their real, independently-computed eligibility straight from
 * there. This function does no planning itself; it only formats what the
 * ranker already decided, plus the stem-cache HIT/MISS bookkeeping (an
 * async fs lookup the ranker itself never performs — see player.js's
 * #maybeStartCrossfade()).
 *
 * @param {object} params
 * @param {{title:string}} params.outgoingTrack
 * @param {{title:string}} params.incomingTrack
 * @param {object} params.outgoingAnalysis
 * @param {object} params.incomingAnalysis
 * @param {{beatmix:object, stemMix:object, phraseCrossfade:object}} params.candidates
 *   rankTransitionCandidates()'s `candidates` — §6.3 Candidate structs.
 * @param {boolean} params.stemCacheAttempted whether the stem-cache lookup
 *   actually ran this tick (false when the pair is marked
 *   `#stemMixUnavailableKey`, or stem-mix could never be eligible anyway —
 *   see player.js's `mightBeatmix` precheck).
 * @param {boolean} params.outgoingStemsCached
 * @param {boolean} params.incomingStemsCached
 * @param {string} params.plannedMode the ranker's initial winner
 *   (`selectedPlan.mode`) before any later downgrade (TRACK loop mode / an
 *   incoming source that couldn't honor a seek+stretch). player.js fills in
 *   `.selected`/`.downgradedFrom` itself once the final, actually-executed
 *   mode is known.
 * @param {object} params.selectedPlan the ranker's winning raw plan (any of
 *   beatmix/stem-mix/phrase-crossfade/legacy shape) — used for exit/entry
 *   reporting the same way the pre-Phase-9D `plannedSource` was.
 * @returns {object} the structured report — pass to logTransitionPlan().
 */
export function buildTransitionPlanReport({
  outgoingTrack,
  incomingTrack,
  outgoingAnalysis,
  incomingAnalysis,
  candidates,
  stemCacheAttempted,
  outgoingStemsCached,
  incomingStemsCached,
  plannedMode,
  selectedPlan,
  // Codex review (PR #43, round 5): the outgoing session's tempo stretch
  // ratio, so the legacy-plan exit fallback (a native-file position) can
  // convert player.js's playback-domain fadeSec back to native seconds the
  // same way #maybeStartCrossfade()'s own compensateDurationSec() call
  // does — 1 (no stretch) when the caller doesn't pass one.
  outgoingTempoRatio = 1,
}) {
  const beatmix = candidateToReportShape(candidates.beatmix);
  const phraseCrossfade = candidateToReportShape(candidates.phraseCrossfade);

  let stemMix;
  if (!stemCacheAttempted) {
    stemMix = { eligible: false, reason: 'not-evaluated-stem-mix-unavailable' };
  } else if (!(outgoingStemsCached && incomingStemsCached)) {
    stemMix = { eligible: false, reason: 'stem-cache-miss' };
  } else {
    stemMix = candidateToReportShape(candidates.stemMix);
  }

  const stemCache = {
    outgoing: stemCacheAttempted ? (outgoingStemsCached ? 'hit' : 'miss') : null,
    incoming: stemCacheAttempted ? (incomingStemsCached ? 'hit' : 'miss') : null,
  };

  const exit = exitInfo(selectedPlan, outgoingAnalysis, outgoingTempoRatio);
  const entry = entryInfo(selectedPlan, incomingAnalysis);

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

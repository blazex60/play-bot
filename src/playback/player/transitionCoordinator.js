import { AudioPlayerStatus } from '@discordjs/voice';
import { getGuildSettings } from '../../shared/settings.js';
import { rankTransitionCandidates } from '../../audio/transitionCandidates.js';
import {
  createSessionTempoState,
  resetSessionTempo,
  compensateDurationSec,
  buildTempoFilter,
} from '../../audio/tempo.js';
import { TAIL_WINDOW_SEC } from '../../audio/vocalActivity.js';
import { LoopMode } from '../queue.js';
import { buildTransitionPlanReport, exitInfo } from '../../audio/transitionLog.js';

const CROSSFADE_ARM_INTERVAL_MS = 200;
/** Start downloading/decoding the next track this many seconds before overlap. */
const CROSSFADE_PREP_LEAD_SEC = 15;
const MAX_CROSSFADE_SEC = 6;
/**
 * Phase 7D: covers the arm loop's early-return gate for both legacy
 * crossfade (MAX_CROSSFADE_SEC) and beatmix/phrase-crossfade. Exit
 * candidates come from findExitCandidates()'s search over the tail analysis
 * window (TAIL_WINDOW_SEC, e.g. 60s before EOF as of Phase 9F §8, §5) — the
 * gate must open
 * before `remaining` drops below the earliest possible candidate position,
 * or planning (and therefore #ensureIncomingPrep) never runs early enough:
 * by the time the gate finally opened, positionSec could already be PAST a
 * candidate exitStartSec near the far edge of that window, forcing an
 * immediate/late fade instead of the planned downbeat-aligned one (Codex
 * round-2). A fixed overlap-length guess (e.g. 20s) undercounts this.
 */
const MAX_TRANSITION_LEAD_SEC = TAIL_WINDOW_SEC;
// Phase 8: #ensureOutgoingStemPrep() seeks the outgoing stems to a FIXED
// native exitStartSec once, at prepDue — #current itself keeps playing live
// the whole time until actually taken. Normal jitter (CROSSFADE_ARM_INTERVAL_MS
// polling) keeps that gap tiny; this tolerates a few ticks of it while still
// catching the case where #takePreparedIncoming()'s await stretched
// arbitrarily far (a still-downloading/normalizing incoming track), which
// would otherwise start the outgoing stems from a position #current has
// already played past (Codex).
const OUTGOING_STEM_DRIFT_TOLERANCE_SEC = 0.5;
// Codex review (PR #43, round 4): how stale a #lastEvaluatedTransitionReport
// entry can be and still be trusted to describe the hard handoff that just
// happened for the same pair — bounds reusing a genuinely old evaluation
// from several tracks/minutes ago in the rare case a (current, next)
// videoId pair repeats (e.g. QUEUE-loop wraparound).
const LAST_EVALUATED_TRANSITION_MAX_AGE_MS = 30_000;

function fallbackAnalysis(track) {
  return {
    confidence: 0.45,
    recommendedOverlapSec: 1.5,
    durationSec: track?.duration ?? null,
    vocalConfidence: 0.2,
  };
}

/**
 * Phase 9F Codex review (PR #52, P2, round 2): #current's decoder is
 * native-timeline positioned at #currentEntrySec, not 0, when #current was
 * itself promoted from a seeked beatmix/phrase/stem-mix source (see
 * #currentEntrySec's own comment, and #maybeStartCrossfade's currentEntrySec
 * usage below). The exit-candidate pool findExitCandidates()
 * (beatmixTransition.js) searches — outgoing.phrases.tail /
 * outgoing.downbeatGrid.tail.downbeatsSec — has no notion of that runtime
 * offset; it's built purely from the file's own absolute timeline. Phase
 * 9F's widened tail window makes it newly possible for that pool to contain
 * a candidate before that position on a 75-90s-ish track (old 45s window:
 * tailStart >= 30s typically kept the pool past any plausible entrySec; 60s
 * window: tailStart can now dip below it). If the ranker picks such a
 * candidate, #maybeStartCrossfade's `Math.max(0, exitStartSec - ...)` clamps
 * the resulting startSec to 0 — "due immediately" — firing the next
 * transition right after promotion and skipping nearly the whole track.
 * Filtering the pool here, before ranking, keeps every candidate
 * #maybeStartCrossfade could ever select strictly reachable from wherever
 * #current's decoder actually starts.
 *
 * round 1 of this fix floored candidates at #currentEntrySec alone — missing
 * that MixStream.setCurrent() initializes positionSec to the overlap
 * already consumed DURING the crossfade (fadeElapsedSec +
 * incomingSkippedSec — see mixStream.js's promote path), not 0. A candidate
 * between the entry offset and (entry offset + that consumed overlap,
 * converted to native seconds) had therefore already played out by the
 * time #current became current, and round 1 still let it through.
 * `minReachableNativeSec` (the caller's #currentEntrySec +
 * #currentEntryOverlapConsumedSec — see that field's own comment for why it
 * must be a fixed snapshot, not the live/ever-growing positionSec) is that
 * corrected floor.
 */
function excludeExitCandidatesBeforeEntry(analysis, minReachableNativeSec) {
  if (!(minReachableNativeSec > 0)) return analysis;
  const tailPhrases = analysis.phrases?.tail;
  const tailDownbeats = analysis.downbeatGrid?.tail?.downbeatsSec;
  const filteredPhrases = Array.isArray(tailPhrases)
    ? tailPhrases.filter((c) => c.sec > minReachableNativeSec)
    : tailPhrases;
  const filteredDownbeats = Array.isArray(tailDownbeats)
    ? tailDownbeats.filter((sec) => sec > minReachableNativeSec)
    : tailDownbeats;
  if (filteredPhrases === tailPhrases && filteredDownbeats === tailDownbeats) return analysis;
  return {
    ...analysis,
    phrases: analysis.phrases ? { ...analysis.phrases, tail: filteredPhrases } : analysis.phrases,
    downbeatGrid: analysis.downbeatGrid
      ? { ...analysis.downbeatGrid, tail: { ...analysis.downbeatGrid.tail, downbeatsSec: filteredDownbeats } }
      : analysis.downbeatGrid,
  };
}

/**
 * Phase 7D: planBeatSyncedTransition() returns one of three plan shapes
 * (beatmix / phrase-crossfade / the legacy planTransition() ladder) — this
 * reduces them to what the rest of #maybeStartCrossfade and MixStream need,
 * so the arm loop doesn't have to branch on plan.mode everywhere.
 *
 * `exitStartSec`: where on the outgoing track to start the fade (legacy's
 * `plan.startSec`, beatmix's `plan.outgoing.exitStartSec`).
 * `entrySec`/`tempoFilter`: fed to createFileSource() for the incoming
 * spawn — beatmix and phrase-crossfade both determine a real head-window
 * entry point via candidate search (§9.3: seek at spawn, not the lossy
 * post-spawn PCM-skip path), so incomingOffsetSec is forced to 0 for them.
 * `sessionTempo`: non-null only for beatmix — what session tempo promotion
 * should carry forward instead of resetting to the incoming track's native
 * BPM (§2.3/§8.4).
 */
function normalizeTransitionPlan(rawPlan) {
  if (rawPlan.mode === 'stem-mix') {
    // Phase 8 (docs/mix-transition-phase8.md): planStemTransition()'s output
    // is a planBeatmixTransition()-shaped plan plus a `stems` sub-object —
    // identical to the 'beatmix' branch below except stems is carried
    // through to mixPlan (MixStream.startStemCrossfade() reads it directly).
    return {
      mixPlan: {
        mode: 'stem-mix',
        fadeSec: rawPlan.fadeSec,
        startSec: rawPlan.outgoing?.exitStartSec ?? null,
        curve: rawPlan.gain?.curve ?? 'equal-power',
        baseSwap: true,
        highpassHz: rawPlan.eq?.highpassHz ?? 120,
        lowshelfGainDb: 2,
        incomingOffsetSec: 0,
        targetBpm: rawPlan.targetBpm,
        sync: rawPlan.sync,
        eq: rawPlan.eq,
        stems: rawPlan.stems,
        // Phase 9G (docs/mix-transition-phase9.md §9.1): TransitionPlan v3's
        // mixZone/events — MixStream.startStemCrossfade() fires 'mixzoneevent'
        // as playback crosses each scheduled bar (see mixStream.js's
        // #tickStemCrossfade()). undefined (not an empty array) when the
        // planner couldn't derive a bar clock (missing sync/targetBpm) so
        // MixStream's own guard can tell "no schedule" apart from "empty".
        mixZone: rawPlan.mixZone,
        events: rawPlan.events?.length ? rawPlan.events : undefined,
      },
      exitStartSec: rawPlan.outgoing?.exitStartSec ?? null,
      entrySec: Math.max(0, rawPlan.incoming?.entrySec ?? 0),
      tempoFilter: rawPlan.incoming?.tempoFilter ?? null,
      sessionTempo: {
        nativeBpm: rawPlan.incoming?.nativeBpm ?? null,
        playbackBpm: rawPlan.incoming?.playbackBpm ?? rawPlan.targetBpm ?? null,
        tempoRatio: rawPlan.incoming?.tempoRatio ?? 1,
      },
    };
  }
  if (rawPlan.mode === 'beatmix') {
    return {
      mixPlan: {
        mode: 'beatmix',
        fadeSec: rawPlan.fadeSec,
        startSec: rawPlan.outgoing?.exitStartSec ?? null,
        curve: rawPlan.gain?.curve ?? 'equal-power',
        baseSwap: true,
        highpassHz: rawPlan.eq?.highpassHz ?? 120,
        lowshelfGainDb: 2,
        incomingOffsetSec: 0,
        targetBpm: rawPlan.targetBpm,
        sync: rawPlan.sync,
        eq: rawPlan.eq,
      },
      exitStartSec: rawPlan.outgoing?.exitStartSec ?? null,
      entrySec: Math.max(0, rawPlan.incoming?.entrySec ?? 0),
      tempoFilter: rawPlan.incoming?.tempoFilter ?? null,
      sessionTempo: {
        nativeBpm: rawPlan.incoming?.nativeBpm ?? null,
        playbackBpm: rawPlan.incoming?.playbackBpm ?? rawPlan.targetBpm ?? null,
        tempoRatio: rawPlan.incoming?.tempoRatio ?? 1,
      },
    };
  }
  if (rawPlan.mode === 'phrase-crossfade') {
    return {
      mixPlan: {
        mode: 'crossfade',
        fadeSec: rawPlan.fadeSec,
        startSec: rawPlan.startSec ?? null,
        curve: rawPlan.curve ?? 'equal-power',
        baseSwap: rawPlan.baseSwap === true,
        highpassHz: rawPlan.highpassHz ?? 120,
        lowshelfGainDb: rawPlan.lowshelfGainDb ?? 2,
        incomingOffsetSec: 0,
      },
      exitStartSec: rawPlan.startSec ?? null,
      entrySec: Math.max(0, rawPlan.entrySec ?? 0),
      tempoFilter: null,
      sessionTempo: null,
    };
  }
  // Legacy planTransition() output (crossfade / tail-fade / simple-fade).
  return {
    mixPlan: {
      mode: rawPlan.mode,
      fadeSec: rawPlan.fadeSec,
      startSec: rawPlan.startSec ?? null,
      curve: rawPlan.curve ?? 'equal-power',
      baseSwap: rawPlan.baseSwap === true,
      highpassHz: rawPlan.highpassHz ?? 120,
      lowshelfGainDb: rawPlan.lowshelfGainDb ?? 2,
      incomingOffsetSec: rawPlan.incomingOffsetSec ?? 0,
    },
    exitStartSec: rawPlan.startSec ?? null,
    entrySec: 0,
    tempoFilter: null,
    sessionTempo: null,
  };
}

/**
 * Owns the transition planning/arming stage behind GuildPlayer: the
 * crossfade arm timer, per-tick candidate evaluation + plan selection
 * (beatmix / stem-mix / phrase-crossfade / legacy ladder), the stem-mix
 * availability bookkeeping, the evaluated-transition stash used by the
 * gapless hard-handoff log sites, and the session-tempo / promotion
 * bookkeeping (pendingSessionTempo, entry offsets) those decisions carry.
 * Extracted from GuildPlayer (player.js) so the player concentrates on
 * playback orchestration and the track-advancement loop; the shared state
 * is exposed as plain public fields because the player's promotion/handoff
 * paths still read and write them directly (same convention as
 * AnalysisCoordinator's shared Maps).
 *
 * @param {{
 *   guildId: string,
 *   queue: import('../queue.js').GuildQueue,
 *   analysis: import('./analysisCoordinator.js').AnalysisCoordinator,
 *   sourcePreparer: import('./sourcePreparer.js').SourcePreparer,
 *   audioPlayer: object,
 *   getMixStream: () => object | null,
 *   isForceSkip: () => boolean,
 *   isHandlingAfter: () => boolean,
 *   maybeRefillQueue: () => void,
 *   resolvePlaybackDurationSec: (track: object) => number | null,
 *   probeTempoBackendFn: Function,
 *   getCachedStemsFn: Function,
 *   planStemTransitionFn: Function,
 *   logTransitionPlanFn: Function,
 * }} deps
 */
export class TransitionCoordinator {
  /**
   * Phase 7 §8.4: held for the lifetime of the current track. 7B does not
   * yet stretch anything (no beatmix planner exists to pick a targetBpm) —
   * this only tracks the native-BPM reset baseline every new current track
   * starts from, so 7C can call applySessionTempo() from a known-good state.
   */
  sessionTempo = createSessionTempoState();
  /**
   * Phase 7D §2.3/§8.4: stashed when a beatmix crossfade starts (the plan's
   * incoming {nativeBpm, playbackBpm, tempoRatio}), consumed on promotion so
   * the stretched tempo carries forward instead of resetting to native.
   * Cleared on incoming failure so a dropped beatmix never leaks into a
   * later, unrelated promotion.
   */
  pendingSessionTempo = null;
  /**
   * Native seconds the pending beatmix/phrase-crossfade incoming source was
   * seeked forward by (createFileSource's startSec) — 0 for anything else.
   * Subtracted from native duration at promotion so remainingSec reflects
   * how much of the source is actually left to play (Codex round-1 P1).
   */
  pendingIncomingEntrySec = 0;
  /**
   * Native seconds the CURRENTLY playing source was seeked forward by at
   * spawn (0 for a fresh/legacy start). analysis-derived exit timestamps
   * (norm.exitStartSec) are absolute positions in the native file, while
   * MixStream.positionSec is relative to wherever this source's decoder
   * actually started — comparing them directly without subtracting this
   * offset makes the arm loop think the exit point is #currentEntrySec
   * seconds later than it really is relative to positionSec, delaying (or
   * for a short remaining source, entirely missing) the next chained
   * transition (Codex round-3 P1).
   */
  currentEntrySec = 0;
  /**
   * Phase 9F Codex review (PR #52, P2, round 2): additional native seconds
   * already consumed from #current BEFORE it even became #current — the
   * overlap portion a beatmix/stem-mix crossfade already played through
   * during the fade (MixStream.setCurrent() initializes positionSec to
   * fadeElapsedSec + incomingSkippedSec, not 0, on a real promotion — see
   * mixStream.js's promote path). 0 for a fresh/legacy start or a
   * snap-adopted handoff (neither ever ran an overlap). Set once, at
   * promotion, alongside #currentEntrySec — NOT re-derived from the live,
   * ever-growing positionSec on every arm-loop tick, which would also catch
   * ordinary arm-loop evaluation lag this codebase already tolerates (fires
   * as soon as it notices, rather than requiring every candidate to still
   * be strictly in the future). #currentEntrySec + this is the true
   * absolute floor for #maybeStartCrossfade's excludeExitCandidatesBeforeEntry().
   */
  currentEntryOverlapConsumedSec = 0;
  #probeTempoBackendFn;
  #crossfadeArmTimer = null;
  crossfadeStarted = false;
  #crossfadeArming = false;
  crossfadeTargetTrack = null;
  #getCachedStemsFn;
  #planStemTransitionFn;
  /**
   * Codex review (PR #43, round 3): the track that just naturally finished,
   * stashed by #handleAfter()'s #startQueueRefill (autoplay-continuation)
   * branch when it can't call playNext() itself (the external
   * handleQueueExhausted callback does, after it adds a track) — consumed
   * exactly once by the next playNext() call so the eventual hard handoff
   * still gets logged, but only after its source actually starts (see
   * #playNextMixer). Anything else in the meantime (e.g. a user /skip
   * racing the autoplay fetch) would misattribute this — accepted as a
   * low-impact, debug-log-only edge case, same as other documented races.
   *
   * Codex review (PR #43, round 4): also cleared by stop() and bounded by
   * PENDING_GAPLESS_MAX_AGE_MS — recommend-mode exhaustion can return
   * `true` without starting another track for a while, and without either
   * guard a much-later, wholly unrelated playNext() (e.g. a fresh /play
   * after the player sat idle) would consume this stale stash and corrupt
   * the always-on totalTransitions/selected.gapless metrics, not just the
   * debug log.
   * @type {{ track: object, setAt: number } | null}
   */
  pendingGaplessFrom = null;
  /**
   * Codex review (PR #43, round 4): the most recent real (fadeSec > 0)
   * [MIX PLAN] evaluation for a (current, next) pair, kept around so that
   * IF this exact pair later falls through to a hard handoff (prep raced
   * EOF, or the source failed to start), the eventual gapless log can
   * report what was actually evaluated/missed instead of the generic
   * "no candidate evaluation" stub — see #stashLastEvaluatedTransition()/
   * #takeMatchingEvaluatedTransition(). Not read by anything on the
   * playback-decision path; purely for the two logGaplessTransitionFn call
   * sites' diagnostic output.
   * @type {{ pairKey: string, report: object, evaluatedAt: number } | null}
   */
  lastEvaluatedTransitionReport = null;
  /** Test-only override — injected logTransitionPlan (same function the player still holds for its own hard-handoff/snap-handoff log sites). */
  #logTransitionPlanFn;
  /**
   * Phase 8 (Codex), Phase 9D round 3 (Codex): memoizes a POSITIVE
   * stem-cache lookup, independently per side (outgoing/incoming) —
   * #maybeStartCrossfade() re-runs the eligibility check on every
   * CROSSFADE_ARM_INTERVAL_MS tick for up to the whole lead window, and
   * getCachedStems() touches the entry's mtime on every hit, so without
   * this a single transition attempt generates hundreds of redundant
   * metadata writes. Originally memoized only once BOTH sides hit — but
   * the far more common transient state is one side (usually outgoing,
   * separated earlier) already cached while the other's separation is
   * still in flight, and that case got zero benefit from a same-pair-only
   * memo keyed on both sides at once. Each side is now keyed on its own
   * track identity (#prefetchKey()) alone, so a positive outgoing hit
   * stays memoized across ticks regardless of which `next` it's currently
   * paired with. Only positive results are memoized per side — a miss
   * must keep re-checking every tick, since background separation
   * completing mid-window is the whole point of prepping this early, and
   * a miss never touches mtime anyway.
   * @type {{ key: string, stems: object } | null}
   */
  #outStemCacheHit = null;
  /** @type {{ key: string, stems: object } | null} */
  #inStemCacheHit = null;
  /**
   * videoId:videoId key of a (current, next) pair whose stem-mix attempt
   * was aborted at take time (spawn/prep failure, drift, or an unhonored
   * transform) rather than downgraded to a plain crossfade — because the
   * cache lookup and `planStemTransitionFn()` above are independent of
   * spawn success, leaving this unset would have every subsequent ~200ms
   * arm tick re-select the SAME relaxed stem-mix plan, abort it again, and
   * never let the ranker's other candidates run at all (Codex).
   * Checked at plan-selection time to skip stem-mix for this exact pair.
   * Explicitly cleared in #onCrossfadePromoted() once that pair's
   * transition attempt actually concludes — comparing against the CURRENT
   * pair's key alone isn't enough, since QUEUE loop mode or a duplicated
   * playlist entry can bring the SAME pair back around later, and a
   * since-resolved (or merely transient) earlier failure must not
   * permanently downgrade every future occurrence of that pair for the
   * rest of the GuildPlayer's lifetime (Codex).
   * @type {string | null}
   */
  stemMixUnavailableKey = null;
  #guildId;
  #queue;
  #analysis;
  #sourcePreparer;
  #audioPlayer;
  #getMixStream;
  #isForceSkip;
  #isHandlingAfter;
  #maybeRefillQueue;
  #resolvePlaybackDurationSec;

  constructor({
    guildId,
    queue,
    analysis,
    sourcePreparer,
    audioPlayer,
    getMixStream,
    isForceSkip,
    isHandlingAfter,
    maybeRefillQueue,
    resolvePlaybackDurationSec,
    probeTempoBackendFn,
    getCachedStemsFn,
    planStemTransitionFn,
    logTransitionPlanFn,
  }) {
    this.#guildId = guildId;
    this.#queue = queue;
    this.#analysis = analysis;
    this.#sourcePreparer = sourcePreparer;
    this.#audioPlayer = audioPlayer;
    this.#getMixStream = getMixStream;
    this.#isForceSkip = isForceSkip;
    this.#isHandlingAfter = isHandlingAfter;
    this.#maybeRefillQueue = maybeRefillQueue;
    this.#resolvePlaybackDurationSec = resolvePlaybackDurationSec;
    this.#probeTempoBackendFn = probeTempoBackendFn;
    this.#getCachedStemsFn = getCachedStemsFn;
    this.#planStemTransitionFn = planStemTransitionFn;
    this.#logTransitionPlanFn = logTransitionPlanFn;
  }

  resetSessionTempoFor(track) {
    // Fast path only: #analysisCache is rarely populated synchronously by
    // the time a track becomes current (analysis is normally scheduled/
    // fetched afterward — see #scheduleAnalysis / #maybeStartCrossfade).
    // #maybeApplyAnalysisDuration backfills nativeBpm below once analysis
    // actually arrives for this track, however it arrives (persisted
    // lookup, in-memory cache hit, or a freshly completed #runAnalysis).
    // headBpm (not the tail-biased aggregate `bpm`) — outgoingActualTargetBpm()
    // scales the tail BPM by (sessionTempo.playbackBpm / analysis.headBpm),
    // so for a ratio-1 (unstretched) session this must equal headBpm itself
    // or that formula stops being an identity and reports a tail tempo the
    // audio isn't actually playing at (Codex round-5 P1).
    const cached = track?.videoId ? this.#analysis.analysisCache.get(track.videoId) : null;
    const nativeBpm = cached ? (cached.headBpm ?? cached.bpm ?? null) : null;
    this.sessionTempo = resetSessionTempo(nativeBpm);
  }

  /**
   * Phase 8: the outgoing stem pair must be stretched to match whatever
   * session tempo #current is ACTUALLY playing at right now, not
   * re-derived from analysis fields — buildTempoFilter() is a pure
   * function, so recomputing it from #sessionTempo (already tracking the
   * exact {nativeBpm, playbackBpm} the live spawn used) reproduces the
   * identical filter string deterministically, without needing to persist
   * it anywhere new.
   */
  #outgoingStemTempoFilter(tempoBackend) {
    const built = buildTempoFilter({
      nativeBpm: this.sessionTempo.nativeBpm,
      targetBpm: this.sessionTempo.playbackBpm,
      backend: tempoBackend,
    });
    // buildTempoFilter() returns { filter: null } both when no stretch is
    // needed AND when a needed stretch couldn't be expressed (nativeBpm
    // missing, deviation past the backend's limit) — those two cases must
    // not collapse into the same "spawn unstretched" result here: the
    // second one would silently decode the outgoing stems at native tempo
    // while #current keeps playing stretched, drifting apart for the whole
    // stem window. undefined signals "stem-mix unavailable" to callers.
    const ratio = this.sessionTempo.tempoRatio ?? 1;
    if (built.filter == null && Math.abs(ratio - 1) > 1e-9) return undefined;
    return built.filter;
  }

  startCrossfadeArm() {
    this.clearCrossfadeArm();
    this.#crossfadeArmTimer = setInterval(() => {
      this.#maybeStartCrossfade().catch((err) => {
        console.error('[GuildPlayer] crossfade arm error:', err.message);
      });
    }, CROSSFADE_ARM_INTERVAL_MS);
  }

  clearCrossfadeArm() {
    if (this.#crossfadeArmTimer != null) {
      clearInterval(this.#crossfadeArmTimer);
      this.#crossfadeArmTimer = null;
    }
  }

  async #maybeStartCrossfade() {
    if (this.#crossfadeArming || this.crossfadeStarted) return;
    if (getGuildSettings(this.#guildId).fade === false) return;
    if (this.#getMixStream()?.isCrossfading) return;
    if (this.#isForceSkip() || this.#isHandlingAfter()) return;
    if (this.#audioPlayer.state.status !== AudioPlayerStatus.Playing) return;

    this.#crossfadeArming = true;
    try {
      const current = this.#queue.current;
      if (!current) return;

      let remaining = this.#getMixStream()?.remainingSec;
      if (remaining == null) {
        await this.#analysis.getCachedAnalysis(current);
        remaining = this.#getMixStream()?.remainingSec;
      }
      if (remaining == null) {
        const durationSec = this.#resolvePlaybackDurationSec(current);
        if (durationSec != null) {
          remaining = durationSec - (this.#getMixStream()?.positionSec ?? 0);
        }
      }
      if (remaining == null) return;
      // Analysis determines the exact overlap. Legacy crossfade caps at
      // MAX_CROSSFADE_SEC, but a beatmix/stem-mix overlap (up to
      // MIX_BARS.extended = 16 bars as of Phase 9E, docs/mix-transition-
      // phase9.md §7.2) can run longer at slower tempos — MAX_TRANSITION_LEAD_SEC
      // must cover both, or a slow-tempo beatmix's prep window never opens.
      // MAX_TRANSITION_LEAD_SEC is still TAIL_WINDOW_SEC — Phase 9F (§8)
      // widened it from 45s to 60s specifically so a full 16-bar reach at
      // slower tempos (e.g. 16 bars at 64 BPM/4-beat is 60s) stays within
      // both this gate's open point AND findExitCandidates()'s candidate
      // pool. Below ~64 BPM a 16-bar reach can still exceed the window; see
      // docs/mix-transition-phase9.md's Phase 9F implementation notes for
      // the known remaining limitation.
      if (remaining > CROSSFADE_PREP_LEAD_SEC + MAX_TRANSITION_LEAD_SEC) return;
      // TRACK loop must re-arm the same track; upcoming()[0] would advance on promote.
      const next = this.#queue.loopMode === LoopMode.TRACK
        ? current
        : this.#queue.upcoming()[0];
      if (!next) {
        // Wide enough that a freshly-refilled track still has time for a
        // beatmix-length overlap once it arrives, not just the legacy
        // default fade — #maybeRefillQueue is a deduped single attempt, so
        // triggering it this early costs nothing when refill isn't needed.
        if (remaining <= CROSSFADE_PREP_LEAD_SEC + MAX_TRANSITION_LEAD_SEC) {
          this.#maybeRefillQueue();
        }
        return;
      }

      // Codex review (PR #52, P2, round 2): the floor for excludeExitCandidatesBeforeEntry()
      // must include the overlap #current already consumed before becoming
      // #current (#currentEntryOverlapConsumedSec's own comment) on top of
      // its entry offset — not just the entry offset alone.
      const minReachableNativeSec = (this.currentEntrySec ?? 0) + (this.currentEntryOverlapConsumedSec ?? 0);
      const rawOutAnalysis = (await this.#analysis.getCachedAnalysis(current)) ?? fallbackAnalysis(current);
      const outAnalysis = excludeExitCandidatesBeforeEntry(rawOutAnalysis, minReachableNativeSec);
      const inAnalysis = (await this.#analysis.getCachedAnalysis(next)) ?? fallbackAnalysis(next);
      const outgoingPlaybackBpm = this.sessionTempo.playbackBpm ?? outAnalysis.bpm ?? null;
      // planBeatmixTransition/planStemTransition both reject before ever
      // touching the tempo backend when either side lacks a usable BPM (the
      // common case — most analyses are fallbackAnalysis() or simply
      // BPM-less) — skip the real ffmpeg -filters probe (and the stem-cache
      // fs lookup below) entirely then, rather than spawning either every
      // 200ms arm tick for a pair that can never be beatmix/stem-mix
      // eligible anyway.
      const mightBeatmix = outAnalysis.bpm > 0 && (inAnalysis.headBpm ?? inAnalysis.bpm) > 0;
      // 'rubberband' is only a placeholder for the branch where no probe ran
      // at all (planBeatmixTransition rejects on bpm-unavailable before ever
      // touching the backend there, so its value is moot). When the probe
      // DID run and genuinely found no usable filter, that null must reach
      // the planner as-is — coalescing it to 'rubberband' would tell it a
      // backend is available when it isn't, producing a filter string ffmpeg
      // can't actually apply.
      const tempoBackend = mightBeatmix ? await this.#probeTempoBackendFn() : 'rubberband';

      // Phase 9D (docs/mix-transition-phase9.md §6): beatmix / stem-mix /
      // phrase-crossfade are evaluated as independent candidates —
      // rankTransitionCandidates() plans all of them regardless of whether
      // the others are eligible, then picks a winner by score +
      // transitionModeBonus() (§6.4) rather than the pre-Phase-9D waterfall
      // (tier 1 beatmix winning outright, stem-mix only attempted when it
      // didn't). The stem-cache lookup below therefore always runs (subject
      // only to the mightBeatmix/`#stemMixUnavailableKey` gates above/below,
      // not to whether beatmix already "won") — gated on stems already
      // being cached (a cheap fs check) so this never triggers separation
      // itself; #scheduleAnalysis() already does that in the background,
      // well before a transition is imminent. Looked up once here and
      // reused at both the prepDue and readyToFade points below — a second
      // fs check right before spawning would risk observing a DIFFERENT
      // cache state than what eligibility was actually decided against a
      // few lines up.
      let outCachedStems = null;
      let inCachedStems = null;
      // Codex review (PR #43, round 9): videoId-less tracks (the playlist
      // route explicitly allows this) previously all collapsed to the same
      // ":" key here — an evaluated A→B pair's stash would then get
      // wrongly consumed by an unrelated later B→C handoff within the 30s
      // freshness window if either pair lacked a videoId. #prefetchKey()
      // (existing, used elsewhere for the same "stable identity when
      // videoId is absent" need) falls back to webpageUrl instead.
      const stemCacheLookupKey = `${this.#sourcePreparer.prefetchKey(current) ?? ''}:${this.#sourcePreparer.prefetchKey(next) ?? ''}`;
      // Phase 9A (docs/mix-transition-phase9.md §3): whether the stem-cache
      // lookup below actually ran this tick — distinguishes a genuine
      // HIT/MISS from "never checked" (this pair is marked
      // #stemMixUnavailableKey, or stem-mix could never be eligible anyway)
      // for the [MIX PLAN] log/metrics built further down. Read-only
      // bookkeeping; does not affect selection.
      const stemCacheAttempted = mightBeatmix && this.stemMixUnavailableKey !== stemCacheLookupKey;
      if (stemCacheAttempted) {
        // Codex review (PR #46, round 3, P2): each side is checked/memoized
        // independently — a positive outgoing hit from an earlier tick (or
        // an earlier pairing entirely, keyed on the track alone) is reused
        // without re-touching the filesystem, and only the side(s) still
        // missing actually call getCachedStemsFn() this tick.
        const outKey = this.#sourcePreparer.prefetchKey(current);
        const inKey = this.#sourcePreparer.prefetchKey(next);
        outCachedStems = this.#outStemCacheHit?.key === outKey ? this.#outStemCacheHit.stems : null;
        inCachedStems = this.#inStemCacheHit?.key === inKey ? this.#inStemCacheHit.stems : null;
        const needOut = !outCachedStems;
        const needIn = !inCachedStems;
        if (needOut || needIn) {
          const [freshOut, freshIn] = await Promise.all([
            needOut ? this.#getCachedStemsFn(current.videoId) : Promise.resolve(outCachedStems),
            needIn ? this.#getCachedStemsFn(next.videoId) : Promise.resolve(inCachedStems),
          ]);
          outCachedStems = freshOut;
          inCachedStems = freshIn;
          if (needOut && outCachedStems) this.#outStemCacheHit = { key: outKey, stems: outCachedStems };
          if (needIn && inCachedStems) this.#inStemCacheHit = { key: inKey, stems: inCachedStems };
          // Codex review (PR #46, round 4): a side reused from memo above
          // (not freshly checked THIS tick) must still be revalidated once,
          // right here, the moment the OTHER side just landed and the pair
          // is about to be reported complete for the first time —
          // pruneStemCache() can evict a memoized hit's files at any point
          // in the background, and without this the newly-complete pair
          // would report stemsAvailable:true off a memo that may have
          // already gone stale, potentially displacing an already-ready
          // beatmix candidate for a stem-mix plan whose OWN prep-time
          // revalidation (#ensureOutgoingStemPrep()/#ensureIncomingStemPrep())
          // only discovers the missing file much later, after the ranker's
          // choice already stuck. Only fires on this "just became complete"
          // transition — ordinary "still waiting" ticks (the other side
          // stays missing) and the steady both-hit state (the outer
          // `needOut || needIn` check above is false, skipping this whole
          // block every tick) are unaffected, so this doesn't reintroduce
          // the per-tick fs cost the memoization itself exists to avoid.
          if (outCachedStems && inCachedStems) {
            if (needIn && !needOut) {
              outCachedStems = await this.#getCachedStemsFn(current.videoId);
              this.#outStemCacheHit = outCachedStems ? { key: outKey, stems: outCachedStems } : null;
            } else if (needOut && !needIn) {
              inCachedStems = await this.#getCachedStemsFn(next.videoId);
              this.#inStemCacheHit = inCachedStems ? { key: inKey, stems: inCachedStems } : null;
            }
          }
        }
      }

      const { candidates, selectedPlan, bestNonStemPlan } = rankTransitionCandidates(outAnalysis, inAnalysis, {
        outgoingPlaybackBpm,
        tempoBackend,
        maxOverlapSec: MAX_CROSSFADE_SEC,
        stemsAvailable: Boolean(outCachedStems && inCachedStems),
        planStemTransitionFn: this.#planStemTransitionFn,
      });
      // Phase 9A: snapshot the ranker's decision (before any later downgrade
      // — TRACK loop mode / an incoming source that can't honor a seek or
      // stretch) into a log report. `selected`/`downgradedFrom` are
      // finalized right before the actual startCrossfade()/
      // startStemCrossfade() call below, once the real executed mode is
      // known — see the `modeDowngraded` flag set at each override site.
      //
      // Codex review (PR #43, round 6): built and stashed BEFORE the
      // gapless/no-fade early return below (moved up from after it) — a
      // 'gapless' selectedPlan still means beatmix/stem-mix/phrase-crossfade
      // were genuinely evaluated and rejected just now, and the eventual
      // hard-handoff log (via #takeMatchingEvaluatedTransition()) should
      // report those real rejection reasons instead of falling back to the
      // generic "no candidate evaluation" stub for every gapless case.
      const plannedMode = selectedPlan.mode;
      const transitionPlanReport = buildTransitionPlanReport({
        outgoingTrack: current,
        incomingTrack: next,
        outgoingAnalysis: outAnalysis,
        incomingAnalysis: inAnalysis,
        candidates,
        stemCacheAttempted,
        outgoingStemsCached: Boolean(outCachedStems),
        incomingStemsCached: Boolean(inCachedStems),
        plannedMode,
        selectedPlan,
        // Codex review (PR #43, round 5): read directly off #sessionTempo
        // rather than waiting for the local `outgoingTempoRatio` const
        // further down — same instance field, same tick, nothing mutates
        // it in between.
        outgoingTempoRatio: this.sessionTempo.tempoRatio ?? 1,
      });
      // Codex review (PR #43, round 8): several awaits above
      // (#getCachedAnalysis() x2, #probeTempoBackendFn(), the stem-cache
      // Promise.all) can yield long enough for a concurrent snap handoff to
      // promote the queue out from under this tick — `current`/`next`
      // captured at the top of this method are then stale, describing a
      // pair that is no longer live. Stashing (or acting on) a report for
      // that stale pair risks a later, unrelated recurrence of the same
      // pair replaying it within the 30s freshness window. Bail out before
      // stashing — and before any further decision-making below, which
      // would be equally stale — once the live queue no longer matches.
      const stillCurrentPair = this.#queue.current === current
        && (this.#queue.loopMode === LoopMode.TRACK ? next === current : this.#queue.upcoming()[0] === next);
      if (!stillCurrentPair) return;
      // Codex review (PR #43, round 4): stash a snapshot now, before this
      // tick's own downgrade/commit logic below mutates transitionPlanReport
      // in place — a hard handoff for this exact pair later (prep raced
      // EOF, or the source failed to start) can then report what was
      // actually evaluated instead of a generic "no candidate" stub. Own
      // copies of the mutable nested objects (entry/candidates/stemCache)
      // so later in-place edits to transitionPlanReport itself (§ below)
      // can't retroactively change what was stashed for this tick.
      this.#stashLastEvaluatedTransition(stemCacheLookupKey, transitionPlanReport);

      if (selectedPlan.mode === 'gapless' || !(selectedPlan.fadeSec > 0)) return;
      let norm = normalizeTransitionPlan(selectedPlan);
      // Codex review (PR #46, round 5): which RAW (pre-normalizeTransitionPlan)
      // mode `norm` currently reflects — normalizeTransitionPlan() flattens
      // both 'beatmix' and 'phrase-crossfade' into mixPlan.mode: 'crossfade'/
      // 'beatmix' respectively at different points, so `norm.mixPlan.mode`
      // alone can't distinguish a phrase-crossfade plan from a legacy one
      // below. Reassigned alongside `norm` itself whenever it's rebuilt from
      // a different rawPlan (the stem-mix -> bestNonStemPlan re-plan below).
      let normRawMode = selectedPlan.mode;

      let modeDowngraded = false;

      // §2.3/§8.4: TRACK loop mode repeats the SAME track (`next === current`
      // above) — planBeatSyncedTransition still picks a head-window entry
      // candidate for it as if it were a different, upcoming song. Seeking
      // there on spawn would permanently omit everything before that
      // candidate after the very first loop, since every subsequent repeat
      // re-arms with the same nonzero entrySec (Codex round-5). The outgoing
      // exit point is still meaningful (fade the ending into the beginning),
      // so only the entry side is forced back to a true restart; downgrade
      // out of beatmix/phrase-crossfade since both assumed the original
      // selected boundary (bar-aligned or phrase-aligned) rather than the
      // file's real start.
      if (next === current) {
        if (norm.mixPlan.mode === 'stem-mix') {
          // stem-mix's own exitStartSec was chosen with vocal-safety
          // relaxed (requireExitVocalSafe/requireEntryForwardSafe: false)
          // — reusing it for a plain (non-separated) crossfade can violate
          // 禁止5 (vocal-on-vocal collision), since without the per-stem
          // envelope there's nothing keeping the outgoing vocal tail clear
          // of the incoming track's own start. Re-plan from bestNonStemPlan
          // (the ranker's best of beatmix/phrase-crossfade/legacy, i.e. the
          // ordinary, non-relaxed candidates) instead of merely stripping
          // stems from the relaxed plan (Codex) — matches the same beatmix/
          // plain-crossfade downgrade this loop-mode override already
          // performs safely for non-stem plans.
          if (bestNonStemPlan.mode === 'gapless' || !(bestNonStemPlan.fadeSec > 0)) return;
          norm = normalizeTransitionPlan(bestNonStemPlan);
          normRawMode = bestNonStemPlan.mode;
          // Phase 9A: the mode actually used just changed away from the
          // planned 'stem-mix' — see transitionPlanReport's finalization
          // below.
          modeDowngraded = true;
          // Codex review (PR #46, round 6): transitionPlanReport.exit was
          // built (above, at report-construction time) from the ORIGINAL
          // selectedPlan (stem-mix) — bestNonStemPlan's own ranker-selected
          // exit/entry pair need not be the same one, since it comes from
          // an entirely independent (stricter, non-relaxed) candidate
          // search. Without recomputing here, a committed [MIX PLAN] log
          // for this downgrade could report the stem-mix plan's exit
          // second/bar/vocalActive state while the audio actually executed
          // bestNonStemPlan's different exit — the existing entry-side
          // reconciliation below (pendingEntrySec) only fixes entry, not
          // exit.
          transitionPlanReport.exit = exitInfo(bestNonStemPlan, outAnalysis, this.sessionTempo.tempoRatio ?? 1);
        }
        norm.entrySec = 0;
        norm.tempoFilter = null;
        norm.sessionTempo = null;
        // Codex review (PR #46, round 5): with the independent ranker
        // (Phase 9D), a phrase-crossfade plan (baseSwap:true, EQ chosen for
        // its own selected phrase boundary) can win even while beatmix is
        // eligible — previously only checking `mode === 'beatmix'` here left
        // a phrase-crossfade's boundary-dependent EQ/baseSwap applied to
        // audio that TRACK loop just reset to entrySec 0, the same class of
        // bug the forcePlainCrossfade downgrade below already guards
        // against for an unhonored source seek.
        if (norm.mixPlan.mode === 'beatmix' || normRawMode === 'phrase-crossfade') {
          norm.mixPlan = {
            ...norm.mixPlan, mode: 'crossfade', sync: null, eq: null, targetBpm: null, baseSwap: false, stems: null,
          };
          modeDowngraded = true;
        }
      }

      // outAnalysis.durationSec / plan exit timestamps are absolute,
      // native-timeline positions in the outgoing file. MixStream.positionSec
      // is playback-domain (post-stretch) AND relative to wherever #current's
      // decoder actually started — which is native offset #currentEntrySec,
      // not 0, when #current was itself promoted from a seeked beatmix/phrase
      // source. Both the tempo stretch (§2.3/§8.4) and this seek offset must
      // be accounted for before comparing against positionSec, or the
      // computed startSec sits too late (by the stretch amount, and/or by
      // #currentEntrySec seconds) for positionSec to ever catch up to in
      // time, arming the next chained transition late or missing it entirely
      // (Codex round-3 P1).
      const outgoingTempoRatio = this.sessionTempo.tempoRatio ?? 1;
      const currentEntrySec = this.currentEntrySec ?? 0;
      const nativeDurationSec = outAnalysis.durationSec
        ?? this.#resolvePlaybackDurationSec(current)
        ?? current.duration;
      const remainingNativeDurationSec = nativeDurationSec != null
        ? Math.max(0, nativeDurationSec - currentEntrySec)
        : null;
      const durationSec = compensateDurationSec(remainingNativeDurationSec, outgoingTempoRatio);
      const positionSec = this.#getMixStream()?.positionSec ?? 0;
      const startSec = norm.exitStartSec != null && durationSec != null
        ? compensateDurationSec(Math.max(0, norm.exitStartSec - currentEntrySec), outgoingTempoRatio)
        : (durationSec != null ? Math.max(0, durationSec - norm.mixPlan.fadeSec) : null);

      const fadeWindow = norm.mixPlan.fadeSec;
      // Gate on distance to the SELECTED exit point (startSec), not to EOF.
      // A beatmix/phrase exit can sit up to TAIL_WINDOW_SEC before EOF —
      // gating on `remaining` (time to EOF) alone means prep wouldn't fire
      // until we're already much closer to (or past) that exit than
      // CROSSFADE_PREP_LEAD_SEC, missing the selected downbeat by however
      // long preparation itself takes (Codex round-3 P2).
      const prepDue = startSec != null
        ? positionSec >= startSec - CROSSFADE_PREP_LEAD_SEC
        : remaining <= fadeWindow + CROSSFADE_PREP_LEAD_SEC;
      if (prepDue) {
        this.#sourcePreparer.ensureIncomingPrep(next, {
          startSec: norm.entrySec,
          tempoFilter: norm.tempoFilter,
          sessionTempo: norm.sessionTempo,
        });
        // Phase 8: late-bound (see #ensureOutgoingStemPrep()'s docstring) —
        // fired from this same gate, not at track-promotion time.
        if (norm.mixPlan.mode === 'stem-mix' && outCachedStems && inCachedStems) {
          const outgoingStemTempoFilter = this.#outgoingStemTempoFilter(tempoBackend);
          // undefined means a required stretch couldn't be expressed — spawning
          // the stems anyway would decode them at native tempo while #current
          // keeps playing stretched, drifting apart for the whole stem window.
          // Skip prep entirely so #takePreparedOutgoingStems() naturally misses
          // at take time and the transition downgrades to a plain crossfade.
          if (outgoingStemTempoFilter !== undefined) {
            // Fire-and-forget, like #ensureIncomingPrep() above — but these
            // two are async (revalidate the cache before spawning; see
            // #ensureOutgoingStemPrep()'s docstring), so an unhandled
            // rejection would otherwise surface as an unhandled-rejection
            // crash instead of the fail-soft downgrade #takePreparedXStems()
            // already provides when prep never lands.
            this.#sourcePreparer.ensureOutgoingStemPrep(outCachedStems, current.videoId, {
              startSec: norm.exitStartSec ?? 0,
              tempoFilter: outgoingStemTempoFilter,
            }).catch((err) => console.warn('[GuildPlayer] outgoing stem prep failed:', err.message));
            this.#sourcePreparer.ensureIncomingStemPrep(inCachedStems, next.videoId, {
              startSec: norm.entrySec,
              tempoFilter: norm.tempoFilter,
            }).catch((err) => console.warn('[GuildPlayer] incoming stem prep failed:', err.message));
          }
        }
      }

      const readyToFade = startSec != null
        ? positionSec >= startSec
        : remaining <= fadeWindow;
      if (!readyToFade) return;

      let source;
      try {
        source = await this.#sourcePreparer.takePreparedIncoming(next, { startSec: norm.entrySec, tempoFilter: norm.tempoFilter });
      } catch (err) {
        console.warn('[GuildPlayer] incoming pcm source failed:', err.message);
        await this.#sourcePreparer.cleanupIncomingTempFile();
        return;
      }

      if (this.#queue.current !== current || this.#isForceSkip()) {
        source.destroy();
        await this.#sourcePreparer.cleanupIncomingTempFile();
        return;
      }
      if (getGuildSettings(this.#guildId).fade === false) {
        source.destroy();
        await this.#sourcePreparer.cleanupIncomingTempFile();
        return;
      }

      // §9.3/§2.3/§8.4: createFileSource's fallback to createStreamSource
      // (when the track isn't normalize-eligible) ignores startSec/
      // tempoFilter entirely — the source actually starts at native
      // position 0, unstretched. Trusting `norm` there would stash a
      // stretch/seek promotion bookkeeping doesn't match reality.
      const sourceHonorsPlan = source.tempoHonored !== false;
      const pendingSessionTempo = sourceHonorsPlan ? norm.sessionTempo : null;
      const pendingEntrySec = sourceHonorsPlan ? norm.entrySec : 0;
      // Any plan with a nonzero entrySec (beatmix OR phrase-crossfade)
      // assumes the incoming audio actually starts at that seeked,
      // downbeat-aligned/vocal-safe position. normalizeTransitionPlan()
      // already flattens phrase-crossfade into mixPlan.mode: 'crossfade',
      // so gating this downgrade on mode === 'beatmix' alone let an
      // unhonored phrase-crossfade through unchanged: its baseSwap EQ
      // decision was made assuming the selected phrase boundary, which this
      // source never actually reached (native position 0 instead). Gate on
      // entrySec (Codex round-4) OR tempoFilter (round-5): a beatmix whose
      // selected entry candidate happens to sit at entrySec === 0 can still
      // require a nonzero tempo stretch — entrySec alone missed that case,
      // leaving mode: 'beatmix' (bar-envelope EQ) running against audio that
      // fell back to native, unstretched tempo. Either field being set means
      // the plan required a transform this source didn't actually apply.
      const requiresUnhonoredTransform = norm.entrySec > 0 || norm.tempoFilter != null;
      const forcePlainCrossfade = !sourceHonorsPlan && requiresUnhonoredTransform;
      if (forcePlainCrossfade) {
        // The stem pairs (if any were prepped) were prepped for a plan this
        // source cannot honor — release their ffmpeg processes now rather
        // than leaving them blocked on backpressure until an unrelated
        // #clearPreparedIncoming() call happens to sweep them up later.
        this.#sourcePreparer.clearPreparedOutgoingStems();
        this.#sourcePreparer.clearPreparedIncomingStems();
        if (norm.mixPlan.mode === 'stem-mix') {
          // stem-mix's exitStartSec/entrySec were chosen with vocal-safety
          // relaxed (requireExitVocalSafe/requireEntryForwardSafe: false).
          // Downgrading to a plain (non-separated) crossfade but keeping
          // that same window would reuse a position that's only safe WITH
          // the per-stem envelope keeping the outgoing vocal tail clear of
          // the incoming track's own start — a plain crossfade has no such
          // envelope, so this can violate 禁止5 (vocal-on-vocal collision).
          // Abort this attempt entirely rather than downgrade the window
          // (Codex); mark the pair unavailable so the NEXT arm tick's
          // ranker call above evaluates with stemsAvailable: false instead
          // of re-picking this same relaxed stem plan and looping on this
          // same abort forever (Codex round-9 follow-up).
          this.stemMixUnavailableKey = stemCacheLookupKey;
          source.destroy();
          await this.#sourcePreparer.cleanupIncomingTempFile();
          return;
        }
        // Phase 9A: reached only for beatmix/phrase-crossfade (stem-mix
        // returned above) — both lose their planned entry/EQ treatment here
        // (baseSwap forced false, sync/eq/stems nulled below), which is
        // exactly the "downgraded" case the [MIX PLAN] log is meant to
        // surface, even though phrase-crossfade's mixPlan.mode was already
        // the string 'crossfade' before AND after this (normalizeTransitionPlan
        // flattens it regardless of forcePlainCrossfade).
        modeDowngraded = true;
      }
      let mixPlan = forcePlainCrossfade
        ? { ...norm.mixPlan, mode: 'crossfade', sync: null, eq: null, targetBpm: null, baseSwap: false, stems: null }
        : norm.mixPlan;

      // Phase 8 (Codex): the outgoing stems were seeked to a FIXED native
      // exitStartSec back at prepDue and don't track #current's live
      // position — the normal small overshoot past `startSec` here (one
      // arm-tick's worth) is harmless and already tolerated by the
      // non-stem-mix path too. What actually breaks alignment is the
      // #takePreparedIncoming() await ABOVE stretching arbitrarily long (a
      // still-downloading/normalizing incoming track) while #current keeps
      // playing — so compare against the position snapshot taken before
      // that await, not against `startSec` itself.
      if (mixPlan.mode === 'stem-mix') {
        const freshPositionSec = this.#getMixStream()?.positionSec ?? positionSec;
        if (freshPositionSec - positionSec > OUTGOING_STEM_DRIFT_TOLERANCE_SEC) {
          // Same reasoning as the forcePlainCrossfade abort above — a plain
          // crossfade reusing stem-mix's relaxed window is unsafe (Codex),
          // and marking the pair unavailable avoids looping on this same
          // abort every arm tick (Codex round-9 follow-up).
          this.stemMixUnavailableKey = stemCacheLookupKey;
          this.#sourcePreparer.clearPreparedOutgoingStems();
          this.#sourcePreparer.clearPreparedIncomingStems();
          source.destroy();
          await this.#sourcePreparer.cleanupIncomingTempFile();
          return;
        }
      }

      // Phase 8: take the two prepared stem pairs only now that we know a
      // plain crossfade isn't already forced (sourceHonorsPlan check above)
      // — if either pair didn't finish prepping in time, downgrade to the
      // plain crossfade `source` (the incoming full mix) is already valid
      // for, rather than aborting an otherwise-ready transition.
      let outgoingStems = null;
      let incomingStems = null;
      if (mixPlan.mode === 'stem-mix') {
        // Take BOTH unconditionally (never short-circuit on the first) —
        // each #takePreparedXStems() call is self-contained (transfers
        // ownership out of the prepared-field, or clears/destroys it on a
        // mismatch), so skipping one when the other is missing would leave
        // it dangling in its prepared-field, unconsumed, until some later
        // unrelated #clearPreparedIncoming() call happened to sweep it up.
        outgoingStems = this.#sourcePreparer.takePreparedOutgoingStems(current.videoId, {
          startSec: norm.exitStartSec ?? 0,
          tempoFilter: this.#outgoingStemTempoFilter(tempoBackend),
        });
        incomingStems = this.#sourcePreparer.takePreparedIncomingStems(next.videoId, {
          startSec: norm.entrySec,
          tempoFilter: norm.tempoFilter,
        });
        if (!outgoingStems || !incomingStems) {
          outgoingStems?.vocal?.destroy?.();
          outgoingStems?.instrumental?.destroy?.();
          incomingStems?.vocal?.destroy?.();
          incomingStems?.instrumental?.destroy?.();
          // Same reasoning as the other stem-mix abort paths above — a
          // plain crossfade reusing this window is unsafe (Codex). Without
          // marking the pair unavailable, the cache lookup and
          // planStemTransitionFn() above are independent of spawn success,
          // so every subsequent arm tick would re-select this same relaxed
          // stem plan and abort again here — retrying until the outgoing
          // track reaches EOF and never letting the ranker's other
          // candidates run at all (Codex round-9 follow-up).
          this.stemMixUnavailableKey = stemCacheLookupKey;
          source.destroy();
          await this.#sourcePreparer.cleanupIncomingTempFile();
          return;
        }
      }

      // Phase 9A (docs/mix-transition-phase9.md §3): finalize the [MIX PLAN]
      // report now that mixPlan reflects everything that could still change
      // the actually-executed mode (TRACK loop re-derivation,
      // forcePlainCrossfade) — every earlier `return` above this point was
      // an abort (retry next arm tick, not a committed transition), so this
      // is reached exactly once per real transition, not once per tick.
      transitionPlanReport.selected = modeDowngraded ? mixPlan.mode : plannedMode;
      transitionPlanReport.downgradedFrom = modeDowngraded ? plannedMode : null;
      // Codex review (PR #43): entry was built from the ORIGINAL plan
      // (norm.entrySec at report-build time). `pendingEntrySec` above is the
      // entry actually applied to the promoted source (forced to 0 when
      // !sourceHonorsPlan, same as the TRACK-loop-mode override earlier) —
      // reconcile the report to that before logging so a downgraded
      // transition's log doesn't describe an entry point the audio never
      // used.
      if (transitionPlanReport.entry.sec !== pendingEntrySec) {
        transitionPlanReport.entry.sec = pendingEntrySec;
        // Codex review (PR #43, round 2): native offset 0 is not necessarily
        // bar 0 — the file's first detected downbeat can sit later, and a
        // downgraded plain transition no longer uses the original bar
        // candidate at all. Report bar as unknown rather than asserting an
        // alignment that was never actually executed.
        transitionPlanReport.entry.bar = null;
      }

      // Set promotion state BEFORE calling startCrossfade()/
      // startStemCrossfade(): if the outgoing source is already at EOF, the
      // synchronous #scheduleRead() inside either can promote the incoming
      // source (and fire #onCrossfadePromoted synchronously) before this
      // call returns — #onCrossfadePromoted must see the real target/tempo,
      // not stale values from a previous crossfade attempt. Rolled back on
      // failure.
      this.pendingSessionTempo = pendingSessionTempo;
      this.pendingIncomingEntrySec = pendingEntrySec;
      this.crossfadeTargetTrack = next;
      this.crossfadeStarted = true;

      const started = mixPlan.mode === 'stem-mix'
        ? this.#getMixStream().startStemCrossfade(
          { outgoing: outgoingStems, incoming: { ...incomingStems, full: source } },
          mixPlan,
        )
        : this.#getMixStream().startCrossfade(source, mixPlan);
      if (!started) {
        this.pendingSessionTempo = null;
        this.pendingIncomingEntrySec = 0;
        this.crossfadeTargetTrack = null;
        this.crossfadeStarted = false;
        // startStemCrossfade() already destroys every source it was handed
        // (including `source`/incoming.full) on a rejected call, mirroring
        // startCrossfade()'s own contract — avoid double-destroying it here.
        if (mixPlan.mode !== 'stem-mix') source.destroy();
        await this.#sourcePreparer.cleanupIncomingTempFile();
        return;
      }
      // Codex review (PR #43): only record/log once the mixer has actually
      // accepted this transition — startCrossfade()/startStemCrossfade() can
      // still reject (e.g. a prepared source already errored) after every
      // check above passed, and the `if (!started)` branch above returns
      // without starting anything. Logging before this point would count a
      // rejected attempt, then double-count the same real transition when a
      // later arm tick retries and succeeds.
      this.#logTransitionPlanFn(transitionPlanReport);
      // Codex review (PR #43, round 6): this evaluation has now produced
      // its own committed-transition log — clear the stash so a later
      // recurrence of this exact pair (e.g. a short TRACK loop) can't have
      // its own hard handoff replay THIS transition's candidates as if
      // they were freshly evaluated for it.
      this.lastEvaluatedTransitionReport = null;
    } finally {
      this.#crossfadeArming = false;
    }
  }

  /**
   * Codex review (PR #43, round 4): own copies of the mutable nested
   * objects — #maybeStartCrossfade() mutates `transitionPlanReport.entry`/
   * `.selected`/`.downgradedFrom` in place further down the SAME tick this
   * report was built on (for the normal committed-transition log), and
   * that must never retroactively change what this stash reports for a
   * later, unrelated hard handoff.
   */
  #stashLastEvaluatedTransition(pairKey, report) {
    this.lastEvaluatedTransitionReport = {
      pairKey,
      evaluatedAt: Date.now(),
      report: {
        ...report,
        candidates: { ...report.candidates },
        stemCache: { ...report.stemCache },
        exit: report.exit ? { ...report.exit } : report.exit,
        entry: report.entry ? { ...report.entry } : report.entry,
      },
    };
  }

  /**
   * Codex review (PR #43, round 4): returns a fresh stashed evaluation for
   * this exact (outgoing, incoming) pair, re-labeled as the gapless hard
   * handoff that's actually being logged — or null if nothing fresh was
   * evaluated for this pair (falls back to the generic logGaplessTransition
   * stub at the call site). Consumes the stash either way so a later,
   * different hard handoff can't accidentally reuse it.
   */
  /**
   * @param {number} [entrySec] Codex review (PR #43, round 6): the
   *   planned/evaluated candidate's own entry (possibly a nonzero,
   *   downbeat-aligned seek) never actually got applied — this hard
   *   handoff starts the incoming source at whatever native offset it
   *   really started at (0 for a plain playNext(), or #onSnapHandoff's own
   *   already-computed `entrySec` when it honored a prepared seek).
   *   Overwrite the report's entry with that real value so the log
   *   describes what was executed, not what was planned. Exit is cleared
   *   to unknown (null) rather than kept at the planned candidate's
   *   exit point — the outgoing track actually ran to its own natural
   *   EOF here, not the planned exit, and neither call site has that
   *   native EOF timestamp on hand to report precisely.
   */
  takeMatchingEvaluatedTransition(outgoingTrack, incomingTrack, entrySec = 0) {
    const stashed = this.lastEvaluatedTransitionReport;
    this.lastEvaluatedTransitionReport = null;
    if (!stashed) return null;
    if (Date.now() - stashed.evaluatedAt >= LAST_EVALUATED_TRANSITION_MAX_AGE_MS) return null;
    // Codex review (PR #43, round 9): must use the same #prefetchKey()
    // fallback identity the stash was built with (see stemCacheLookupKey
    // above) — otherwise a videoId-less pair could never match its own
    // stash at all, silently falling back to the generic stub every time.
    const pairKey = `${this.#sourcePreparer.prefetchKey(outgoingTrack) ?? ''}:${this.#sourcePreparer.prefetchKey(incomingTrack) ?? ''}`;
    if (stashed.pairKey !== pairKey) return null;
    const { report } = stashed;
    // Codex review (PR #43, round 7): a stashed report whose evaluated
    // rawPlan was already 'gapless' (no beatmix/stem-mix/phrase-crossfade
    // eligible) reaches this same hard-handoff path — selected is already
    // 'gapless' here, so setting downgradedFrom would falsely claim a
    // downgrade that never happened. Only record one when the mode
    // actually changed.
    if (report.selected !== 'gapless') report.downgradedFrom = report.selected;
    report.selected = 'gapless';
    report.entry.sec = entrySec;
    // Codex review (PR #43, round 8): entrySec===0 does not mean bar 0 was
    // detected/aligned — a hard handoff performs no bar alignment at all,
    // it just starts the file at whatever native offset it started at.
    // Same reasoning already applied to the downgraded-crossfade case
    // (fixed in 3b404ec); this call site reintroduced the same false
    // "bar 0" assertion via the entrySec===0 special case.
    report.entry.bar = null;
    report.exit.sec = null;
    report.exit.bar = null;
    report.exit.vocalActive = null;
    return report;
  }
}

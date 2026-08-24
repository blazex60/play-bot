import {
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  NoSubscriberBehavior,
  StreamType,
  VoiceConnectionStatus,
} from '@discordjs/voice';
import { resolveAudioStream } from './search.js';
import { getGuildSettings } from './settings.js';
import {
  cleanupTempFile,
  isNormalizeDurationAllowed,
  prefetchTrack,
  stageTempFileCopy,
} from './normalize.js';
import { shouldReconnectRetry } from './player/playbackPolicy.js';
import { MixStream } from './audio/mixStream.js';
import { createStreamSource, createFileSource } from './audio/pcmSource.js';
import { analyzeTrackFile, ANALYSIS_VERSION } from './audio/trackAnalysis.js';
import { rankTransitionCandidates } from './audio/transitionCandidates.js';
import { probeDurationSec } from './audio/duration.js';
import { createSessionTempoState, resetSessionTempo, probeTempoBackend, compensateDurationSec, buildTempoFilter } from './audio/tempo.js';
import { TAIL_WINDOW_SEC } from './audio/vocalActivity.js';
import { LoopMode } from './queue.js';
import { getAnalysisQueue, getStemPreparationQueue } from './audio/analysisQueue.js';
import { getCachedStems, separateTrackStems } from './audio/stemCache.js';
import { planStemTransition } from './audio/stemTransition.js';
import { buildTransitionPlanReport, logTransitionPlan, logGaplessTransition } from './audio/transitionLog.js';
import { StemPreparationState, StemPrefetchPriority, StemPrefetchTracker } from './audio/stemPrefetch.js';

const WATCHDOG_INTERVAL = 10_000;
const CROSSFADE_ARM_INTERVAL_MS = 200;
/** Start downloading/decoding the next track this many seconds before overlap. */
const CROSSFADE_PREP_LEAD_SEC = 15;
const MAX_CROSSFADE_SEC = 6;
/**
 * Phase 7D: covers the arm loop's early-return gate for both legacy
 * crossfade (MAX_CROSSFADE_SEC) and beatmix/phrase-crossfade. Exit
 * candidates come from findExitCandidates()'s search over the tail analysis
 * window (TAIL_WINDOW_SEC, e.g. 45s before EOF, §5) — the gate must open
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
const ANALYSIS_MISS_BACKOFF_MS = 30_000;
const WATCHDOG_STALL_THRESHOLD = 30_000;
const QUEUE_EXHAUSTED_TIMEOUT = 30_000;
// Codex review (PR #43, round 4): #pendingGaplessFrom is stashed instance
// state that can outlive the specific autoplay continuation it was meant
// for (e.g. recommend-mode returns `true` without immediately starting a
// track) — bound its validity to a short window so a much-later, unrelated
// playNext() call (a fresh /play after the player sat idle) can't
// misattribute a stale gapless transition.
const PENDING_GAPLESS_MAX_AGE_MS = 30_000;
// Codex review (PR #43, round 4): how stale a #lastEvaluatedTransitionReport
// entry can be and still be trusted to describe the hard handoff that just
// happened for the same pair — bounds reusing a genuinely old evaluation
// from several tracks/minutes ago in the rare case a (current, next)
// videoId pair repeats (e.g. QUEUE-loop wraparound).
const LAST_EVALUATED_TRANSITION_MAX_AGE_MS = 30_000;
/**
 * Default AudioPlayer.maxMissedFrames is 5 (100 ms of null opus reads), after
 * which stop() destroy()s the session MixStream. ffmpeg/yt-dlp hiccups are
 * longer than that; 50 × 20 ms = 1 s.
 */
export const MIXER_MAX_MISSED_FRAMES = 50;
/** How long GuildPlayer waits for ffmpeg/yt-dlp to produce the first PCM. */
export const PCM_WAIT_TIMEOUT_MS = 15_000;

export const MIXER_AUDIO_PLAYER_OPTIONS = {
  behaviors: {
    // Default Pause: if the VC drops out of Ready (reconnect), do not keep
    // reading MixStream and discarding packets / advancing tracks unheard.
    // sessions.js already waits for Ready before constructing GuildPlayer.
    noSubscriber: NoSubscriberBehavior.Pause,
    maxMissedFrames: MIXER_MAX_MISSED_FRAMES,
  },
};

/**
 * silencePaddingFrames default 5: when the opus encoder is not readable,
 * AudioResource.read() returns Discord SILENCE_FRAME and never reads MixStream
 * again, then ends the resource (~100 ms). MixStream is session-lived, so
 * padding-to-end is never correct.
 */
export const MIXER_AUDIO_RESOURCE_OPTIONS = {
  inputType: StreamType.Raw,
  inlineVolume: false,
  silencePaddingFrames: 0,
};

function fallbackAnalysis(track) {
  return {
    confidence: 0.45,
    recommendedOverlapSec: 1.5,
    durationSec: track?.duration ?? null,
    vocalConfidence: 0.2,
  };
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
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

function analysisKilledError() {
  const err = new Error('analysis killed');
  err.code = 'ANALYSIS_KILLED';
  return err;
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw analysisKilledError();
}

export class GuildPlayer {
  #guildId;
  #connection;
  #queue;
  #onDisconnect;
  #handleQueueExhausted;
  #queueExhaustedTimeoutMs;
  #recordPlayFn;
  #onTrackStart;
  #cancelSourceAudioWait = null;
  #pcmWaitGeneration = 0;
  #pcmWaitTimeoutMs = PCM_WAIT_TIMEOUT_MS;
  #pauseRequested = false;
  #audioPlayer;
  #forceSkip = false;
  #hadError = false;
  #playbackStart = 0;
  #lastActiveAt = 0;
  #watchdogTimer = null;
  #currentTempFile = null;
  // Phase 8: mirrors #incomingMeasured's lifecycle exactly (set at spawn,
  // transferred at every point #currentTempFile itself is transferred from
  // #incomingTempFile, cleared at every point #currentTempFile is cleared)
  // so #ensureOutgoingStemPrep() can loudnorm the outgoing stems with the
  // same measured LUFS value the currently-playing full-mix source used.
  #currentMeasured = null;
  #prefetchEntries = new Map();
  #createAudioResource;
  #resolveAudioStream;
  #handlingAfter = false;
  #handlingAfterPlayback = 0;
  #pendingAfter = false;
  #playbackCount = 0;
  #mixStream = null;
  #mixerResource = null;
  #mixerStarted = false;
  /**
   * Phase 7 §8.4: held for the lifetime of the current track. 7B does not
   * yet stretch anything (no beatmix planner exists to pick a targetBpm) —
   * this only tracks the native-BPM reset baseline every new current track
   * starts from, so 7C can call applySessionTempo() from a known-good state.
   */
  #sessionTempo = createSessionTempoState();
  /**
   * Phase 7D §2.3/§8.4: stashed when a beatmix crossfade starts (the plan's
   * incoming {nativeBpm, playbackBpm, tempoRatio}), consumed on promotion so
   * the stretched tempo carries forward instead of resetting to native.
   * Cleared on incoming failure so a dropped beatmix never leaks into a
   * later, unrelated promotion.
   */
  #pendingSessionTempo = null;
  /**
   * Native seconds the pending beatmix/phrase-crossfade incoming source was
   * seeked forward by (createFileSource's startSec) — 0 for anything else.
   * Subtracted from native duration at promotion so remainingSec reflects
   * how much of the source is actually left to play (Codex round-1 P1).
   */
  #pendingIncomingEntrySec = 0;
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
  #currentEntrySec = 0;
  #probeTempoBackendFn;
  #createPcmSourceFn;
  #incomingTempFile = null;
  /**
   * Loudnorm measurement for #incomingTempFile, cached alongside it so a
   * re-prep for the SAME track with different startSec/tempoFilter (a
   * beatmix plan replacing the eager default prep) can respawn just the
   * ffmpeg decoder on the already-downloaded file instead of re-running the
   * full yt-dlp fetch + loudnorm measurement pass (Codex round-2).
   */
  #incomingMeasured = null;
  #analysisCache = new Map();
  #analysisMissAt = new Map();
  #probedDurationCache = new Map();
  /**
   * videoId -> attempt token for the #scheduleAnalysis() job currently in
   * flight for it (Codex, PR #39 round-15/16). #ensureFullPrefetch() and
   * #createPcmSource() both call #scheduleAnalysis() for the same
   * prefetched file — the second, consuming that same prefetch entry once
   * the track actually starts — so without this guard every normalized
   * track gets staged and enqueued for stem separation twice. The first
   * attempt already populates the in-memory and persistent analysis/stem
   * caches everything else reads from, so the second is pure waste.
   *
   * A per-attempt token (not just presence in a Set) matters because
   * analysisQueue's kill()/noteUnderrun() rejects a job's promise via
   * Promise.race() the instant it's killed — independent of whether that
   * job's own callback (and its own finally) has actually finished
   * running. Without a token, a killed job A's delayed finally could run
   * AFTER a newer job B has already been scheduled for the same videoId
   * (started in the gap between A's immediate kill-rejection and A's
   * callback actually unwinding), and A's cleanup would then delete B's
   * still-active guard entry — letting a third job start concurrently
   * with B. Only deleting when the stored token still matches the
   * attempt that's settling closes that gap.
   */
  #scheduledAnalysisTokens = new Map();
  #crossfadeArmTimer = null;
  #crossfadeStarted = false;
  #crossfadeArming = false;
  #crossfadeTargetTrack = null;
  /** Prevents Idle recovery from stacking playNext() while a restart is in flight. */
  #idleRecovering = false;
  /** @type {{ track: object, promise: Promise<object>, source: object|null } | null} */
  #preparedIncoming = null;
  /** Bumped when cancelling prep so in-flight #createPcmSource won't claim temps. */
  #incomingPrepId = 0;
  #getTrackAnalysisFn;
  #putTrackAnalysisFn;
  #analyzeTrackFileFn;
  #analysisQueue;
  /**
   * Phase 9C (docs/mix-transition-phase9.md §5): dedicated pausable serial
   * queue for full-track Demucs only (Phase 8's outgoing-track separation
   * and Phase 9B's next/next+1 prefetch), kept separate from
   * #analysisQueue so a long-running Demucs job can never sit in front of
   * (or share pause/kill state with) realtime BPM/downbeat/phrase/key/
   * vocal-activity analysis for an unrelated track. Same DI convention as
   * #analysisQueue: null falls back to the process-wide
   * getStemPreparationQueue() singleton via #stemQ().
   */
  #stemQueue;
  /** @type {{ key: *, promise: Promise<boolean|null> } | null} */
  #queueRefill = null;
  #prefetchTrackFn;
  #stageTempFileCopyFn;
  #separateTrackStemsFn;
  #getCachedStemsFn;
  #planStemTransitionFn;
  /** Phase 9A (docs/mix-transition-phase9.md §3): test-only override — see logTransitionPlan()'s own docstring for the always-on-metrics/MIX_DEBUG-gated-log split. */
  #logTransitionPlanFn;
  /** Phase 9A (Codex review, PR #43): test-only override — see logGaplessTransition()'s own docstring for why the snap-handoff path needs a separate, report-less logging entry point. */
  #logGaplessTransitionFn;
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
  #pendingGaplessFrom = null;
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
  #lastEvaluatedTransitionReport = null;
  /** Test-only override — the two stem-prep methods call createFileSource() directly (they bypass #createPcmSource entirely, since stem WAVs need no download/normalize/loudnorm pass), so a dedicated injection point mirrors this file's existing DI convention for every other real-process spawn. */
  #createFileSourceFn;
  /** @type {{ videoId: string, prep: {startSec:number,tempoFilter:string|null}, vocal: object, instrumental: object } | null} */
  #preparedOutgoingStems = null;
  /** Identity key of an in-flight #ensureOutgoingStemPrep() cache-revalidation await, or null. Lets a later/different call — or an explicit clear — invalidate an earlier one still awaiting, instead of every arm tick spawning its own independent attempt. */
  #preparingOutgoingStemsKey = null;
  /** @type {{ videoId: string, prep: {startSec:number,tempoFilter:string|null}, vocal: object, instrumental: object } | null} */
  #preparedIncomingStems = null;
  /** Identity key of an in-flight #ensureIncomingStemPrep() cache-revalidation await, or null — same rationale as #preparingOutgoingStemsKey. */
  #preparingIncomingStemsKey = null;
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
  #stemMixUnavailableKey = null;
  /**
   * Phase 9B (docs/mix-transition-phase9.md §4): per-videoId prefetch
   * bookkeeping for next (HIGH) / next+1 (LOW), driven from
   * #prefetchUpcoming(). Purely observational for the HIGH lane (B already
   * gets a real download+separate pass from Phase 8's own
   * #ensureFullPrefetch()/#scheduleAnalysis() pipeline regardless of this
   * tracker's existence); for the LOW lane (C) it also drives the actual
   * dispatch, since nothing else in the pipeline keeps C's audio around
   * long enough for Demucs — see #ensureStemPrefetch()/#runLowPriorityStemPrefetch().
   */
  #stemPrefetchTracker = new StemPrefetchTracker();
  /** Dedup guard for #runLowPriorityStemPrefetch() — same rationale as #scheduledAnalysisTokens, but keyed by videoId presence only since this path has no killed-job/stale-token race to guard against (it never gets restarted mid-flight, only skipped while already in the Set). */
  #lowPriorityStemPrefetch = new Set();
  /**
   * Codex review (PR #44, P2): videoIds whose #scheduleAnalysis() job has
   * already been retried once after an ANALYSIS_KILLED abort — caps the
   * retry to a single attempt per videoId so a guild under sustained CPU
   * pressure can't loop forever re-scheduling the same doomed job. Pruned
   * alongside #stemPrefetchTracker in #prefetchUpcoming() once a videoId
   * leaves the active prefetch window.
   */
  #stemPrefetchRetriedAfterKill = new Set();

  constructor({
    guildId,
    connection,
    queue,
    onDisconnect,
    handleQueueExhausted = null,
    queueExhaustedTimeoutMs = QUEUE_EXHAUSTED_TIMEOUT,
    recordPlayFn = null,
    onTrackStart = null,
    audioPlayer = createAudioPlayer(MIXER_AUDIO_PLAYER_OPTIONS),
    createAudioResourceFn = createAudioResource,
    resolveAudioStreamFn = resolveAudioStream,
    /**
     * Test-only override for the real normalize/prefetch pcm source
     * pipeline. §9.3/§2.3/§8.4: the player treats a returned source's
     * `tempoHonored !== false` as "startSec/tempoFilter were actually
     * applied" and stashes beatmix/phrase promotion bookkeeping (session
     * tempo, entry-offset subtraction) accordingly — a custom factory that
     * ignores startSec/tempoFilter must set `source.tempoHonored = false`,
     * or the player will wrongly believe a plain/native-tempo source was
     * seeked and stretched as requested.
     */
    createPcmSourceFn = null,
    getTrackAnalysisFn = null,
    putTrackAnalysisFn = null,
    analyzeTrackFileFn = analyzeTrackFile,
    analysisQueue = null,
    stemQueue = null,
    prefetchTrackFn = prefetchTrack,
    probeTempoBackendFn = probeTempoBackend,
    stageTempFileCopyFn = stageTempFileCopy,
    separateTrackStemsFn = separateTrackStems,
    getCachedStemsFn = getCachedStems,
    planStemTransitionFn = planStemTransition,
    createFileSourceFn = createFileSource,
    logTransitionPlanFn = logTransitionPlan,
    logGaplessTransitionFn = logGaplessTransition,
    pcmWaitTimeoutMs = PCM_WAIT_TIMEOUT_MS,
  }) {
    this.#guildId = guildId;
    this.#connection = connection;
    this.#queue = queue;
    this.#onDisconnect = onDisconnect;
    this.#handleQueueExhausted = handleQueueExhausted;
    this.#queueExhaustedTimeoutMs = queueExhaustedTimeoutMs;
    this.#recordPlayFn = recordPlayFn;
    this.#onTrackStart = onTrackStart;
    this.#audioPlayer = audioPlayer;
    this.#createAudioResource = createAudioResourceFn;
    this.#resolveAudioStream = resolveAudioStreamFn;
    this.#createPcmSourceFn = createPcmSourceFn;
    this.#getTrackAnalysisFn = getTrackAnalysisFn;
    this.#putTrackAnalysisFn = putTrackAnalysisFn;
    this.#analyzeTrackFileFn = analyzeTrackFileFn;
    this.#analysisQueue = analysisQueue;
    this.#stemQueue = stemQueue;
    this.#prefetchTrackFn = prefetchTrackFn;
    this.#probeTempoBackendFn = probeTempoBackendFn;
    this.#stageTempFileCopyFn = stageTempFileCopyFn;
    this.#separateTrackStemsFn = separateTrackStemsFn;
    this.#getCachedStemsFn = getCachedStemsFn;
    this.#planStemTransitionFn = planStemTransitionFn;
    this.#createFileSourceFn = createFileSourceFn;
    this.#logTransitionPlanFn = logTransitionPlanFn;
    this.#logGaplessTransitionFn = logGaplessTransitionFn;
    this.#pcmWaitTimeoutMs = Number.isFinite(pcmWaitTimeoutMs)
      ? pcmWaitTimeoutMs
      : PCM_WAIT_TIMEOUT_MS;

    this.#initMixerPipeline();
    this.#audioPlayer.on(AudioPlayerStatus.Idle, () => {
      if (!this.#mixerStarted || this.#idleRecovering) return;
      console.warn('[GuildPlayer] unexpected Idle, recovering mixer playback');
      this.#idleRecovering = true;
      // Never play the rebuilt mixer empty: MixStream's 8s underrun guard
      // would sourceerror while playNext is still downloading/analyzing.
      // handleAfter already calls playNext; mid-track Idle must restart here.
      this.#recoverMixerPlayback({ play: false });
      const restartCurrent = this.#queue.current && !this.#handlingAfter && !this.#forceSkip;
      const done = () => { this.#idleRecovering = false; };
      if (restartCurrent) {
        this.playNext().catch((err) => {
          console.error('[GuildPlayer] mixer Idle restart failed:', err.message);
        }).finally(done);
      } else {
        done();
      }
    });

    this.#audioPlayer.on('stateChange', (oldState, newState) => {
      if (newState.status === AudioPlayerStatus.Playing) {
        this.#lastActiveAt = Date.now();
      }
    });

    this.#audioPlayer.on('error', err => {
      console.error('[GuildPlayer] audioPlayer error:', err);
      this.#hadError = true;
      this.#abortSourceAudioWait();
      this.#mixStream?.dropCurrent();
      // Codex review (PR #45, P1): dropCurrent() resets MixStream's own
      // underrun state WITHOUT emitting 'underrunClear' — if this player
      // had a stem-queue pause source registered (mid-underrun when this
      // error hit), nothing would ever clear it otherwise, indefinitely
      // SIGSTOPping the shared process-wide stem queue's current job for
      // every guild. See #initMixerPipeline()'s 'underrun' wiring.
      this.#stemQ().noteUnderrunCleared(this);
    });

    // AutoPaused means playable.length === 0. Re-subscribe so a Ready
    // connection is visible on the next 20 ms tick and playback resumes.
    this.#audioPlayer.on(AudioPlayerStatus.AutoPaused, () => {
      this.#connection?.subscribe?.(this.#audioPlayer);
    });

    this.#connection.subscribe(this.#audioPlayer);
    this.#connection.on?.('stateChange', (_oldState, newState) => {
      if (newState?.status === VoiceConnectionStatus.Destroyed) {
        this.#abortSourceAudioWait();
      }
    });
  }

  /**
   * Codex review (PR #43, round 3): `gaplessFrom` — the track that just
   * naturally finished, when this call is a hard handoff (no crossfade, no
   * snap adoption) — is consume-once via #pendingGaplessFrom when the
   * caller doesn't pass it explicitly, so the external autoplay-continuation
   * path (#handleAfter's #startQueueRefill branch, whose own
   * handleQueueExhausted callback eventually calls this public method after
   * adding a track) is covered too, not just #handleAfter's own direct
   * playNext() call. Logged only after #playNextMixer's setCurrent()
   * actually accepts the source (see there) — never here — so a track that
   * fails to start (Codex round-3 P2) doesn't get counted as a committed
   * transition.
   */
  async playNext(gaplessFrom = null) {
    const track = this.#queue.current;
    if (!track) {
      await this.#disconnect();
      return;
    }
    const pending = this.#pendingGaplessFrom;
    this.#pendingGaplessFrom = null;
    const pendingStillFresh = pending && Date.now() - pending.setAt < PENDING_GAPLESS_MAX_AGE_MS;
    const resolvedGaplessFrom = gaplessFrom ?? (pendingStillFresh ? pending.track : null);
    await this.#playNextMixer(track, { gaplessFrom: resolvedGaplessFrom });
  }

  async #playNextMixer(track, { gaplessFrom = null } = {}) {
    if (this.#queueRefill && this.#queueRefill.key !== this.#queueRefillKey(track)) {
      this.#queueRefill = null;
    }
    let source;
    try {
      source = await this.#takePreparedIncoming(track, { forPlayback: true });
    } catch (err) {
      console.warn(`[GuildPlayer] pcm source failed for ${track.title}:`, err.message);
      this.#hadError = true;
      if (this.#handlingAfter) {
        this.#pendingAfter = true;
      } else {
        this.#advanceAfterPlayback();
      }
      return;
    }

    if (this.#queue.current !== track) {
      source.destroy();
      await this.#cleanupCurrentTempFile();
      if (!this.#queue.current) await this.#disconnect();
      return;
    }
    if (this.#forceSkip) {
      source.destroy();
      await this.#cleanupCurrentTempFile();
      this.#forceSkip = false;
      const nextTrack = this.#queue.next({ forceAdvance: true });
      if (nextTrack === null) {
        await this.#disconnect();
      } else {
        await this.playNext();
      }
      return;
    }

    // Wait for real PCM *before* setCurrent. MixStream's 8s underrun guard
    // starts as soon as a current source is attached; a slow decoder would
    // sourceerror/skip the track while this 15s wait was still pending.
    // Between tracks MixStream stays in keep-alive silence until then.
    const waitGeneration = this.#pcmWaitGeneration;
    const waited = await this.#waitForSourceAudio(source);
    if (this.#isSourceAudioWaitSuperseded(track, waited, waitGeneration)) {
      this.#discardUnusedSource(source);
      return;
    }
    if (waited !== 'ready') {
      this.#discardUnusedSource(source);
      this.#hadError = true;
      if (this.#handlingAfter) {
        this.#pendingAfter = true;
      } else {
        this.#advanceAfterPlayback();
      }
      return;
    }

    this.#playbackStart = Date.now();
    this.#lastActiveAt = Date.now();
    this.#resetWatchdog();
    this.#playbackCount += 1;

    // Rebuild first if Idle/stop ended the mixer, attach PCM, then play.
    // Playing before setCurrent leaves MixStream with no current source and
    // starts the underrun guard against silence.
    if (this.#isMixerDead()) {
      this.#recoverMixerPlayback({ play: false });
    }
    const durationSec = this.#resolvePlaybackDurationSec(track);
    if (!this.#mixStream.setCurrent(source, { durationSec })) {
      return;
    }
    // Codex review (PR #43, round 3): only now that setCurrent() has
    // actually accepted this source — a track that fails earlier in this
    // method (PCM/source-audio-wait errors above) never reaches here and is
    // correctly never counted as a committed transition.
    if (gaplessFrom) {
      // Codex review (PR #43, round 4): prefer a fresh evaluation of this
      // exact pair from #maybeStartCrossfade() (the plan that was actually
      // in flight when prep raced EOF) over the generic gapless stub, so
      // the log reflects what was really evaluated/missed.
      const evaluated = this.#takeMatchingEvaluatedTransition(gaplessFrom, track);
      if (evaluated) {
        this.#logTransitionPlanFn(evaluated);
      } else {
        this.#logGaplessTransitionFn({ outgoingTrack: gaplessFrom, incomingTrack: track });
      }
    }
    this.#resetSessionTempoFor(track);
    // Attach the opus pipeline only after PCM has arrived so the encoder's
    // first packet is music, not keep-alive silence. A /pause during the
    // wait leaves AudioPlayer Idle; honor it and do not start until resume.
    if (!this.#pauseRequested) {
      this.#ensureMixerPlaying();
    }
    this.#clearPreparedIncoming();
    this.#crossfadeStarted = false;
    this.#crossfadeTargetTrack = null;
    // A fresh track start must never carry a stale beatmix stash from a
    // prior, abandoned crossfade attempt (§2.3/§8.4) — #resetSessionTempoFor
    // above already establishes this track's own baseline.
    this.#pendingSessionTempo = null;
    this.#pendingIncomingEntrySec = 0;
    this.#currentEntrySec = 0;
    this.#startCrossfadeArm();
    this.#prefetchUpcoming();
    this.#ensureIncomingPrepForUpcoming();
    this.#recordPlay(track);
    this.#onTrackStart?.(track.videoId);
  }

  #resolvePlaybackDurationSec(track) {
    if (!track) return null;
    if (track.videoId && this.#probedDurationCache.has(track.videoId)) {
      return this.#probedDurationCache.get(track.videoId);
    }
    if (track.videoId && this.#analysisCache.has(track.videoId)) {
      const fromAnalysis = this.#analysisCache.get(track.videoId)?.durationSec;
      if (fromAnalysis != null) return fromAnalysis;
    }
    return track.duration ?? null;
  }

  #ensureIncomingPrepForUpcoming() {
    const current = this.#queue.current;
    if (!current) return;
    const next = this.#queue.loopMode === LoopMode.TRACK
      ? current
      : this.#queue.upcoming()[0];
    if (next) this.#ensureIncomingPrep(next);
  }

  #initMixerPipeline() {
    this.#mixStream = new MixStream();
    this.#mixerResource = null;
    this.#mixerStarted = false;
    this.#mixStream.on('trackend', (info) => {
      if (info?.promoted) {
        this.#onCrossfadePromoted();
        return;
      }
      this.#advanceAfterPlayback();
    });
    this.#mixStream.on('sourceerror', (err) => {
      console.error('[GuildPlayer] mix source error:', err.message);
      this.#hadError = true;
      this.#abortSourceAudioWait();
      this.#mixStream.dropCurrent();
      // Codex review (PR #45, P1): see the audioPlayer 'error' handler's
      // identical comment above — dropCurrent() here has the same silent
      // underrun-state reset.
      this.#stemQ().noteUnderrunCleared(this);
    });
    this.#mixStream.on('incomingerror', (err) => {
      // Mid-fade incoming failure: MixStream already cleared overlap and kept
      // outgoing. Reset arm state so #maybeStartCrossfade can retry, and drop
      // any normalize temp created for the failed incoming leg.
      console.warn('[GuildPlayer] mix incoming error:', err.message);
      this.#crossfadeStarted = false;
      this.#crossfadeTargetTrack = null;
      // §2.3/§8.4: this attempt never reached promotion — a stashed beatmix
      // tempo here belongs to the failed incoming, not whatever eventually
      // does get promoted. Left set, it would wrongly apply to a later,
      // unrelated (possibly non-beatmix) promotion.
      this.#pendingSessionTempo = null;
      this.#pendingIncomingEntrySec = 0;
      this.#cleanupIncomingTempFile().catch((cleanupErr) => {
        console.warn('[GuildPlayer] incoming temp cleanup failed:', cleanupErr.message);
      });
    });
    this.#mixStream.on('snaphandoff', ({ adopt }) => {
      this.#onSnapHandoff(adopt).catch((err) => {
        console.warn('[GuildPlayer] snap handoff failed:', err.message);
      });
    });
    this.#mixStream.on('underrun', () => {
      this.#analysisQ().noteUnderrun(this);
      // Phase 9C §5.4 "Playback Safety": a Demucs job actively running
      // during a live mixer underrun is exactly the CPU pressure the
      // stem-preparation queue's pause() exists to relieve — forward the
      // same underrun signal to it. This is the only automatic trigger for
      // StemQueue.pause(); no separate CPU-monitoring signal exists yet.
      //
      // Codex review (PR #45): routed through noteUnderrun() (debounced —
      // only actually pauses once the underrun has persisted past
      // pauseAfterUnderrunMs), matching the realtime queue's own line
      // above, NOT the immediate pause() command. A raw underrun event can
      // be jittery (several isolated one-frame stalls in quick succession);
      // charging each one straight against pause()'s pauseCount could hit
      // MAX_PAUSES and kill a long-running Demucs job over transient noise
      // the realtime queue itself is built to ignore. pause()/resume()
      // remain available as an explicit, non-debounced command for a
      // future direct/CPU-monitoring trigger — just not this one.
      this.#stemQ().noteUnderrun(this);
    });
    this.#mixStream.on('underrunClear', () => {
      this.#analysisQ().noteUnderrunCleared(this);
      this.#stemQ().noteUnderrunCleared(this);
    });
  }

  #analysisQ() {
    return this.#analysisQueue ?? getAnalysisQueue();
  }

  /** Phase 9C (docs/mix-transition-phase9.md §5): the dedicated StemPreparationQueue — see #stemQueue's own docstring. */
  #stemQ() {
    return this.#stemQueue ?? getStemPreparationQueue();
  }

  async #onSnapHandoff(adopt) {
    // Error path already dropCurrent → #handleAfter; adopting here would
    // advance the queue twice and skip/replace the snapped-in track.
    if (
      this.#hadError
      || this.#handlingAfter
      || this.#crossfadeStarted
      || this.#mixStream?.isCrossfading
    ) return;
    const current = this.#queue.current;
    if (!current) return;
    const next = this.#queue.loopMode === LoopMode.TRACK
      ? current
      : this.#queue.upcoming()[0];
    if (!next || this.#preparedIncoming?.track !== next) return;

    const source = this.#preparedIncoming.source;
    if (!source) return;

    // §2.3/§8.4: prep may have already spawned this source with a beatmix
    // tempo filter baked in (see #ensureIncomingPrep) even though the
    // crossfade itself never armed in time — a natural end-of-stream raced
    // it. Adopting the source without carrying that stretch forward would
    // desync session tempo bookkeeping from what is actually playing.
    // Same tempoHonored check as #maybeStartCrossfade (Codex round-2): if
    // prep fell back to createStreamSource, the prep record still describes
    // the ORIGINALLY-REQUESTED startSec/tempoFilter, not what the source
    // actually does — trusting it here would corrupt duration/tempo
    // bookkeeping the same way an unchecked stash would in the crossfade path.
    const sourceHonorsPlan = source.tempoHonored !== false;
    const promotedTempo = sourceHonorsPlan ? (this.#preparedIncoming.prep?.sessionTempo ?? null) : null;
    const tempoRatio = promotedTempo?.tempoRatio ?? 1;
    // Same native-seek-offset subtraction as #onCrossfadePromoted (Codex
    // round-1 P1) — this source may have been spawned with startSec baked
    // in even though it's being adopted outside a crossfade.
    const entrySec = sourceHonorsPlan ? (this.#preparedIncoming.prep?.startSec ?? 0) : 0;
    const nativeDurationSec = this.#resolvePlaybackDurationSec(next);
    const remainingNativeDurationSec = nativeDurationSec != null
      ? Math.max(0, nativeDurationSec - entrySec)
      : null;
    if (!adopt(source, { durationSec: compensateDurationSec(remainingNativeDurationSec, tempoRatio) })) {
      // Failed adopt (e.g. prefetched decoder already errored): drop the bad
      // prepared entry so trackend / playNext retries a fresh source.
      this.#clearPreparedIncoming();
      await this.#cleanupIncomingTempFile();
      return;
    }

    // Codex review (PR #43): this is a real, committed track handoff that
    // never touches #maybeStartCrossfade()'s own [MIX PLAN] report/log — no
    // candidate evaluation runs on this path (a prepared source simply won
    // the race to EOF), so record it separately or `totalTransitions`
    // undercounts real playback and `selected.gapless` never populates.
    // Codex review (PR #43, round 4): prefer a fresh evaluation of this
    // exact pair over the generic stub, same reasoning as #playNextMixer's
    // own gapless log site.
    const evaluated = this.#takeMatchingEvaluatedTransition(current, next, entrySec);
    if (evaluated) {
      this.#logTransitionPlanFn(evaluated);
    } else {
      this.#logGaplessTransitionFn({ outgoingTrack: current, incomingTrack: next }, { kind: 'snap-handoff' });
    }

    this.#preparedIncoming = null;
    // A stem-mix attempt could have been prepping in parallel with this
    // snap-adopted full-mix source — #clearPreparedIncoming() is what
    // normally piggybacks the stem cleanup onto every abandoned-prep call
    // site, but this path sets #preparedIncoming directly (adopting the
    // source, not discarding it) and would otherwise leave four ffmpeg
    // processes alive for the rest of the adopted track.
    this.#clearPreparedOutgoingStems();
    this.#clearPreparedIncomingStems();
    // Same reasoning as #onCrossfadePromoted()/#handleAfter()'s reset
    // (Codex): a snap-adopted plain source is a THIRD way this (current,
    // next) pair's transition attempt can conclude, alongside those two —
    // an earlier failed stem-mix attempt for this exact pair must not
    // leave it permanently downgraded for a later QUEUE-loop/duplicate
    // recurrence just because THIS occurrence happened to resolve via
    // snap-adoption instead of a crossfade promotion or a natural end.
    this.#stemMixUnavailableKey = null;
    const outgoingTemp = this.#currentTempFile;
    this.#currentTempFile = this.#incomingTempFile;
    this.#incomingTempFile = null;
    this.#currentMeasured = this.#incomingMeasured;
    this.#incomingMeasured = null;

    if (this.#queue.loopMode !== LoopMode.TRACK && this.#queue.current !== next) {
      this.#queue.next({ forceAdvance: true });
    }

    this.#crossfadeStarted = false;
    this.#crossfadeTargetTrack = null;
    // Defensive: this path only runs when no crossfade was in flight (see
    // the guard above), so #pendingSessionTempo should already be null —
    // but never let a stale stash from an earlier aborted attempt leak into
    // a later #onCrossfadePromoted call.
    this.#pendingSessionTempo = null;
    this.#pendingIncomingEntrySec = 0;
    this.#currentEntrySec = entrySec;
    this.#clearCrossfadeArm();
    this.#playbackStart = Date.now();
    this.#lastActiveAt = Date.now();
    this.#playbackCount += 1;
    if (promotedTempo) {
      this.#sessionTempo = promotedTempo;
    } else {
      this.#resetSessionTempoFor(next);
    }
    this.#startCrossfadeArm();
    this.#prefetchUpcoming();
    this.#ensureIncomingPrepForUpcoming();
    this.#recordPlay(this.#queue.current);
    this.#onTrackStart?.(this.#queue.current?.videoId);

    if (outgoingTemp) {
      await cleanupTempFile(outgoingTemp);
    }
  }

  #isMixerStreamDead() {
    return !this.#mixStream
      || this.#mixStream.isDestroyed()
      || this.#mixStream.destroyed;
  }

  #isMixerDead() {
    return this.#isMixerStreamDead() || this.#mixerResource?.ended === true;
  }

  #attachMixerResource() {
    this.#mixerResource = this.#createAudioResource(
      this.#mixStream,
      MIXER_AUDIO_RESOURCE_OPTIONS,
    );
  }

  #inspectSourceAudio(source) {
    if (!source) return 'empty';
    if (source.error) return 'error';
    if ((source.available ?? 0) > 0) return 'ready';
    if (source.ended) return 'empty';
    return null;
  }

  #isSourceAudioWaitSuperseded(track, waited, waitGeneration) {
    return waited === 'aborted'
      || waitGeneration !== this.#pcmWaitGeneration
      || this.#queue.current !== track
      || this.#forceSkip;
  }

  #discardUnusedSource(source) {
    if (!source) return;
    if (this.#mixStream?.currentSource === source) return;
    source.destroy?.();
  }

  #abortSourceAudioWait() {
    this.#pcmWaitGeneration += 1;
    const cancel = this.#cancelSourceAudioWait;
    this.#cancelSourceAudioWait = null;
    cancel?.();
  }

  #waitForSourceAudio(source) {
    this.#cancelSourceAudioWait?.();
    const immediate = this.#inspectSourceAudio(source);
    if (immediate) return Promise.resolve(immediate);
    return new Promise((resolve) => {
      let settled = false;
      const finish = (reason) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        source.off?.('data', onData);
        source.off?.('end', onEnd);
        source.off?.('error', onError);
        if (this.#cancelSourceAudioWait === cancel) {
          this.#cancelSourceAudioWait = null;
        }
        resolve(reason);
      };
      const onData = () => {
        // PcmSource emits `data` on ffmpeg EOF even when available === 0.
        // That wake-up is not buffered audio; keep waiting until end/error
        // or a later chunk actually fills the buffer.
        const result = this.#inspectSourceAudio(source);
        if (result) finish(result);
      };
      const onEnd = () => finish(this.#inspectSourceAudio(source) ?? 'empty');
      const onError = () => finish('error');
      const cancel = () => finish('aborted');
      this.#cancelSourceAudioWait = cancel;
      const timer = setTimeout(() => finish('timeout'), this.#pcmWaitTimeoutMs);
      source.on('data', onData);
      source.on('end', onEnd);
      source.on('error', onError);
    });
  }

  /**
   * @discordjs/voice destroys playStream when leaving Playing. If MixStream was
   * destroyed mid-session, rebuild it so later setCurrent/play can succeed.
   * Never pipeline an empty MixStream into AudioPlayer — that leaves the opus
   * encoder unreadable, and default missed-frames/silence-padding destroy it
   * again before playNext can attach PCM.
   */
  #recoverMixerPlayback({ play = false } = {}) {
    if (this.#isMixerDead()) {
      console.warn('[GuildPlayer] mixer resource ended; rebuilding pipeline');
      try {
        this.#mixStream?.removeAllListeners();
        if (this.#mixStream && !this.#mixStream.destroyed) {
          this.#mixStream.destroy();
        }
      } catch {
        // already destroyed
      }
      this.#initMixerPipeline();
    }
    this.#mixerStarted = false;
    if (play) this.#ensureMixerPlaying();
  }

  #ensureMixerPlaying() {
    if (this.#isMixerStreamDead()) {
      this.#recoverMixerPlayback({ play: false });
    }
    if (this.#isMixerStreamDead()) return;
    const hasSource = Boolean(this.#mixStream.currentSource) || this.#mixStream.isCrossfading;
    if (!this.#mixerResource || this.#mixerResource.ended) {
      if (!hasSource) return;
      this.#attachMixerResource();
    }
    try {
      this.#connection?.subscribe?.(this.#audioPlayer);
      this.#audioPlayer.play(this.#mixerResource);
      this.#mixerStarted = true;
    } catch (err) {
      console.error('[GuildPlayer] mixer play failed, rebuilding:', err.message);
      this.#recoverMixerPlayback({ play: false });
      if (this.#isMixerStreamDead() || !this.#mixStream.currentSource) return;
      this.#attachMixerResource();
      try {
        this.#connection?.subscribe?.(this.#audioPlayer);
        this.#audioPlayer.play(this.#mixerResource);
        this.#mixerStarted = true;
      } catch (err2) {
        console.error('[GuildPlayer] mixer recovery rebuild play failed:', err2.message);
      }
    }
  }

  async #onCrossfadePromoted() {
    this.#forceSkip = false;
    this.#hadError = false;
    this.#clearCrossfadeArm();
    // Codex: #stemMixUnavailableKey scopes a failed stem-mix attempt to the
    // (current, next) pair it happened against — clear it here, once that
    // pairing's transition attempt has actually concluded (this fires for
    // every promotion, stem-mix or not), so a LATER recurrence of the same
    // videoId pair (QUEUE loop mode, a duplicated playlist entry) gets a
    // fresh, unbiased stem-mix attempt instead of staying downgraded for
    // the rest of the GuildPlayer's lifetime over a since-resolved (or
    // simply transient) earlier failure.
    this.#stemMixUnavailableKey = null;

    const target = this.#crossfadeTargetTrack;
    this.#crossfadeTargetTrack = null;

    // Sync queue immediately — MixStream already switched audible audio.
    // Awaiting temp cleanup first would leave skip/error seeing the outgoing
    // track as current and double-advance into the promoted song.
    if (target) {
      if (this.#queue.current !== target) {
        const advanced = this.#queue.next({ forceAdvance: true });
        if (advanced !== target && this.#queue.current !== target) {
          console.warn('[GuildPlayer] crossfade promote queue desync');
        }
      }
    } else {
      this.#queue.next({ forceAdvance: false });
    }

    const outgoingTemp = this.#currentTempFile;
    this.#currentTempFile = this.#incomingTempFile;
    this.#incomingTempFile = null;
    this.#currentMeasured = this.#incomingMeasured;
    this.#incomingMeasured = null;

    const nextTrack = this.#queue.current;
    if (!nextTrack) {
      if (outgoingTemp) await cleanupTempFile(outgoingTemp);
      await this.#disconnect();
      return;
    }

    this.#playbackStart = Date.now();
    this.#lastActiveAt = Date.now();
    this.#playbackCount += 1;
    this.#crossfadeStarted = false;
    // §8.4: a beatmix transition stashed the incoming track's stretched
    // tempo state in #pendingSessionTempo when the crossfade started — carry
    // it forward instead of resetting to native BPM. Any other transition
    // (no stash) resets to the new current track's native BPM, same as
    // before. #resolvePlaybackDurationSec returns native duration; convert
    // to playback-domain by whichever tempo state actually applies.
    const promotedTempo = this.#pendingSessionTempo;
    const promotedEntrySec = this.#pendingIncomingEntrySec;
    this.#pendingSessionTempo = null;
    this.#pendingIncomingEntrySec = 0;
    // This source is now #current — later arm-loop ticks must subtract this
    // from any exit timestamp they compare against positionSec (see
    // #currentEntrySec's own comment).
    this.#currentEntrySec = promotedEntrySec;
    if (promotedTempo) {
      this.#sessionTempo = promotedTempo;
    } else {
      this.#resetSessionTempoFor(nextTrack);
    }
    // The incoming source was seeked forward by promotedEntrySec (native
    // seconds) at spawn — its remaining native content is only
    // (duration - promotedEntrySec), not the full native duration. Convert
    // to playback-domain last, same as everywhere else (Codex round-1 P1).
    const nativeDurationSec = this.#resolvePlaybackDurationSec(nextTrack);
    const remainingNativeDurationSec = nativeDurationSec != null
      ? Math.max(0, nativeDurationSec - promotedEntrySec)
      : null;
    this.#mixStream?.setDurationSec(
      compensateDurationSec(remainingNativeDurationSec, this.#sessionTempo.tempoRatio),
    );
    this.#ensureMixerPlaying();
    this.#startCrossfadeArm();
    this.#prefetchUpcoming();
    this.#ensureIncomingPrepForUpcoming();
    this.#recordPlay(nextTrack);
    this.#onTrackStart?.(nextTrack.videoId);

    if (outgoingTemp) {
      await cleanupTempFile(outgoingTemp);
    }
  }

  get mixStream() {
    return this.#mixStream;
  }

  get positionSec() {
    return this.#mixStream?.positionSec ?? 0;
  }

  get sessionTempo() {
    return this.#sessionTempo;
  }

  /**
   * Phase 9B (docs/mix-transition-phase9.md §4): read-only snapshot of the
   * stem prefetch tracker, for tests/observability. Not consumed by any
   * playback decision — transition mode selection stays exactly what it
   * was (that's Phase 9D's job), this only reports what #prefetchUpcoming()
   * has learned so far about next/next+1's stem-separation progress.
   */
  get stemPrefetchStatus() {
    return this.#stemPrefetchTracker.snapshot();
  }

  #resetSessionTempoFor(track) {
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
    const cached = track?.videoId ? this.#analysisCache.get(track.videoId) : null;
    const nativeBpm = cached ? (cached.headBpm ?? cached.bpm ?? null) : null;
    this.#sessionTempo = resetSessionTempo(nativeBpm);
  }

  #recordPlay(track) {
    if (!this.#recordPlayFn || !track.requestedById) return;
    this.#recordPlayFn({
      guildId: this.#guildId,
      discordUserId: track.requestedById,
      username: track.requestedBy,
      trackTitle: track.title,
      trackUrl: track.webpageUrl,
      videoId: track.videoId,
      channel: track.channel,
    }).catch((err) => {
      console.error('[GuildPlayer] recordPlayFn failed:', err.message);
    });
  }

  pause() {
    if (this.#audioPlayer.pause()) {
      this.#pauseRequested = true;
      return true;
    }
    // AudioPlayer.pause() is a no-op while Idle (PCM still buffering).
    if (this.#cancelSourceAudioWait != null || Boolean(this.#mixStream?.currentSource)) {
      this.#pauseRequested = true;
      return true;
    }
    return false;
  }

  get status() {
    return this.#audioPlayer.state.status;
  }

  resume() {
    if (this.#pauseRequested) {
      this.#pauseRequested = false;
      if (this.#cancelSourceAudioWait) return true;
      if (this.#mixStream?.currentSource) {
        if (!this.#mixerStarted) this.#ensureMixerPlaying();
        else this.#audioPlayer.unpause();
        return true;
      }
      return true;
    }
    return this.#audioPlayer.unpause();
  }

  async skip() {
    this.#forceSkip = true;
    this.#abortSourceAudioWait();
    this.#mixStream?.dropCurrent();
    // Codex review (PR #45, P1): same silent underrun-state reset as the
    // other dropCurrent() call sites — a /skip landing mid-underrun must
    // not leave this player's stem-queue pause source stuck forever.
    this.#stemQ().noteUnderrunCleared(this);
    // Codex review (PR #43, round 10): a skip abandons whatever pair was
    // just evaluated/stashed for the skipped track, same reasoning as
    // stop()'s own clear above — without this, a later recurrence of the
    // same pair within the 30s freshness window (e.g. QUEUE loop) could
    // attribute a stale evaluation to a hard handoff that never actually
    // evaluated it.
    this.#lastEvaluatedTransitionReport = null;
  }

  /**
   * Codex review (PR #45, P1): several normal paths (queue exhaustion with
   * no autoplay handler, a track failing to start, etc.) call the injected
   * #onDisconnect callback directly, without going through stop() first —
   * stop()'s own noteUnderrunCleared()/resume() calls only run when it's
   * actually invoked. Every #onDisconnect() call site in this file goes
   * through this wrapper instead, so a player that disconnects mid-underrun
   * always releases its stem-queue pause source too, not just on an
   * explicit /leave or /stop.
   */
  async #disconnect() {
    this.#stemQ().noteUnderrunCleared(this);
    await this.#onDisconnect();
  }

  async stop() {
    this.#pauseRequested = false;
    this.#queue.clear();
    this.#abortSourceAudioWait();
    this.#clearWatchdog();
    this.#clearCrossfadeArm();
    this.#clearPreparedIncoming();
    this.#queueRefill = null;
    // Codex review (PR #43, round 4/5): an explicit stop must not leave a
    // stashed gapless continuation OR evaluated-plan snapshot around for a
    // later, unrelated playNext() (e.g. a fresh /play in the same session,
    // possibly even the same video-id pair replayed) to pick up.
    this.#pendingGaplessFrom = null;
    this.#lastEvaluatedTransitionReport = null;
    this.#analysisQ().noteUnderrunCleared(this);
    // Symmetric with the underrunClear wiring above (#initMixerPipeline) —
    // release this player's pause source on the stem queue too, so a
    // stopped guild never leaves it stuck paused for other guilds.
    this.#stemQ().resume(this);
    await this.#cleanupCurrentTempFile();
    await this.#cleanupIncomingTempFile();
    this.#discardPrefetch();
    // Ignore Idle from stop()/endMixer so recovery does not fight teardown.
    this.#mixerStarted = false;
    this.#idleRecovering = false;
    try {
      this.#mixStream?.removeAllListeners();
      this.#mixStream?.endMixer();
    } catch {
      // already ended
    }
    this.#audioPlayer.stop();
    // endMixer() permanently closes MixStream. Rebuild so a later playNext()
    // (same session, no /leave) can setCurrent on a live mixer.
    this.#initMixerPipeline();
  }

  #advanceAfterPlayback() {
    if (this.#handlingAfter) {
      // A newly started track can fail while an exhausted-queue continuation
      // is still planning. Preserve that transition so it is handled after
      // the active handoff, but ignore duplicate events from the playback it
      // is already handling. Comparing playback instances (rather than tracks)
      // also preserves an error from a TRACK-loop replay of the same track.
      if (this.#playbackCount !== this.#handlingAfterPlayback) {
        this.#pendingAfter = true;
      }
      return;
    }
    this.#handlingAfter = true;
    this.#drainAfterPlayback()
      .catch(err => {
        console.error('[GuildPlayer] handleAfter error:', err);
      })
      .finally(() => {
        this.#handlingAfter = false;
        this.#handlingAfterPlayback = 0;
      });
  }

  async #drainAfterPlayback() {
    do {
      this.#pendingAfter = false;
      this.#handlingAfterPlayback = this.#playbackCount;
      await this.#handleAfter();
    } while (this.#pendingAfter);
  }

  async #handleAfter() {
    this.#clearCrossfadeArm();
    // Same reasoning as #onCrossfadePromoted()'s reset (Codex): a natural,
    // non-crossfade track end (no fallback was even eligible for the
    // failed pair) must also release the marker once that pair's attempt
    // has concluded, not just the crossfade-promotion path.
    this.#stemMixUnavailableKey = null;
    await this.#cleanupCurrentTempFile();

    const upcomingBeforeAdvance = this.#queue.loopMode === LoopMode.TRACK
      ? this.#queue.current
      : this.#queue.upcoming()[0];
    const preserveIncoming = upcomingBeforeAdvance
      && this.#preparedIncoming?.track === upcomingBeforeAdvance;
    if (!preserveIncoming) {
      this.#clearPreparedIncoming();
      await this.#cleanupIncomingTempFile();
    }

    if (this.#forceSkip) {
      this.#forceSkip = false;
      this.#queue.next({ forceAdvance: true });
      await this.playNext();
      return;
    }

    const elapsed = Date.now() - this.#playbackStart;
    const track = this.#queue.current;

    if (shouldReconnectRetry({ elapsedMs: elapsed, track, hadError: this.#hadError })) {
      await sleep(2000);
      await this.playNext();
      return;
    }

    const finishedTrack = track;
    const shouldForceAdvance = this.#hadError;
    this.#hadError = false;
    const nextTrack = this.#queue.next({ forceAdvance: shouldForceAdvance });
    if (nextTrack === null) {
      // Stop the stall watchdog before handing off: nothing is playing right
      // now either way, and a handler that starts a new track (auto mode) or
      // waits on a user pick (recommend mode) needs a clean slate rather than
      // an interval left ticking against an idle player forever.
      this.#clearWatchdog();
      // Codex review (PR #43, round 3): can't log here — there is no next
      // track yet, and the eventual continuation (if handleQueueExhausted
      // adds one) calls the public playNext() itself, outside this method's
      // call stack. Stash the finished track so that call picks it up (see
      // #pendingGaplessFrom's docstring) and logs only once its source
      // actually starts, same "natural, non-error" guard as the branch below.
      if (!shouldForceAdvance) {
        this.#pendingGaplessFrom = { track: finishedTrack, setAt: Date.now() };
      }
      const handled = await this.#startQueueRefill(finishedTrack);
      // null = another round already owns the autoplay lock; do not disconnect.
      if (handled !== false) return;
      this.#pendingGaplessFrom = null;
      await this.#disconnect();
    } else {
      // Codex review (PR #43): a "hard handoff" — no crossfade was armed AND
      // #onSnapHandoff() either never ran or its prepared source was missing/
      // rejected — still advances the queue to a real next track here, and
      // never touches any of the other two transition-logging call sites.
      // Only the natural case is worth logging: forceSkip/reconnect-retry
      // already returned above, so !shouldForceAdvance means this wasn't an
      // error-forced skip either. Pass it through to playNext() rather than
      // logging here directly (Codex round-3 P2) — the incoming track can
      // still fail to start inside #playNextMixer, and only that method
      // knows once setCurrent() has actually accepted the source.
      await this.playNext(shouldForceAdvance ? null : finishedTrack);
    }
  }

  async #tryHandleQueueExhausted(finishedTrack) {
    if (!this.#handleQueueExhausted) return false;
    // planAutoTrack/planRecommendations await yt-dlp and fetch calls with no
    // timeout of their own; without a bound here, a hang there would leave
    // the player idle forever since the watchdog was already cleared.
    let timeoutHandle;
    const timeout = new Promise((_, reject) => {
      timeoutHandle = setTimeout(
        () => reject(new Error('handleQueueExhausted timed out')),
        this.#queueExhaustedTimeoutMs
      );
    });
    try {
      return await Promise.race([this.#handleQueueExhausted(finishedTrack), timeout]);
    } catch (err) {
      console.error('[GuildPlayer] handleQueueExhausted error:', err);
      return false;
    } finally {
      clearTimeout(timeoutHandle);
    }
  }

  async #createPcmSource(track, { forIncoming = false, prepId = null, startSec = 0, tempoFilter = null } = {}) {
    if (this.#createPcmSourceFn) {
      return this.#createPcmSourceFn(track, { forIncoming, startSec, tempoFilter });
    }

    if (!forIncoming) {
      this.#currentTempFile = null;
      this.#currentMeasured = null;
    }

    // Mixer path forces normalize when duration allows (crossfade quality).
    if (!isNormalizeDurationAllowed(track)) {
      if (!forIncoming) this.#discardPrefetch();
      // Live/untrimmed stream — do not keep a prior trimmed duration.
      if (track.videoId) this.#probedDurationCache.delete(track.videoId);
      // §9.3: createStreamSource has no startSec/tempoFilter support at all —
      // mark the source so a caller that requested either doesn't stash
      // beatmix bookkeeping (session tempo, entry offset) for audio that is
      // actually playing from native position 0 at native tempo.
      const source = createStreamSource(track, { resolveAudioStreamFn: this.#resolveAudioStream });
      source.tempoHonored = false;
      return source;
    }

    try {
      const prefetched = await this.#getPrefetchedOrFetch(track);
      const probedDuration = await probeDurationSec(prefetched.filePath).catch(() => null);
      if (track.videoId && probedDuration != null) {
        this.#probedDurationCache.set(track.videoId, probedDuration);
        this.#maybeApplyAnalysisDuration(track, { durationSec: probedDuration });
      }
      console.info(
        `[normalize] applying: ${track.title} ` +
        `(${prefetched.measured.measured_I} LUFS -> -16 LUFS)`
      );
      if (forIncoming) {
        if (prepId != null && prepId !== this.#incomingPrepId) {
          cleanupTempFile(prefetched.filePath).catch((err) => {
            console.error('[GuildPlayer] abandoned incoming temp cleanup error:', err);
          });
          // Do not schedule analysis or open a FileSource on a temp we are
          // deleting — callers treat rejection as a cancelled/failed prep.
          const cancelErr = new Error('incoming prep cancelled');
          cancelErr.code = 'INCOMING_PREP_CANCELLED';
          throw cancelErr;
        }
        this.#incomingTempFile = prefetched.filePath;
        this.#incomingMeasured = prefetched.measured;
      } else {
        this.#currentTempFile = prefetched.filePath;
        this.#currentMeasured = prefetched.measured;
      }
      this.#scheduleAnalysis(track, prefetched.filePath);
      const source = createFileSource(prefetched.filePath, { measured: prefetched.measured, startSec, tempoFilter });
      source.tempoHonored = true;
      return source;
    } catch (err) {
      if (err?.code === 'INCOMING_PREP_CANCELLED') throw err;
      console.warn(`[GuildPlayer] normalize fallback for ${track.title}:`, err.message);
      if (track.videoId) this.#probedDurationCache.delete(track.videoId);
      const source = createStreamSource(track, { resolveAudioStreamFn: this.#resolveAudioStream });
      source.tempoHonored = false;
      return source;
    }
  }

  #scheduleAnalysis(track, filePath) {
    if (!track?.videoId || !filePath || !this.#analyzeTrackFileFn) return;
    // Codex (PR #39 round-15/16): #ensureFullPrefetch() and
    // #createPcmSource() both call #scheduleAnalysis() for the same
    // prefetched file — the second, consuming that same prefetch entry
    // once the track actually starts — so without this guard every
    // normalized track gets staged and enqueued for stem separation
    // twice. Skip while a prior attempt for this exact videoId is still
    // in flight; that first attempt already populates the in-memory and
    // persistent analysis/stem caches everything else reads from, so a
    // second is pure waste. The token (not just videoId presence) guards
    // against a killed job's delayed cleanup clobbering a newer job's
    // entry — see #scheduledAnalysisTokens's own docstring.
    if (this.#scheduledAnalysisTokens.has(track.videoId)) return;
    const analysisToken = {};
    this.#scheduledAnalysisTokens.set(track.videoId, analysisToken);
    // Phase 8 (Codex, PR #39 round-14): stage an independent copy of
    // filePath for stem separation NOW, before this job is even enqueued —
    // several unrelated call sites (track promotion/stop/skip/prefetch
    // discard) can delete filePath at any point once this method returns,
    // including the entire time this job sits waiting its turn on a shared
    // queue (which a single full-track Demucs job can occupy for minutes —
    // docs/mix-transition-phase8.md §9, mitigated but not eliminated by
    // Phase 9C's queue split below). Copying later, e.g. as the first
    // statement inside the enqueued callback, would already be too late in
    // exactly that scenario. Best-effort: if staging fails, separation for
    // this track is simply skipped below.
    const stagedPathPromise = this.#stageTempFileCopyFn(filePath).catch((err) => {
      console.warn('[GuildPlayer] failed to stage file for stem separation:', err.message);
      return null;
    });

    // Phase 9C (docs/mix-transition-phase9.md §5): releases
    // #scheduledAnalysisTokens's dedup guard and cleans up the staged
    // copy. Whichever branch below actually owns the staged file's
    // lifetime for this attempt — "no separation dispatched" (aborted, or
    // staging itself failed) vs. "separation dispatched on the stem
    // queue" — calls this exactly once, so the guard/cleanup logic isn't
    // duplicated per branch. Same compare-and-delete rationale as before
    // the split (Codex): analysisQueue.kill()/noteUnderrun() rejects via
    // Promise.race() the instant a job is killed, possibly before this
    // ever runs; if a newer attempt for this videoId already replaced the
    // token in that gap, leave it alone.
    const finishAnalysisAttempt = (stagedPath) => {
      if (stagedPath) cleanupTempFile(stagedPath).catch(() => {});
      if (this.#scheduledAnalysisTokens.get(track.videoId) === analysisToken) {
        this.#scheduledAnalysisTokens.delete(track.videoId);
      }
    };

    this.#analysisQ().enqueue(async ({ spawnNice, signal } = {}) => {
      // CodeRabbit (PR #39 round-15): the staged copy must be cleaned up
      // whether analysis succeeds, fails at any step, or is cancelled —
      // #lookupPersistentAnalysis()/#runAnalysis() rejecting (including an
      // ANALYSIS_KILLED abort) must not skip cleanup. The try/catch below
      // routes every exit path through finishAnalysisAttempt() exactly
      // once (either here, on failure/no-dispatch, or later inside the
      // stem-queue job's own .finally() once separation settles).
      //
      // Codex (PR #39 round-17): #runAnalysis() itself must also read from
      // the staged copy, not the original filePath — the whole reason
      // filePath got staged in the first place is that it can be deleted
      // by unrelated cleanup at any point once this job is enqueued,
      // #runAnalysis() is just as exposed to that as separation was.
      // Awaited once up front (already-settled by the time this callback
      // runs, in the overwhelming majority of cases) so both steps below
      // share the same value; falls back to filePath only if staging
      // itself failed, matching this job's existing best-effort posture.
      const stagedPath = await stagedPathPromise;
      try {
        const cached = await this.#lookupPersistentAnalysis(track);
        const analysis = cached ?? await this.#runAnalysis(track, stagedPath ?? filePath, { spawnFn: spawnNice, signal });
        // Best-effort: a failure here just means this track never becomes
        // stem-mix eligible, the existing beatmix/phrase-crossfade/legacy
        // ladder is untouched either way.
        // Skip rather than start a many-minute Demucs run against a job
        // the (realtime) queue already decided to cancel (e.g. a mixer
        // underrun killed this job right as #runAnalysis finished).
        if (!signal?.aborted && stagedPath) {
          // Phase 9C (docs/mix-transition-phase9.md §5): dispatch the
          // heavy full-track Demucs step on the dedicated
          // StemPreparationQueue instead of this (realtime) queue —
          // deliberately NOT awaited here. Awaiting would keep this
          // realtime job "running" for as long as Demucs takes, blocking
          // BPM/downbeat/phrase/key/vocal-activity analysis for the next
          // queued track behind it — exactly the §9 problem this phase
          // fixes. The stem job's own .finally() below owns
          // cleanup/token-release for this attempt once separation
          // actually settles; this realtime job returns immediately.
          // Codex review (PR #45, P1): give this a real priority instead of
          // implicit call-order-only FIFO — B (HIGH, tracked by
          // #stemPrefetchTracker) must not sit behind an already-pending
          // LOW (C) job. A (the currently-playing track, untracked here —
          // §4.2 deliberately keeps A outside #stemPrefetchTracker) stays
          // at the default 'normal' priority, unchanged from pre-9C
          // behavior.
          const stemJobPriority = this.#stemPrefetchTracker.get(track.videoId)?.priority === StemPrefetchPriority.HIGH
            ? 'high'
            : 'normal';
          // Codex review (PR #45, P2, round 2): retry directly from THIS
          // staged copy instead of re-staging from `filePath` via a fresh
          // #scheduleAnalysis(track, filePath) call — by the time a
          // stem-queue-level kill happens, `filePath` (the original
          // normalized file) may already be gone via track promotion/end
          // cleanup, since the split stem queue can now hold this job
          // independently for minutes. `runSeparation` is recursive so the
          // one retry it allows reuses the exact same still-on-disk staged
          // file rather than depending on anything that could have been
          // cleaned up in between. Cleanup of `stagedPath` and release of
          // this attempt's #scheduledAnalysisTokens entry are decoupled:
          // the former only happens once every attempt (original + at most
          // one retry) has truly settled, the latter happens exactly once
          // regardless of how many attempts ran.
          // Codex review (PR #45, P2, round 3): stemCache.js's default
          // separateTrackStems() dedups per-videoId via its own module-level
          // `inFlight` Map, cleared only once that specific call's own
          // promise settles — the stem queue's kill only rejects the OUTER
          // race in analysisQueue.js's pump(), it does not cancel or clear
          // this inner call. `currentAttemptSeparation` captures that inner
          // promise so a retry can await it settling (swallowing whatever
          // it resolves/rejects to — it's about to be discarded either way)
          // before dispatching the replacement attempt; otherwise
          // separateTrackStems()'s own dedup check would just hand the
          // retry back this same doomed (killed → resolves null) promise,
          // silently burning the one retry for nothing.
          let currentAttemptSeparation = null;
          const runSeparation = (allowRetry) => this.#stemQ().enqueue(async ({ spawnNice: stemSpawnNice, signal: stemSignal } = {}) => {
            if (stemSignal?.aborted) return null;
            currentAttemptSeparation = this.#separateTrackStemsFn(stagedPath, track.videoId, { spawnFn: stemSpawnNice, signal: stemSignal });
            return currentAttemptSeparation;
          }, { priority: stemJobPriority }).then(
            (stems) => {
              // Phase 9B: this is the one place that actually learns when a
              // HIGH-priority (B) stem prefetch finishes — #ensureStemPrefetch()
              // itself only re-polls getCachedStemsFn() on the NEXT
              // #prefetchUpcoming() checkpoint, which for B may not come
              // again before it becomes the current track and drops out of
              // that method's purview entirely. Only touches the tracker if
              // this videoId is actually being tracked (#ensureStemPrefetch()
              // was called for it) — #scheduleAnalysis() runs for every
              // normalized track, current (A) included, and A must stay
              // untouched by this (§4.2: 9B doesn't change #ensureOutgoingStemPrep()'s
              // existing treatment of A).
              if (this.#stemPrefetchTracker.get(track.videoId)) {
                if (stems) this.#stemPrefetchTracker.markReady(track.videoId);
                else this.#stemPrefetchTracker.markFailed(track.videoId);
              }
            },
            (err) => {
              console.warn('[GuildPlayer] stem separation failed:', err.message);
              if (this.#stemPrefetchTracker.get(track.videoId)) {
                this.#stemPrefetchTracker.markFailed(track.videoId);
              }
              // Codex review (PR #45, P2): a stem-queue-level ANALYSIS_KILLED
              // (this queue's own pause/kill machinery preempting the job,
              // e.g. maxPauses exceeded during a sustained underrun) rejects
              // here, one level below the realtime #analysisQ() job that
              // dispatched it — that job already resolved by the time this
              // rejects (the dispatch above is deliberately not awaited), so
              // the outer .catch()'s own ANALYSIS_KILLED retry (below) is
              // never reached for this kind of kill. Same bounded-once-per-
              // videoId retry as that outer catch.
              if (
                allowRetry
                && err?.code === 'ANALYSIS_KILLED'
                && this.#stemPrefetchTracker.get(track.videoId)
                && !this.#stemPrefetchRetriedAfterKill.has(track.videoId)
              ) {
                this.#stemPrefetchRetriedAfterKill.add(track.videoId);
                return (currentAttemptSeparation ?? Promise.resolve()).catch(() => {}).then(() => runSeparation(false));
              }
            },
          );
          runSeparation(true).finally(() => finishAnalysisAttempt(stagedPath));
          return analysis;
        } else if (this.#stemPrefetchTracker.get(track.videoId)) {
          // Codex review (PR #44, carried into Phase 9C's stem-queue
          // restructure): staging failed (stagedPath null), or this job
          // was aborted before separation was even attempted — either way
          // it's exiting without ever reaching the stem-queue dispatch
          // above, so the markReady/markFailed pair there never runs. Mark
          // it failed here instead of leaving the tracked entry stuck
          // reporting PROCESSING forever (prune() deliberately never
          // collects a PROCESSING/QUEUED entry) — a later
          // #prefetchUpcoming() checkpoint will retry it.
          this.#stemPrefetchTracker.markFailed(track.videoId);
        }
        finishAnalysisAttempt(stagedPath);
        return analysis;
      } catch (err) {
        finishAnalysisAttempt(stagedPath);
        throw err;
      }
    }).catch((err) => {
      // Belt-and-suspenders: the finally above already removes this on
      // every path through the callback body. This only matters if
      // enqueue() itself rejects without ever invoking that callback.
      if (this.#scheduledAnalysisTokens.get(track.videoId) === analysisToken) {
        this.#scheduledAnalysisTokens.delete(track.videoId);
      }
      // Codex review (PR #44): #lookupPersistentAnalysis()/#runAnalysis()
      // throwing (including an ANALYSIS_KILLED abort) before ever reaching
      // the separation step above means neither markReady/markFailed branch
      // there ran either — same "don't leave it stuck at PROCESSING
      // forever" reasoning.
      const tracked = this.#stemPrefetchTracker.get(track.videoId);
      if (tracked) {
        this.#stemPrefetchTracker.markFailed(track.videoId);
      }
      if (err?.code === 'ANALYSIS_KILLED') {
        console.warn('[GuildPlayer] analysis yielded to mixer:', err.message);
        // Codex review (PR #44, P2): specifically an ANALYSIS_KILLED abort
        // (a real-time-pressure preemption, e.g. a mixer underrun stopping
        // this job mid-run) is the transient case worth retrying — unlike
        // separateTrackStemsFn() resolving a clean `null` (a genuine "this
        // track has no separable stems" outcome the existing Phase 8 tests
        // rely on staying a one-shot attempt), a kill says nothing about
        // whether the track is actually separable. filePath is still the
        // one this call was given, not a staged copy — the file this HIGH
        // track's full-prefetch download resolved to, still present since
        // it hasn't been promoted/consumed yet. Retried at most once per
        // videoId (#stemPrefetchRetriedAfterKill) to avoid looping forever
        // against a guild that's continuously CPU-starved.
        if (tracked && !this.#stemPrefetchRetriedAfterKill.has(track.videoId)) {
          this.#stemPrefetchRetriedAfterKill.add(track.videoId);
          this.#scheduleAnalysis(track, filePath);
        }
        return;
      }
      console.warn('[GuildPlayer] analysis failed:', err.message);
    });
  }

  async #lookupPersistentAnalysis(track) {
    if (!track?.videoId) return null;
    if (this.#analysisCache.has(track.videoId)) {
      const cached = this.#analysisCache.get(track.videoId);
      this.#maybeApplyAnalysisDuration(track, cached);
      return cached;
    }
    if (!this.#getTrackAnalysisFn) return null;
    const cached = await this.#getTrackAnalysisFn(track.videoId);
    if (cached && (cached.version ?? 1) >= ANALYSIS_VERSION) {
      this.#analysisMissAt.delete(track.videoId);
      this.#analysisCache.set(track.videoId, cached);
      this.#maybeApplyAnalysisDuration(track, cached);
      return cached;
    }
    return null;
  }

  async #getCachedAnalysis(track) {
    if (!track) return null;
    if (track.videoId && this.#analysisCache.has(track.videoId)) {
      const cached = this.#analysisCache.get(track.videoId);
      this.#maybeApplyAnalysisDuration(track, cached);
      return cached;
    }
    if (track.videoId && this.#getTrackAnalysisFn) {
      const missedAt = this.#analysisMissAt.get(track.videoId);
      if (missedAt != null && Date.now() - missedAt < ANALYSIS_MISS_BACKOFF_MS) {
        return null;
      }
      const cached = await this.#getTrackAnalysisFn(track.videoId);
      if (cached && (cached.version ?? 1) >= ANALYSIS_VERSION) {
        this.#analysisMissAt.delete(track.videoId);
        this.#analysisCache.set(track.videoId, cached);
        this.#maybeApplyAnalysisDuration(track, cached);
        return cached;
      }
      this.#analysisMissAt.set(track.videoId, Date.now());
    }
    return null;
  }

  async #runAnalysis(track, filePath, { spawnFn, signal, durationSec } = {}) {
    throwIfAborted(signal);
    if (!filePath || !this.#analyzeTrackFileFn) return null;
    const probedDuration = durationSec
      ?? (track.videoId ? this.#probedDurationCache.get(track.videoId) : null)
      ?? null;
    const analysis = await this.#analyzeTrackFileFn(filePath, {
      videoId: track.videoId,
      durationSec: probedDuration,
      spawnFn,
      signal,
    });
    throwIfAborted(signal);
    if (!analysis) return null;
    if (track.videoId) {
      this.#analysisCache.set(track.videoId, analysis);
      this.#putTrackAnalysisFn?.(track.videoId, analysis);
      if (analysis.durationSec != null) {
        this.#probedDurationCache.set(track.videoId, analysis.durationSec);
      }
    }
    this.#maybeApplyAnalysisDuration(track, analysis);
    return analysis;
  }

  async #resolveAnalysis(track, filePath = null) {
    const cached = await this.#getCachedAnalysis(track);
    if (cached) return cached;
    if (!filePath) return null;
    return this.#runAnalysis(track, filePath);
  }

  #maybeApplyAnalysisDuration(track, analysis) {
    if (this.#queue.current !== track) return;
    if (analysis?.durationSec && this.#mixStream?.remainingSec == null) {
      // §8.4: if this track was itself promoted via a beatmix, #sessionTempo
      // already carries its stretched tempoRatio (see #onCrossfadePromoted) —
      // native analysis duration must convert to playback-domain before
      // feeding setDurationSec, the same conversion promotion itself applies.
      // A no-op (ratio 1) for the common non-stretched case.
      this.#mixStream.setDurationSec(compensateDurationSec(analysis.durationSec, this.#sessionTempo.tempoRatio));
    }
    // Phase 7 §8.4: the fast-path #analysisCache read in #resetSessionTempoFor
    // usually misses (analysis isn't scheduled/fetched until after a track
    // becomes current) — this is the shared arrival point for all three ways
    // analysis reaches the current track (persisted lookup, in-memory cache
    // hit, freshly completed #runAnalysis), so it is where nativeBpm actually
    // gets backfilled once known.
    if (analysis?.bpm != null && this.#sessionTempo.nativeBpm == null) {
      // Same headBpm preference as #resetSessionTempoFor, for the same reason.
      this.#sessionTempo = resetSessionTempo(analysis.headBpm ?? analysis.bpm);
    }
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
      nativeBpm: this.#sessionTempo.nativeBpm,
      targetBpm: this.#sessionTempo.playbackBpm,
      backend: tempoBackend,
    });
    // buildTempoFilter() returns { filter: null } both when no stretch is
    // needed AND when a needed stretch couldn't be expressed (nativeBpm
    // missing, deviation past the backend's limit) — those two cases must
    // not collapse into the same "spawn unstretched" result here: the
    // second one would silently decode the outgoing stems at native tempo
    // while #current keeps playing stretched, drifting apart for the whole
    // stem window. undefined signals "stem-mix unavailable" to callers.
    const ratio = this.#sessionTempo.tempoRatio ?? 1;
    if (built.filter == null && Math.abs(ratio - 1) > 1e-9) return undefined;
    return built.filter;
  }

  /**
   * Phase 8 (docs/mix-transition-phase8.md): the outgoing side's stem pair
   * must be spawned LATE — seeked to the exit point — from inside
   * #maybeStartCrossfade()'s own prepDue gate, never at track-promotion
   * time. A PcmSource opened at startSec:0 and left unread for however long
   * the track has left to play would just sit blocked on backpressure at
   * the wrong native position by the time it's actually needed.
   */
  async #ensureOutgoingStemPrep(cached, videoId, { startSec = 0, tempoFilter = null } = {}) {
    // Loudnorm the stems with the same measured LUFS #current's own full-mix
    // source used — otherwise the stem window jumps to unfiltered loudness
    // relative to the surrounding, already-normalized audio. Included in the
    // identity check (not just videoId/startSec/tempoFilter): if this fires
    // before #currentMeasured is populated, an unmeasured pair gets prepped;
    // without this, a later tick that finally sees the real value would
    // treat the existing prep as still valid and never re-spawn with it.
    const measured = this.#currentMeasured;
    if (
      this.#preparedOutgoingStems?.videoId === videoId
      && this.#preparedOutgoingStems.prep?.startSec === startSec
      && this.#preparedOutgoingStems.prep?.tempoFilter === tempoFilter
      && this.#preparedOutgoingStems.prep?.measured === measured
    ) return;
    // Dedup concurrent in-flight attempts for the SAME identity — the cache
    // revalidation below is async, and the 200ms arm interval can call this
    // again before it resolves. Without this, every such tick spawns its
    // own independent ffmpeg pair; whichever's await happens to resolve
    // last silently wins even if it started before another, and a
    // completion that lands after the pair has already been taken (or
    // cleared) installs an orphaned pair whose paused processes never get
    // destroyed (Codex).
    const key = `${videoId}:${startSec}:${tempoFilter}:${measured}`;
    if (this.#preparingOutgoingStemsKey === key) return;
    this.#preparingOutgoingStemsKey = key;
    try {
      // Revalidate against the live cache right before actually spawning —
      // this only runs on a genuine (re)prep, i.e. rarely, not on the
      // steady-state no-op ticks above, so it doesn't reintroduce the
      // per-tick fs cost player.js's #outStemCacheHit/#inStemCacheHit memo exists to avoid.
      // `cached` (the caller's argument) may be a memoized lookup from
      // several arm-ticks ago; pruneStemCache() can evict the entry any
      // time in the background, and a stale path here would spawn ffmpeg
      // against a deleted file, silently failing prep forever for this
      // pair as long as the memo key doesn't change (Codex).
      const fresh = await this.#getCachedStemsFn(videoId);
      // A newer call (different identity) or an explicit clear (stop, plan
      // downgrade, ...) superseded this attempt while it awaited — the
      // caller no longer wants this result; do not install it.
      if (this.#preparingOutgoingStemsKey !== key) return;
      if (!fresh) {
        this.#clearPreparedOutgoingStems();
        return;
      }
      const vocal = this.#createFileSourceFn(fresh.vocalPath, { startSec, tempoFilter, measured });
      const instrumental = this.#createFileSourceFn(fresh.instrumentalPath, { startSec, tempoFilter, measured });
      this.#clearPreparedOutgoingStems();
      this.#preparedOutgoingStems = { videoId, prep: { startSec, tempoFilter, measured }, vocal, instrumental };
    } finally {
      // Always release the in-flight marker for THIS attempt, including on
      // a rejected getCachedStemsFn() — otherwise a transient cache-read
      // error leaves the key stuck forever, and every later tick for this
      // same identity hits the dedup no-op above, permanently disabling
      // stem prep for the rest of the transition even if a later read
      // would have succeeded (CodeRabbit). Only clear it if it's still
      // OURS — a newer call already replacing it with its own key must
      // keep that key, not have it wiped out from under it.
      if (this.#preparingOutgoingStemsKey === key) this.#preparingOutgoingStemsKey = null;
    }
  }

  #takePreparedOutgoingStems(videoId, { startSec = 0, tempoFilter = null } = {}) {
    if (
      this.#preparedOutgoingStems?.videoId === videoId
      && this.#preparedOutgoingStems.prep?.startSec === startSec
      && this.#preparedOutgoingStems.prep?.tempoFilter === tempoFilter
      // #currentMeasured can still change between the prepDue tick that
      // prepped these stems and this take — e.g. normalization for the
      // OTHER side resolving in the same arm pass shouldn't matter here,
      // but a stale unmeasured pair must not silently win over a since-
      // populated value (CodeRabbit, follow-up to the ensure-side fix).
      && this.#preparedOutgoingStems.prep?.measured === this.#currentMeasured
    ) {
      const { vocal, instrumental } = this.#preparedOutgoingStems;
      this.#preparedOutgoingStems = null;
      return { vocal, instrumental };
    }
    this.#clearPreparedOutgoingStems();
    return null;
  }

  #clearPreparedOutgoingStems() {
    this.#preparedOutgoingStems?.vocal?.destroy?.();
    this.#preparedOutgoingStems?.instrumental?.destroy?.();
    this.#preparedOutgoingStems = null;
    // Invalidate any in-flight #ensureOutgoingStemPrep() attempt too — a
    // completion for a pair the caller just explicitly discarded must not
    // be allowed to silently reinstall one once its await resolves.
    this.#preparingOutgoingStemsKey = null;
  }

  /**
   * Incoming-side stem pair — same late-binding rationale as
   * #ensureOutgoingStemPrep(). The incoming side's FULL-mix continuation
   * source (needed once the stem window ends) is NOT prepared here — that
   * still goes through the existing #ensureIncomingPrep()/
   * #takePreparedIncoming() machinery (download/normalize/analysis-
   * scheduling already lives there; no need to duplicate it), spawned with
   * the SAME startSec/tempoFilter so all three incoming sources decode in
   * lockstep (see mixStream.js's startStemCrossfade() docstring).
   */
  async #ensureIncomingStemPrep(cached, videoId, { startSec = 0, tempoFilter = null } = {}) {
    // Same rationale as #ensureOutgoingStemPrep() — reuse whichever measured
    // value the incoming full-mix prep has captured for this track so far,
    // and include it in the identity check so a later tick that sees
    // #incomingMeasured finally populated (a slow download/prefetch can
    // still be resolving the first time this fires) re-preps with it
    // instead of permanently keeping an unmeasured pair.
    const measured = this.#incomingMeasured;
    if (
      this.#preparedIncomingStems?.videoId === videoId
      && this.#preparedIncomingStems.prep?.startSec === startSec
      && this.#preparedIncomingStems.prep?.tempoFilter === tempoFilter
      && this.#preparedIncomingStems.prep?.measured === measured
    ) return;
    // Dedup concurrent in-flight attempts — see #ensureOutgoingStemPrep()'s
    // matching comment (Codex).
    const key = `${videoId}:${startSec}:${tempoFilter}:${measured}`;
    if (this.#preparingIncomingStemsKey === key) return;
    this.#preparingIncomingStemsKey = key;
    try {
      // Revalidate against the live cache right before actually spawning —
      // see #ensureOutgoingStemPrep()'s matching comment (Codex).
      const fresh = await this.#getCachedStemsFn(videoId);
      if (this.#preparingIncomingStemsKey !== key) return;
      if (!fresh) {
        this.#clearPreparedIncomingStems();
        return;
      }
      const vocal = this.#createFileSourceFn(fresh.vocalPath, { startSec, tempoFilter, measured });
      const instrumental = this.#createFileSourceFn(fresh.instrumentalPath, { startSec, tempoFilter, measured });
      this.#clearPreparedIncomingStems();
      this.#preparedIncomingStems = { videoId, prep: { startSec, tempoFilter, measured }, vocal, instrumental };
    } finally {
      // Always release the in-flight marker for THIS attempt — see
      // #ensureOutgoingStemPrep()'s matching comment (CodeRabbit).
      if (this.#preparingIncomingStemsKey === key) this.#preparingIncomingStemsKey = null;
    }
  }

  #takePreparedIncomingStems(videoId, { startSec = 0, tempoFilter = null } = {}) {
    if (
      this.#preparedIncomingStems?.videoId === videoId
      && this.#preparedIncomingStems.prep?.startSec === startSec
      && this.#preparedIncomingStems.prep?.tempoFilter === tempoFilter
      // #takePreparedIncoming() (the full-mix side) can resolve normalization
      // and populate #incomingMeasured within the SAME arm pass, after these
      // stems were already prepped unmeasured — without this check the stale
      // unmeasured pair would win over the full-mix source's now-measured
      // loudness (CodeRabbit, follow-up to the ensure-side fix).
      && this.#preparedIncomingStems.prep?.measured === this.#incomingMeasured
    ) {
      const { vocal, instrumental } = this.#preparedIncomingStems;
      this.#preparedIncomingStems = null;
      return { vocal, instrumental };
    }
    this.#clearPreparedIncomingStems();
    return null;
  }

  #clearPreparedIncomingStems() {
    this.#preparedIncomingStems?.vocal?.destroy?.();
    this.#preparedIncomingStems?.instrumental?.destroy?.();
    this.#preparedIncomingStems = null;
    // Invalidate any in-flight #ensureIncomingStemPrep() attempt too — see
    // #clearPreparedOutgoingStems()'s matching comment.
    this.#preparingIncomingStemsKey = null;
  }

  /** Destroys a prepared entry's source, resolved or still in flight. */
  #destroyPreparedSource(entry) {
    if (!entry) return;
    if (entry.source) {
      entry.source.destroy?.();
    } else if (entry.promise) {
      entry.promise.then((resolved) => {
        resolved?.destroy?.();
      }).catch(() => {});
    }
  }

  #clearPreparedIncoming() {
    // Invalidate in-flight createPcmSource so it won't assign #incomingTempFile
    // after cancel (stop / skip / replace prep / playNextMixer).
    this.#incomingPrepId += 1;
    // Phase 8: a prepared stem pair is only ever prepped alongside an
    // attempted stem-mix transition's full-mix incoming prep — piggyback on
    // every existing call site that abandons the latter rather than
    // duplicating them.
    this.#clearPreparedOutgoingStems();
    this.#clearPreparedIncomingStems();
    if (!this.#preparedIncoming) return;
    const pending = this.#preparedIncoming;
    this.#preparedIncoming = null;
    this.#destroyPreparedSource(pending);
    const filePath = this.#incomingTempFile;
    this.#incomingTempFile = null;
    this.#incomingMeasured = null;
    if (filePath) {
      cleanupTempFile(filePath).catch((err) => {
        console.error('[GuildPlayer] prepared incoming temp cleanup error:', err);
      });
    }
  }

  /**
   * Phase 7D: dedup key includes startSec/tempoFilter, not just the track —
   * an earlier no-op prep (called eagerly on track start, before any
   * transition plan exists — see #ensureIncomingPrepForUpcoming) must be
   * torn down and re-spawned once a real beatmix/phrase-crossfade entry
   * point is known, or the incoming source plays from its native start at
   * native tempo regardless of what the plan decided.
   */
  #ensureIncomingPrep(next, { startSec = 0, tempoFilter = null, sessionTempo = null } = {}) {
    if (
      this.#preparedIncoming?.track === next
      && this.#preparedIncoming.prep?.startSec === startSec
      && this.#preparedIncoming.prep?.tempoFilter === tempoFilter
    ) return;

    const entry = { track: next, source: null, promise: null, prep: { startSec, tempoFilter, sessionTempo } };

    // Reuse the already-downloaded/normalized file for the SAME track when
    // only startSec/tempoFilter changed (e.g. a beatmix plan replacing the
    // eager default prep) — #clearPreparedIncoming() below would otherwise
    // delete #incomingTempFile, and #getPrefetchedOrFetch() consumes (and
    // deletes) its prefetch map entry on first use, so a full #createPcmSource
    // re-run would re-download + re-normalize a file already on disk.
    if (
      this.#preparedIncoming?.track === next
      && this.#incomingTempFile != null
      && this.#incomingMeasured != null
    ) {
      this.#destroyPreparedSource(this.#preparedIncoming);
      const source = createFileSource(this.#incomingTempFile, {
        measured: this.#incomingMeasured,
        startSec,
        tempoFilter,
      });
      source.tempoHonored = true;
      entry.source = source;
      entry.promise = Promise.resolve(source);
      this.#preparedIncoming = entry;
      return;
    }

    this.#clearPreparedIncoming();
    const prepId = this.#incomingPrepId;
    entry.promise = this.#createPcmSource(next, { forIncoming: true, prepId, startSec, tempoFilter })
      .then((resolved) => {
        if (this.#preparedIncoming === entry) {
          entry.source = resolved;
        }
        return resolved;
      })
      .catch((err) => {
        if (this.#preparedIncoming === entry) {
          this.#preparedIncoming = null;
        }
        throw err;
      });
    this.#preparedIncoming = entry;
  }

  async #takePreparedIncoming(next, { forPlayback = false, startSec = 0, tempoFilter = null } = {}) {
    if (
      this.#preparedIncoming?.track === next
      && this.#preparedIncoming.prep?.startSec === startSec
      && this.#preparedIncoming.prep?.tempoFilter === tempoFilter
    ) {
      const pending = this.#preparedIncoming;
      this.#preparedIncoming = null;
      const source = pending.source ?? await pending.promise;
      if (forPlayback && this.#incomingTempFile) {
        this.#currentTempFile = this.#incomingTempFile;
        this.#incomingTempFile = null;
        this.#currentMeasured = this.#incomingMeasured;
        this.#incomingMeasured = null;
      }
      return source;
    }
    // Mismatched prep (e.g. #playNextMixer's cold-start default request
    // reusing a track that was mid-prep as a beatmix incoming target with a
    // different startSec/tempoFilter, or a skip racing #handleAfter) — never
    // silently hand back a spawn configured for a different plan.
    if (this.#preparedIncoming?.track === next) {
      this.#clearPreparedIncoming();
    }
    const prepId = this.#incomingPrepId;
    return this.#createPcmSource(next, { forIncoming: !forPlayback, prepId, startSec, tempoFilter });
  }

  #startCrossfadeArm() {
    this.#clearCrossfadeArm();
    this.#crossfadeArmTimer = setInterval(() => {
      this.#maybeStartCrossfade().catch((err) => {
        console.error('[GuildPlayer] crossfade arm error:', err.message);
      });
    }, CROSSFADE_ARM_INTERVAL_MS);
  }

  #clearCrossfadeArm() {
    if (this.#crossfadeArmTimer != null) {
      clearInterval(this.#crossfadeArmTimer);
      this.#crossfadeArmTimer = null;
    }
  }

  async #maybeStartCrossfade() {
    if (this.#crossfadeArming || this.#crossfadeStarted) return;
    if (getGuildSettings(this.#guildId).fade === false) return;
    if (this.#mixStream?.isCrossfading) return;
    if (this.#forceSkip || this.#handlingAfter) return;
    if (this.#audioPlayer.state.status !== AudioPlayerStatus.Playing) return;

    this.#crossfadeArming = true;
    try {
      const current = this.#queue.current;
      if (!current) return;

      let remaining = this.#mixStream?.remainingSec;
      if (remaining == null) {
        await this.#getCachedAnalysis(current);
        remaining = this.#mixStream?.remainingSec;
      }
      if (remaining == null) {
        const durationSec = this.#resolvePlaybackDurationSec(current);
        if (durationSec != null) {
          remaining = durationSec - (this.#mixStream?.positionSec ?? 0);
        }
      }
      if (remaining == null) return;
      // Analysis determines the exact overlap. Legacy crossfade caps at
      // MAX_CROSSFADE_SEC, but a beatmix/stem-mix overlap (up to
      // MIX_BARS.extended = 16 bars as of Phase 9E, docs/mix-transition-
      // phase9.md §7.2) can run longer at slower tempos — MAX_TRANSITION_LEAD_SEC
      // must cover both, or a slow-tempo beatmix's prep window never opens.
      // MAX_TRANSITION_LEAD_SEC is still TAIL_WINDOW_SEC (45s, unchanged by
      // Phase 9E) — at slow enough tempos a full 16-bar reach can itself
      // exceed 45s (e.g. 16 bars at 80 BPM/4-beat is 48s), which both caps
      // how early this gate opens AND caps findExitCandidates()'s own
      // candidate pool short of a true 16-bar-back exit point. This is the
      // known, deliberately out-of-scope-for-9E limitation Phase 9F (§8,
      // widening the tail analysis window) exists to address — see
      // docs/mix-transition-phase9.md's Phase 9E implementation notes.
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

      const outAnalysis = (await this.#getCachedAnalysis(current)) ?? fallbackAnalysis(current);
      const inAnalysis = (await this.#getCachedAnalysis(next)) ?? fallbackAnalysis(next);
      const outgoingPlaybackBpm = this.#sessionTempo.playbackBpm ?? outAnalysis.bpm ?? null;
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
      const stemCacheLookupKey = `${this.#prefetchKey(current) ?? ''}:${this.#prefetchKey(next) ?? ''}`;
      // Phase 9A (docs/mix-transition-phase9.md §3): whether the stem-cache
      // lookup below actually ran this tick — distinguishes a genuine
      // HIT/MISS from "never checked" (this pair is marked
      // #stemMixUnavailableKey, or stem-mix could never be eligible anyway)
      // for the [MIX PLAN] log/metrics built further down. Read-only
      // bookkeeping; does not affect selection.
      const stemCacheAttempted = mightBeatmix && this.#stemMixUnavailableKey !== stemCacheLookupKey;
      if (stemCacheAttempted) {
        // Codex review (PR #46, round 3, P2): each side is checked/memoized
        // independently — a positive outgoing hit from an earlier tick (or
        // an earlier pairing entirely, keyed on the track alone) is reused
        // without re-touching the filesystem, and only the side(s) still
        // missing actually call getCachedStemsFn() this tick.
        const outKey = this.#prefetchKey(current);
        const inKey = this.#prefetchKey(next);
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
        outgoingTempoRatio: this.#sessionTempo.tempoRatio ?? 1,
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
      const outgoingTempoRatio = this.#sessionTempo.tempoRatio ?? 1;
      const currentEntrySec = this.#currentEntrySec ?? 0;
      const nativeDurationSec = outAnalysis.durationSec
        ?? this.#resolvePlaybackDurationSec(current)
        ?? current.duration;
      const remainingNativeDurationSec = nativeDurationSec != null
        ? Math.max(0, nativeDurationSec - currentEntrySec)
        : null;
      const durationSec = compensateDurationSec(remainingNativeDurationSec, outgoingTempoRatio);
      const positionSec = this.#mixStream?.positionSec ?? 0;
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
        this.#ensureIncomingPrep(next, {
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
            this.#ensureOutgoingStemPrep(outCachedStems, current.videoId, {
              startSec: norm.exitStartSec ?? 0,
              tempoFilter: outgoingStemTempoFilter,
            }).catch((err) => console.warn('[GuildPlayer] outgoing stem prep failed:', err.message));
            this.#ensureIncomingStemPrep(inCachedStems, next.videoId, {
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
        source = await this.#takePreparedIncoming(next, { startSec: norm.entrySec, tempoFilter: norm.tempoFilter });
      } catch (err) {
        console.warn('[GuildPlayer] incoming pcm source failed:', err.message);
        await this.#cleanupIncomingTempFile();
        return;
      }

      if (this.#queue.current !== current || this.#forceSkip) {
        source.destroy();
        await this.#cleanupIncomingTempFile();
        return;
      }
      if (getGuildSettings(this.#guildId).fade === false) {
        source.destroy();
        await this.#cleanupIncomingTempFile();
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
        this.#clearPreparedOutgoingStems();
        this.#clearPreparedIncomingStems();
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
          this.#stemMixUnavailableKey = stemCacheLookupKey;
          source.destroy();
          await this.#cleanupIncomingTempFile();
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
        const freshPositionSec = this.#mixStream?.positionSec ?? positionSec;
        if (freshPositionSec - positionSec > OUTGOING_STEM_DRIFT_TOLERANCE_SEC) {
          // Same reasoning as the forcePlainCrossfade abort above — a plain
          // crossfade reusing stem-mix's relaxed window is unsafe (Codex),
          // and marking the pair unavailable avoids looping on this same
          // abort every arm tick (Codex round-9 follow-up).
          this.#stemMixUnavailableKey = stemCacheLookupKey;
          this.#clearPreparedOutgoingStems();
          this.#clearPreparedIncomingStems();
          source.destroy();
          await this.#cleanupIncomingTempFile();
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
        outgoingStems = this.#takePreparedOutgoingStems(current.videoId, {
          startSec: norm.exitStartSec ?? 0,
          tempoFilter: this.#outgoingStemTempoFilter(tempoBackend),
        });
        incomingStems = this.#takePreparedIncomingStems(next.videoId, {
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
          this.#stemMixUnavailableKey = stemCacheLookupKey;
          source.destroy();
          await this.#cleanupIncomingTempFile();
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
      this.#pendingSessionTempo = pendingSessionTempo;
      this.#pendingIncomingEntrySec = pendingEntrySec;
      this.#crossfadeTargetTrack = next;
      this.#crossfadeStarted = true;

      const started = mixPlan.mode === 'stem-mix'
        ? this.#mixStream.startStemCrossfade(
          { outgoing: outgoingStems, incoming: { ...incomingStems, full: source } },
          mixPlan,
        )
        : this.#mixStream.startCrossfade(source, mixPlan);
      if (!started) {
        this.#pendingSessionTempo = null;
        this.#pendingIncomingEntrySec = 0;
        this.#crossfadeTargetTrack = null;
        this.#crossfadeStarted = false;
        // startStemCrossfade() already destroys every source it was handed
        // (including `source`/incoming.full) on a rejected call, mirroring
        // startCrossfade()'s own contract — avoid double-destroying it here.
        if (mixPlan.mode !== 'stem-mix') source.destroy();
        await this.#cleanupIncomingTempFile();
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
      this.#lastEvaluatedTransitionReport = null;
    } finally {
      this.#crossfadeArming = false;
    }
  }

  async #cleanupIncomingTempFile() {
    const filePath = this.#incomingTempFile;
    this.#incomingTempFile = null;
    this.#incomingMeasured = null;
    if (filePath) {
      await cleanupTempFile(filePath);
    }
  }

  async #getPrefetchedOrFetch(track) {
    const key = this.#prefetchKey(track);
    const entry = key ? this.#prefetchEntries.get(key) : null;
    if (entry?.kind === 'full' && entry.promise) {
      this.#prefetchEntries.delete(key);
      const result = await entry.promise;
      if (result.error) throw result.error;
      if (result.value?.filePath) return result.value;
    }

    this.#discardPrefetch(track);
    return this.#prefetchTrackFn(track);
  }

  #prefetchKey(track) {
    return track?.videoId || track?.webpageUrl || null;
  }

  #prefetchUpcoming() {
    // Codex review (PR #44): wrappedUpcoming() (not upcoming().slice()) so
    // QUEUE loop mode's last track still gets a HIGH stem-prefetch/full
    // prefetch pass and the penultimate track still gets its LOW/lookahead
    // pass, instead of both silently missing lookahead right at the loop
    // boundary even though next() really does wrap there.
    const upcoming = this.#queue.loopMode === LoopMode.TRACK
      ? (this.#queue.current ? [this.#queue.current] : [])
      : this.#queue.wrappedUpcoming(3);

    const keep = new Set(upcoming.map((t) => this.#prefetchKey(t)).filter(Boolean));
    for (const key of [...this.#prefetchEntries.keys()]) {
      if (!keep.has(key)) this.#discardPrefetchKey(key);
    }

    const first = upcoming[0];
    if (first && isNormalizeDurationAllowed(first)) {
      this.#ensureFullPrefetch(first);
    }
    for (const track of upcoming.slice(1)) {
      if (track && isNormalizeDurationAllowed(track)) {
        this.#ensureAnalysisPrefetch(track);
      }
    }

    // Phase 9B (docs/mix-transition-phase9.md §4.2): next (B) gets HIGH
    // stem prefetch, next+1 (C) gets LOW. next+2 (D) and beyond stay
    // untouched by this — only the two loops above (full prefetch for the
    // track that's about to become current, lightweight BPM/phrase
    // lookahead for the rest) apply to them, exactly as before Phase 9B.
    const second = upcoming[1];
    if (first && isNormalizeDurationAllowed(first)) {
      this.#ensureStemPrefetch(first, StemPrefetchPriority.HIGH);
    }
    if (second && isNormalizeDurationAllowed(second)) {
      this.#ensureStemPrefetch(second, StemPrefetchPriority.LOW);
    }
    const activeVideoIds = new Set(upcoming.map((t) => t?.videoId).filter(Boolean));
    this.#stemPrefetchTracker.prune(activeVideoIds);
    for (const videoId of [...this.#stemPrefetchRetriedAfterKill]) {
      if (!activeVideoIds.has(videoId)) this.#stemPrefetchRetriedAfterKill.delete(videoId);
    }
  }

  /**
   * Phase 9B (docs/mix-transition-phase9.md §4): registers/refreshes this
   * videoId's stem-prefetch bookkeeping and, on a cache miss, makes sure
   * the actual separation work is (or gets) dispatched.
   *
   * HIGH (B, next): purely observational beyond registering intent — B
   * already gets a full download+normalize+analyze pass for real playback
   * prep (#ensureFullPrefetch() -> #scheduleAnalysis(), Phase 8's existing
   * pipeline), which itself ends by calling separateTrackStemsFn(). This
   * piggybacks on that pipeline's own dedup (#prefetchEntries by key,
   * #scheduledAnalysisTokens by videoId, stemCache.js's own per-videoId
   * in-flight map) instead of opening a second, redundant download path
   * for the same file — so this method never itself calls
   * #prefetchTrackFn for a HIGH-priority track.
   *
   * LOW (C, next+1): drives the download + staged-copy + separation
   * directly via #runLowPriorityStemPrefetch(), because nothing else in
   * the existing pipeline keeps C's audio around long enough for Demucs —
   * #ensureAnalysisPrefetch()'s own lookahead deletes its temp file the
   * instant BPM/phrase analysis finishes (by design, phase8.md §21: running
   * full-track Demucs against an unconfirmed 2-3-tracks-ahead candidate was
   * judged disproportionate — Phase 9B narrows that specifically to next+1).
   * This is independent of the BPM-analysis cache: a track can have
   * analysis cached from an earlier play while still missing its Demucs
   * stems, so #ensureAnalysisPrefetch()'s own persisted-analysis
   * short-circuit must not also gate stem prefetch.
   *
   * Either way, dispatch happens only after #getCachedStemsFn() confirms a
   * miss — a cache HIT just marks the entry READY (sticky, like
   * #outStemCacheHit/#inStemCacheHit's own "only positive results are memoized" — a MISS
   * keeps getting re-checked on every #prefetchUpcoming() call, since
   * background separation completing mid-window is the whole point).
   * Nothing here is awaited by #maybeStartCrossfade() or anything else on
   * the realtime playback path — every call this method makes is
   * fire-and-forget from that path's perspective (§5.4 "Playback Safety",
   * in spirit — the dedicated pausable priority queue itself is Phase 9C's
   * job).
   */
  #ensureStemPrefetch(track, priority) {
    const videoId = track?.videoId;
    if (!videoId) return;

    const entry = this.#stemPrefetchTracker.queue(videoId, priority);
    if (entry.state === StemPreparationState.READY) return;

    this.#getCachedStemsFn(videoId).then((cached) => {
      if (cached) {
        this.#stemPrefetchTracker.markReady(videoId);
        return;
      }

      if (entry.priority === StemPrefetchPriority.HIGH) {
        const key = this.#prefetchKey(track);
        const prefetchEntry = key ? this.#prefetchEntries.get(key) : null;
        if (prefetchEntry?.kind === 'full' && prefetchEntry.track === track) {
          this.#stemPrefetchTracker.markProcessing(videoId);
          prefetchEntry.promise.then((result) => {
            // A resolved value only means the DOWNLOAD/normalize step
            // succeeded — separation itself runs asynchronously afterward
            // inside #scheduleAnalysis()'s own analysisQueue job, which
            // has no promise this method can await. The next
            // #prefetchUpcoming() tick's getCachedStemsFn() probe (above)
            // is what actually detects real separation completion; this
            // only catches the one failure mode visible from here.
            if (result?.error) this.#stemPrefetchTracker.markFailed(videoId);
          });
        }
        return;
      }

      if (this.#lowPriorityStemPrefetch.has(videoId)) return;
      this.#lowPriorityStemPrefetch.add(videoId);
      this.#stemPrefetchTracker.markProcessing(videoId);
      this.#runLowPriorityStemPrefetch(track)
        .then((stems) => {
          if (stems) this.#stemPrefetchTracker.markReady(videoId);
          else this.#stemPrefetchTracker.markFailed(videoId);
        })
        .catch((err) => {
          if (err?.code === 'ANALYSIS_KILLED') {
            console.warn('[GuildPlayer] low-priority stem prefetch yielded to mixer:', err.message);
          } else {
            console.warn('[GuildPlayer] low-priority stem prefetch failed:', err.message);
          }
          this.#stemPrefetchTracker.markFailed(videoId);
        })
        .finally(() => this.#lowPriorityStemPrefetch.delete(videoId));
    }).catch((err) => {
      console.warn('[GuildPlayer] stem prefetch cache check failed:', err.message);
    });
  }

  /**
   * Phase 9B: LOW-priority stem prefetch for next+1 (C). Mirrors
   * #scheduleAnalysis()'s own staged-copy dance (stage an independent copy
   * before separation so unrelated cleanup elsewhere can't delete the file
   * mid-Demucs-run, docs/mix-transition-phase8.md Step 8.5) but owns its
   * own short-lived download via #prefetchTrackFn, since — unlike A/B —
   * nothing else in the pipeline downloads C's audio at all outside this
   * method.
   *
   * Phase 9C (docs/mix-transition-phase9.md §5): routed through the
   * dedicated StemPreparationQueue (#stemQ()), not the realtime analysis
   * queue — this whole job (download + stage + Demucs) exists only to
   * prepare C's stems, same as #scheduleAnalysis()'s own separation step,
   * so it belongs on the same lane and must not be able to sit in front of
   * an unrelated track's BPM/phrase job. A mixer underrun still
   * SIGSTOPs/kills it exactly like every other queued job (§5.4 "Playback
   * Safety") — now via the stem queue's own pause/kill state, forwarded
   * from the realtime queue's underrun event (see #initMixerPipeline()).
   */
  async #runLowPriorityStemPrefetch(track) {
    return this.#stemQ().enqueue(async ({ spawnNice, signal } = {}) => {
      throwIfAborted(signal);
      // Codex review (PR #44, P2): recheck the stem cache now that this LOW
      // job has actually reached the front of the (possibly minutes-long,
      // serial) queue — #ensureStemPrefetch() only observed a miss back
      // when this job was first enqueued. If another guild's playback or
      // an earlier HIGH job separated this same track while this job
      // waited, the full download/trim/loudness/staging pipeline below is
      // pure waste; the real separateTrackStems() already rechecks the
      // cache too, but only after all of that expensive work is done.
      const alreadyCached = await this.#getCachedStemsFn(track.videoId).catch(() => null);
      if (alreadyCached) return alreadyCached;
      throwIfAborted(signal);
      // Codex review (PR #44, P1): without spawnFn, prefetchTrackFn's
      // default implementation (normalize.js's prefetchTrack) spawns
      // yt-dlp/ffmpeg via the module-level `spawn`, entirely untracked by
      // this queue's pause/kill machinery — a mixer underrun during this
      // download would have nothing to actually SIGSTOP. Passing spawnNice
      // routes those subprocesses through the same register()/children Set
      // every other job in this queue already uses.
      const downloaded = await this.#prefetchTrackFn(track, { spawnFn: spawnNice, signal });
      try {
        throwIfAborted(signal);
        const stagedPath = await this.#stageTempFileCopyFn(downloaded.filePath).catch((err) => {
          console.warn('[GuildPlayer] failed to stage file for low-priority stem prefetch:', err.message);
          return null;
        });
        if (!stagedPath) return null;
        throwIfAborted(signal);
        try {
          return await this.#separateTrackStemsFn(stagedPath, track.videoId, { spawnFn: spawnNice, signal });
        } finally {
          cleanupTempFile(stagedPath).catch(() => {});
        }
      } finally {
        await cleanupTempFile(downloaded.filePath);
      }
    // Codex review (PR #45, P1): explicit LOW priority so a HIGH (B) job
    // requested afterward can still jump ahead of this one in the pending
    // queue instead of only ever winning by coincidence of call order.
    }, { priority: 'low' });
  }

  #ensureFullPrefetch(track) {
    const key = this.#prefetchKey(track);
    if (!key) return;
    const existing = this.#prefetchEntries.get(key);
    if (existing?.kind === 'full' && existing.track === track) return;
    if (existing) this.#discardPrefetchKey(key);

    this.#prefetchEntries.set(key, {
      kind: 'full',
      track,
      promise: this.#prefetchTrackFn(track).then(
        (value) => {
          this.#scheduleAnalysis(track, value.filePath);
          return { value };
        },
        (error) => ({ error }),
      ),
    });
  }

  #ensureAnalysisPrefetch(track) {
    const key = this.#prefetchKey(track);
    if (!key) return;
    if (track.videoId && this.#analysisCache.has(track.videoId)) return;
    if (this.#prefetchEntries.has(key)) return;

    this.#prefetchEntries.set(key, {
      kind: 'analysis',
      track,
      promise: this.#analysisQ().enqueue(async ({ spawnNice, signal } = {}) => {
        const cached = await this.#lookupPersistentAnalysis(track);
        if (cached) return { analyzed: true };
        throwIfAborted(signal);
        const downloaded = await this.#prefetchTrackFn(track);
        try {
          throwIfAborted(signal);
          const probed = await probeDurationSec(downloaded.filePath).catch(() => null);
          if (track.videoId && probed != null) {
            this.#probedDurationCache.set(track.videoId, probed);
          }
          await this.#runAnalysis(track, downloaded.filePath, {
            spawnFn: spawnNice,
            signal,
            durationSec: probed,
          });
        } finally {
          await cleanupTempFile(downloaded.filePath);
        }
        return { analyzed: true };
      }).then((value) => ({ value }), (error) => {
        if (error?.code !== 'ANALYSIS_KILLED') {
          console.warn('[GuildPlayer] lookahead analysis failed:', error.message);
        }
        return { error };
      }),
    });
  }

  #queueRefillKey(track) {
    return track?.videoId || track?.webpageUrl || track || null;
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
    this.#lastEvaluatedTransitionReport = {
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
  #takeMatchingEvaluatedTransition(outgoingTrack, incomingTrack, entrySec = 0) {
    const stashed = this.#lastEvaluatedTransitionReport;
    this.#lastEvaluatedTransitionReport = null;
    if (!stashed) return null;
    if (Date.now() - stashed.evaluatedAt >= LAST_EVALUATED_TRANSITION_MAX_AGE_MS) return null;
    // Codex review (PR #43, round 9): must use the same #prefetchKey()
    // fallback identity the stash was built with (see stemCacheLookupKey
    // above) — otherwise a videoId-less pair could never match its own
    // stash at all, silently falling back to the generic stub every time.
    const pairKey = `${this.#prefetchKey(outgoingTrack) ?? ''}:${this.#prefetchKey(incomingTrack) ?? ''}`;
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

  #startQueueRefill(track) {
    const key = this.#queueRefillKey(track);
    if (this.#queueRefill?.key === key) return this.#queueRefill.promise;
    const promise = this.#tryHandleQueueExhausted(track);
    this.#queueRefill = { key, promise };
    return promise;
  }

  #maybeRefillQueue() {
    if (this.#queue.loopMode === LoopMode.TRACK) return;
    if (this.#queue.upcoming().length > 0) return;
    if (!this.#handleQueueExhausted) return;
    const current = this.#queue.current;
    if (!current) return;
    if (this.#queueRefill?.key === this.#queueRefillKey(current)) return;
    this.#startQueueRefill(current)
      .then((handled) => {
        if (handled) this.#prefetchUpcoming();
      })
      .catch((err) => {
        console.warn('[GuildPlayer] early queue refill failed:', err.message);
      });
  }

  #discardPrefetch(keepTrack = null) {
    const keepKey = keepTrack ? this.#prefetchKey(keepTrack) : null;
    for (const key of [...this.#prefetchEntries.keys()]) {
      if (key === keepKey) continue;
      this.#discardPrefetchKey(key);
    }
  }

  #discardPrefetchKey(key) {
    const entry = this.#prefetchEntries.get(key);
    if (!entry) return;
    this.#prefetchEntries.delete(key);
    entry.promise.then((result) => {
      if (result.value?.filePath) {
        cleanupTempFile(result.value.filePath).catch((err) => {
          console.error('[GuildPlayer] prefetch cleanup error:', err);
        });
      }
    }).catch(() => {});
  }

  async #cleanupCurrentTempFile() {
    const filePath = this.#currentTempFile;
    this.#currentTempFile = null;
    this.#currentMeasured = null;
    if (filePath) {
      await cleanupTempFile(filePath);
    }
  }

  #resetWatchdog() {
    this.#clearWatchdog();
    // Discord playbackDuration progress detects stalls where frames are produced
    // but the voice connection stops advancing. Producer lastDataAt freezes on
    // pause while PCM still buffers, so it is not used as the stall signal.
    let lastPlaybackDuration = 0;
    this.#watchdogTimer = setInterval(() => {
      const state = this.#audioPlayer.state;
      if (state.status !== AudioPlayerStatus.Playing) return;

      const duration = state.playbackDuration ?? 0;
      if (duration > lastPlaybackDuration) {
        lastPlaybackDuration = duration;
        this.#lastActiveAt = Date.now();
        return;
      }

      if (Date.now() - this.#lastActiveAt <= WATCHDOG_STALL_THRESHOLD) return;

      console.warn('[GuildPlayer] watchdog: stall detected');
      this.#hadError = true;
      this.#mixStream?.dropCurrent();
      // Codex review (PR #45, P1): same silent underrun-state reset as the
      // other dropCurrent() call sites.
      this.#stemQ().noteUnderrunCleared(this);
    }, WATCHDOG_INTERVAL);
  }

  #clearWatchdog() {
    if (this.#watchdogTimer !== null) {
      clearInterval(this.#watchdogTimer);
      this.#watchdogTimer = null;
    }
  }
}

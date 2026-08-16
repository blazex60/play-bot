import {
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  StreamType,
} from '@discordjs/voice';
import { resolveAudioStream } from './search.js';
import { getGuildSettings } from './settings.js';
import {
  cleanupTempFile,
  isNormalizeDurationAllowed,
  prefetchTrack,
} from './normalize.js';
import { shouldReconnectRetry } from './player/playbackPolicy.js';
import { MixStream } from './audio/mixStream.js';
import { createStreamSource, createFileSource } from './audio/pcmSource.js';
import { analyzeTrackFile, ANALYSIS_VERSION } from './audio/trackAnalysis.js';
import { planBeatSyncedTransition } from './audio/beatmixTransition.js';
import { probeDurationSec } from './audio/duration.js';
import { createSessionTempoState, resetSessionTempo, probeTempoBackend, compensateDurationSec } from './audio/tempo.js';
import { TAIL_WINDOW_SEC } from './audio/vocalActivity.js';
import { LoopMode } from './queue.js';
import { getAnalysisQueue } from './audio/analysisQueue.js';

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
const ANALYSIS_MISS_BACKOFF_MS = 30_000;
const WATCHDOG_STALL_THRESHOLD = 30_000;
const QUEUE_EXHAUSTED_TIMEOUT = 30_000;

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
  #audioPlayer;
  #forceSkip = false;
  #hadError = false;
  #playbackStart = 0;
  #lastActiveAt = 0;
  #watchdogTimer = null;
  #currentTempFile = null;
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
  /** @type {{ key: *, promise: Promise<boolean|null> } | null} */
  #queueRefill = null;
  #prefetchTrackFn;

  constructor({
    guildId,
    connection,
    queue,
    onDisconnect,
    handleQueueExhausted = null,
    queueExhaustedTimeoutMs = QUEUE_EXHAUSTED_TIMEOUT,
    recordPlayFn = null,
    onTrackStart = null,
    audioPlayer = createAudioPlayer(),
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
    prefetchTrackFn = prefetchTrack,
    probeTempoBackendFn = probeTempoBackend,
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
    this.#prefetchTrackFn = prefetchTrackFn;
    this.#probeTempoBackendFn = probeTempoBackendFn;

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
      this.#mixStream?.dropCurrent();
    });

    this.#connection.subscribe(this.#audioPlayer);
  }

  async playNext() {
    const track = this.#queue.current;
    if (!track) {
      await this.#onDisconnect();
      return;
    }
    await this.#playNextMixer(track);
  }

  async #playNextMixer(track) {
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
      if (!this.#queue.current) await this.#onDisconnect();
      return;
    }
    if (this.#forceSkip) {
      source.destroy();
      await this.#cleanupCurrentTempFile();
      this.#forceSkip = false;
      const nextTrack = this.#queue.next({ forceAdvance: true });
      if (nextTrack === null) {
        await this.#onDisconnect();
      } else {
        await this.playNext();
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
    this.#resetSessionTempoFor(track);
    if (!this.#mixerStarted) {
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
    this.#mixerResource = this.#createAudioResource(this.#mixStream, {
      inputType: StreamType.Raw,
    });
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
      this.#mixStream.dropCurrent();
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
    });
    this.#mixStream.on('underrunClear', () => {
      this.#analysisQ().noteUnderrunCleared(this);
    });
  }

  #analysisQ() {
    return this.#analysisQueue ?? getAnalysisQueue();
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

    this.#preparedIncoming = null;
    const outgoingTemp = this.#currentTempFile;
    this.#currentTempFile = this.#incomingTempFile;
    this.#incomingTempFile = null;
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

  #isMixerDead() {
    return !this.#mixStream
      || this.#mixStream.isDestroyed()
      || this.#mixStream.destroyed
      || this.#mixerResource?.ended;
  }

  /**
   * @discordjs/voice destroys playStream when leaving Playing. If MixStream was
   * destroyed mid-session, rebuild it so later setCurrent/play can succeed.
   */
  #recoverMixerPlayback({ play = true } = {}) {
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
    if (!play) {
      this.#mixerStarted = false;
      return;
    }
    try {
      this.#audioPlayer.play(this.#mixerResource);
      this.#mixerStarted = true;
    } catch (err) {
      console.error('[GuildPlayer] mixer recovery play failed:', err.message);
      this.#initMixerPipeline();
      try {
        this.#audioPlayer.play(this.#mixerResource);
        this.#mixerStarted = true;
      } catch (err2) {
        console.error('[GuildPlayer] mixer recovery rebuild play failed:', err2.message);
      }
    }
  }

  #ensureMixerPlaying() {
    if (!this.#mixerResource) return;
    if (this.#isMixerDead()) {
      this.#recoverMixerPlayback();
      return;
    }
    try {
      this.#audioPlayer.play(this.#mixerResource);
      this.#mixerStarted = true;
    } catch (err) {
      console.error('[GuildPlayer] mixer play failed, rebuilding:', err.message);
      this.#recoverMixerPlayback();
    }
  }

  async #onCrossfadePromoted() {
    this.#forceSkip = false;
    this.#hadError = false;
    this.#clearCrossfadeArm();

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
    this.#incomingMeasured = null;

    const nextTrack = this.#queue.current;
    if (!nextTrack) {
      if (outgoingTemp) await cleanupTempFile(outgoingTemp);
      await this.#onDisconnect();
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

  #resetSessionTempoFor(track) {
    // Fast path only: #analysisCache is rarely populated synchronously by
    // the time a track becomes current (analysis is normally scheduled/
    // fetched afterward — see #scheduleAnalysis / #maybeStartCrossfade).
    // #maybeApplyAnalysisDuration backfills nativeBpm below once analysis
    // actually arrives for this track, however it arrives (persisted
    // lookup, in-memory cache hit, or a freshly completed #runAnalysis).
    const nativeBpm = track?.videoId ? (this.#analysisCache.get(track.videoId)?.bpm ?? null) : null;
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
    return this.#audioPlayer.pause();
  }

  get status() {
    return this.#audioPlayer.state.status;
  }

  resume() {
    return this.#audioPlayer.unpause();
  }

  async skip() {
    this.#forceSkip = true;
    this.#mixStream?.dropCurrent();
  }

  async stop() {
    this.#queue.clear();
    this.#clearWatchdog();
    this.#clearCrossfadeArm();
    this.#clearPreparedIncoming();
    this.#queueRefill = null;
    this.#analysisQ().noteUnderrunCleared(this);
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
      const handled = await this.#startQueueRefill(finishedTrack);
      // null = another round already owns the autoplay lock; do not disconnect.
      if (handled !== false) return;
      await this.#onDisconnect();
    } else {
      await this.playNext();
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
    this.#analysisQ().enqueue(async ({ spawnNice, signal } = {}) => {
      const cached = await this.#lookupPersistentAnalysis(track);
      if (cached) return cached;
      return this.#runAnalysis(track, filePath, { spawnFn: spawnNice, signal });
    }).catch((err) => {
      if (err?.code === 'ANALYSIS_KILLED') {
        console.warn('[GuildPlayer] analysis yielded to mixer:', err.message);
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
      this.#sessionTempo = resetSessionTempo(analysis.bpm);
    }
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
      // MAX_CROSSFADE_SEC, but a beatmix overlap (up to BEATMIX_OVERLAP_BARS
      // bars) can run longer at slower tempos — MAX_TRANSITION_LEAD_SEC must
      // cover both, or a slow-tempo beatmix's prep window never opens.
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
      // planBeatmixTransition rejects before ever touching the backend when
      // either side lacks a usable BPM (the common case — most analyses are
      // fallbackAnalysis() or simply BPM-less) — skip the real ffmpeg -filters
      // probe entirely then, rather than spawning it every 200ms arm tick.
      const mightBeatmix = outAnalysis.bpm > 0 && (inAnalysis.headBpm ?? inAnalysis.bpm) > 0;
      // 'rubberband' is only a placeholder for the branch where no probe ran
      // at all (planBeatmixTransition rejects on bpm-unavailable before ever
      // touching the backend there, so its value is moot). When the probe
      // DID run and genuinely found no usable filter, that null must reach
      // the planner as-is — coalescing it to 'rubberband' would tell it a
      // backend is available when it isn't, producing a filter string ffmpeg
      // can't actually apply.
      const tempoBackend = mightBeatmix ? await this.#probeTempoBackendFn() : 'rubberband';
      const rawPlan = planBeatSyncedTransition(outAnalysis, inAnalysis, {
        outgoingPlaybackBpm,
        tempoBackend,
        maxOverlapSec: MAX_CROSSFADE_SEC,
      });
      if (rawPlan.mode === 'gapless' || !(rawPlan.fadeSec > 0)) return;
      const norm = normalizeTransitionPlan(rawPlan);

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
      // entrySec instead — nonzero for exactly beatmix/phrase-crossfade,
      // zero for anything else — and strip baseSwap along with beatmix's
      // bar-envelope fields (Codex round-4).
      const mixPlan = (!sourceHonorsPlan && norm.entrySec > 0)
        ? { ...norm.mixPlan, mode: 'crossfade', sync: null, eq: null, targetBpm: null, baseSwap: false }
        : norm.mixPlan;

      // Set promotion state BEFORE calling startCrossfade(): if the outgoing
      // source is already at EOF, startCrossfade()'s synchronous
      // #scheduleRead() can promote the incoming source (and fire
      // #onCrossfadePromoted synchronously) before this call returns —
      // #onCrossfadePromoted must see the real target/tempo, not stale
      // values from a previous crossfade attempt. Rolled back on failure.
      this.#pendingSessionTempo = pendingSessionTempo;
      this.#pendingIncomingEntrySec = pendingEntrySec;
      this.#crossfadeTargetTrack = next;
      this.#crossfadeStarted = true;

      const started = this.#mixStream.startCrossfade(source, mixPlan);
      if (!started) {
        this.#pendingSessionTempo = null;
        this.#pendingIncomingEntrySec = 0;
        this.#crossfadeTargetTrack = null;
        this.#crossfadeStarted = false;
        source.destroy();
        await this.#cleanupIncomingTempFile();
        return;
      }
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
    const upcoming = this.#queue.loopMode === LoopMode.TRACK
      ? (this.#queue.current ? [this.#queue.current] : [])
      : this.#queue.upcoming().slice(0, 3);

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
    }, WATCHDOG_INTERVAL);
  }

  #clearWatchdog() {
    if (this.#watchdogTimer !== null) {
      clearInterval(this.#watchdogTimer);
      this.#watchdogTimer = null;
    }
  }
}

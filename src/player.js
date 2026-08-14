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
import { planTransition, DEFAULT_OVERLAP_SEC } from './audio/transition.js';
import { probeDurationSec } from './audio/duration.js';
import { LoopMode } from './queue.js';
import { getAnalysisQueue } from './audio/analysisQueue.js';

const WATCHDOG_INTERVAL = 10_000;
const CROSSFADE_ARM_INTERVAL_MS = 200;
/** Start downloading/decoding the next track this many seconds before overlap. */
const CROSSFADE_PREP_LEAD_SEC = 15;
const MAX_CROSSFADE_SEC = 6;
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
  #createPcmSourceFn;
  #incomingTempFile = null;
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
  #refillingQueue = false;

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
    createPcmSourceFn = null,
    getTrackAnalysisFn = null,
    putTrackAnalysisFn = null,
    analyzeTrackFileFn = analyzeTrackFile,
    analysisQueue = null,
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
    if (!this.#mixerStarted) {
      this.#ensureMixerPlaying();
    }
    this.#clearPreparedIncoming();
    this.#crossfadeStarted = false;
    this.#crossfadeTargetTrack = null;
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
      this.#analysisQ().noteUnderrun();
    });
    this.#mixStream.on('underrunClear', () => {
      this.#analysisQ().noteUnderrunCleared();
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

    if (!adopt(source, { durationSec: this.#resolvePlaybackDurationSec(next) })) {
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

    if (this.#queue.loopMode !== LoopMode.TRACK && this.#queue.current !== next) {
      this.#queue.next({ forceAdvance: true });
    }

    this.#crossfadeStarted = false;
    this.#crossfadeTargetTrack = null;
    this.#clearCrossfadeArm();
    this.#playbackStart = Date.now();
    this.#lastActiveAt = Date.now();
    this.#playbackCount += 1;
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
    this.#mixStream?.setDurationSec(this.#resolvePlaybackDurationSec(nextTrack));
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
      const handled = await this.#tryHandleQueueExhausted(finishedTrack);
      if (handled) return;
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

  async #createPcmSource(track, { forIncoming = false, prepId = null } = {}) {
    if (this.#createPcmSourceFn) {
      return this.#createPcmSourceFn(track, { forIncoming });
    }

    if (!forIncoming) {
      this.#currentTempFile = null;
    }

    // Mixer path forces normalize when duration allows (crossfade quality).
    if (!isNormalizeDurationAllowed(track)) {
      if (!forIncoming) this.#discardPrefetch();
      // Live/untrimmed stream — do not keep a prior trimmed duration.
      if (track.videoId) this.#probedDurationCache.delete(track.videoId);
      return createStreamSource(track, { resolveAudioStreamFn: this.#resolveAudioStream });
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
      } else {
        this.#currentTempFile = prefetched.filePath;
      }
      this.#scheduleAnalysis(track, prefetched.filePath);
      return createFileSource(prefetched.filePath, { measured: prefetched.measured });
    } catch (err) {
      if (err?.code === 'INCOMING_PREP_CANCELLED') throw err;
      console.warn(`[GuildPlayer] normalize fallback for ${track.title}:`, err.message);
      if (track.videoId) this.#probedDurationCache.delete(track.videoId);
      return createStreamSource(track, { resolveAudioStreamFn: this.#resolveAudioStream });
    }
  }

  #scheduleAnalysis(track, filePath) {
    if (!track?.videoId || !filePath || !this.#analyzeTrackFileFn) return;
    this.#analysisQ().enqueue(async () => {
      if (this.#analysisCache.has(track.videoId)) return this.#analysisCache.get(track.videoId);
      return this.#runAnalysis(track, filePath);
    }).catch((err) => {
      if (err?.code === 'ANALYSIS_KILLED') {
        console.warn('[GuildPlayer] analysis yielded to mixer:', err.message);
        return;
      }
      console.warn('[GuildPlayer] analysis failed:', err.message);
    });
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

  async #runAnalysis(track, filePath) {
    if (!filePath || !this.#analyzeTrackFileFn) return null;
    const analysis = await this.#analyzeTrackFileFn(filePath, {
      videoId: track.videoId,
      durationSec: this.#resolvePlaybackDurationSec(track) ?? track.duration,
    });
    if (track.videoId) {
      this.#analysisCache.set(track.videoId, analysis);
      this.#putTrackAnalysisFn?.(track.videoId, analysis);
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
    if (!analysis?.durationSec) return;
    if (this.#queue.current !== track) return;
    if (this.#mixStream?.remainingSec == null) {
      this.#mixStream.setDurationSec(analysis.durationSec);
    }
  }

  #clearPreparedIncoming() {
    // Invalidate in-flight createPcmSource so it won't assign #incomingTempFile
    // after cancel (stop / skip / replace prep / playNextMixer).
    this.#incomingPrepId += 1;
    if (!this.#preparedIncoming) return;
    const pending = this.#preparedIncoming;
    this.#preparedIncoming = null;
    const source = pending.source;
    if (source) {
      source.destroy?.();
    } else {
      pending.promise.then((resolved) => {
        resolved?.destroy?.();
      }).catch(() => {});
    }
    const filePath = this.#incomingTempFile;
    this.#incomingTempFile = null;
    if (filePath) {
      cleanupTempFile(filePath).catch((err) => {
        console.error('[GuildPlayer] prepared incoming temp cleanup error:', err);
      });
    }
  }

  #ensureIncomingPrep(next) {
    if (this.#preparedIncoming?.track === next) return;
    this.#clearPreparedIncoming();
    const prepId = this.#incomingPrepId;
    const entry = { track: next, source: null, promise: null };
    entry.promise = this.#createPcmSource(next, { forIncoming: true, prepId })
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

  async #takePreparedIncoming(next, { forPlayback = false } = {}) {
    if (this.#preparedIncoming?.track === next) {
      const pending = this.#preparedIncoming;
      this.#preparedIncoming = null;
      const source = pending.source ?? await pending.promise;
      if (forPlayback && this.#incomingTempFile) {
        this.#currentTempFile = this.#incomingTempFile;
        this.#incomingTempFile = null;
      }
      return source;
    }
    const prepId = this.#incomingPrepId;
    return this.#createPcmSource(next, { forIncoming: !forPlayback, prepId });
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
      // Analysis determines the exact overlap, but it cannot exceed six
      // seconds. Avoid polling the Web process throughout a long track.
      if (remaining > CROSSFADE_PREP_LEAD_SEC + MAX_CROSSFADE_SEC) return;
      // TRACK loop must re-arm the same track; upcoming()[0] would advance on promote.
      const next = this.#queue.loopMode === LoopMode.TRACK
        ? current
        : this.#queue.upcoming()[0];
      if (!next) {
        if (remaining <= CROSSFADE_PREP_LEAD_SEC + DEFAULT_OVERLAP_SEC) {
          this.#maybeRefillQueue();
        }
        return;
      }

      const outAnalysis = (await this.#getCachedAnalysis(current)) ?? fallbackAnalysis(current);
      const inAnalysis = (await this.#getCachedAnalysis(next)) ?? fallbackAnalysis(next);
      const plan = planTransition(outAnalysis, inAnalysis);
      if (plan.mode === 'gapless' || !(plan.fadeSec > 0)) return;

      const durationSec = outAnalysis.durationSec
        ?? this.#resolvePlaybackDurationSec(current)
        ?? current.duration;
      const positionSec = this.#mixStream?.positionSec ?? 0;
      const startSec = plan.startSec != null && durationSec != null
        ? plan.startSec
        : (durationSec != null ? Math.max(0, durationSec - plan.fadeSec) : null);

      const fadeWindow = plan.fadeSec + 0.35;
      const prepWindow = plan.fadeSec + CROSSFADE_PREP_LEAD_SEC;
      if (remaining <= prepWindow) {
        this.#ensureIncomingPrep(next);
      }

      if (plan.mode === 'crossfade' && startSec != null) {
        if (positionSec + 0.35 < startSec) return;
      } else if (remaining > fadeWindow) {
        return;
      }

      let source;
      try {
        source = await this.#takePreparedIncoming(next);
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

      const started = this.#mixStream.startCrossfade(source, plan);
      if (!started) {
        source.destroy();
        await this.#cleanupIncomingTempFile();
        return;
      }

      this.#crossfadeStarted = true;
      this.#crossfadeTargetTrack = next;
    } finally {
      this.#crossfadeArming = false;
    }
  }

  async #cleanupIncomingTempFile() {
    const filePath = this.#incomingTempFile;
    this.#incomingTempFile = null;
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
    return prefetchTrack(track);
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
      promise: prefetchTrack(track).then(
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
      promise: prefetchTrack(track).then(async (value) => {
        try {
          await this.#analysisQ().enqueue(async () => {
            if (track.videoId && this.#analysisCache.has(track.videoId)) return;
            await this.#runAnalysis(track, value.filePath);
          });
        } catch (err) {
          if (err?.code !== 'ANALYSIS_KILLED') {
            console.warn('[GuildPlayer] lookahead analysis failed:', err.message);
          }
        } finally {
          const current = this.#prefetchEntries.get(key);
          if (current?.kind !== 'full') {
            await cleanupTempFile(value.filePath);
          }
        }
        return { value: { analyzed: true } };
      }, (error) => ({ error })),
    });
  }

  #maybeRefillQueue() {
    if (this.#refillingQueue) return;
    if (this.#queue.loopMode === LoopMode.TRACK) return;
    if (this.#queue.upcoming().length > 0) return;
    if (!this.#handleQueueExhausted) return;
    this.#refillingQueue = true;
    this.#tryHandleQueueExhausted(this.#queue.current)
      .then((handled) => {
        if (handled) this.#prefetchUpcoming();
      })
      .catch((err) => {
        console.warn('[GuildPlayer] early queue refill failed:', err.message);
      })
      .finally(() => {
        this.#refillingQueue = false;
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

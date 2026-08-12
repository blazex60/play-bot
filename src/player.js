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
  createNormalizedResource,
  isNormalizeDurationAllowed,
  prefetchTrack,
} from './normalize.js';
import { shouldReconnectRetry } from './player/playbackPolicy.js';
import { isMixerEnabled } from './audio/config.js';
import { MixStream } from './audio/mixStream.js';
import { createStreamSource, createFileSource } from './audio/pcmSource.js';
import { analyzeTrackFile } from './audio/trackAnalysis.js';
import { planTransition } from './audio/transition.js';
import { LoopMode } from './queue.js';

const WATCHDOG_INTERVAL = 10_000;
const CROSSFADE_ARM_INTERVAL_MS = 200;
const WATCHDOG_STALL_THRESHOLD = 30_000;
const QUEUE_EXHAUSTED_TIMEOUT = 30_000;

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
  #prefetchTrack = null;
  #prefetchPromise = null;
  #currentResource = null;
  #createAudioResource;
  #resolveAudioStream;
  #handlingAfter = false;
  #handlingAfterPlayback = 0;
  #pendingAfter = false;
  #playbackCount = 0;
  #mixerEnabled;
  #mixStream = null;
  #mixerResource = null;
  #mixerStarted = false;
  #createPcmSourceFn;
  #incomingTempFile = null;
  #analysisCache = new Map();
  #crossfadeArmTimer = null;
  #crossfadeStarted = false;
  #crossfadeTargetTrack = null;
  #getTrackAnalysisFn;
  #putTrackAnalysisFn;
  #analyzeTrackFileFn;

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
    mixerEnabled = isMixerEnabled(),
    getTrackAnalysisFn = null,
    putTrackAnalysisFn = null,
    analyzeTrackFileFn = analyzeTrackFile,
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
    this.#mixerEnabled = mixerEnabled;
    this.#createPcmSourceFn = createPcmSourceFn;
    this.#getTrackAnalysisFn = getTrackAnalysisFn;
    this.#putTrackAnalysisFn = putTrackAnalysisFn;
    this.#analyzeTrackFileFn = analyzeTrackFileFn;

    if (this.#mixerEnabled) {
      this.#initMixerPipeline();
      this.#audioPlayer.on(AudioPlayerStatus.Idle, () => {
        if (!this.#mixerStarted) return;
        console.warn('[GuildPlayer] unexpected Idle in mixer mode, recovering');
        this.#recoverMixerPlayback();
      });
    } else {
      this.#audioPlayer.on(AudioPlayerStatus.Idle, () => {
        this.#advanceAfterPlayback();
      });
    }

    this.#audioPlayer.on('stateChange', (oldState, newState) => {
      if (newState.status === AudioPlayerStatus.Playing) {
        this.#lastActiveAt = Date.now();
      }
    });

    this.#audioPlayer.on('error', err => {
      console.error('[GuildPlayer] audioPlayer error:', err);
      this.#hadError = true;
      const failedTrack = this.#queue.current;

      if (this.#mixerEnabled) {
        this.#mixStream?.dropCurrent();
        return;
      }

      // A stream error does not reliably produce an Idle event (for example,
      // when yt-dlp cannot read a private or deleted video). Stop explicitly
      // so the failed track is advanced instead of leaving the queue stuck.
      this.#audioPlayer.stop();

      // Some AudioPlayer implementations do not emit Idle synchronously from
      // stop(). Give an emitted Idle handler precedence, then advance here as
      // a fallback once the player is confirmed idle.
      queueMicrotask(() => {
        if (
          this.#audioPlayer.state.status === AudioPlayerStatus.Idle &&
          this.#queue.current === failedTrack
        ) {
          this.#advanceAfterPlayback();
        }
      });
    });

    this.#connection.subscribe(this.#audioPlayer);
  }

  async playNext() {
    const track = this.#queue.current;
    if (!track) {
      await this.#onDisconnect();
      return;
    }

    if (this.#mixerEnabled) {
      await this.#playNextMixer(track);
      return;
    }

    const resource = await this.#createResource(track);
    this.#currentResource = resource;

    // stop()/skip() may have been issued while the resource was being
    // prepared (download + loudnorm analysis can take several seconds).
    // The player was still Idle during that window, so no natural
    // stateChange->Idle transition fired to drive #handleAfter(); recheck
    // here instead of unconditionally playing a now-stale resource.
    if (this.#queue.current !== track) {
      await this.#discardStaleResource(resource);
      if (!this.#queue.current) await this.#onDisconnect();
      return;
    }
    if (this.#forceSkip) {
      await this.#discardStaleResource(resource);
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
    this.#audioPlayer.play(resource);
    this.#prefetchUpcoming();
    this.#recordPlay(track);
    this.#onTrackStart?.(track.videoId);
  }

  async #playNextMixer(track) {
    let source;
    try {
      source = await this.#createPcmSource(track);
    } catch (err) {
      console.warn(`[GuildPlayer] pcm source failed for ${track.title}:`, err.message);
      this.#hadError = true;
      this.#advanceAfterPlayback();
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

    if (!this.#mixerStarted) {
      this.#audioPlayer.play(this.#mixerResource);
      this.#mixerStarted = true;
    } else {
      this.#ensureMixerPlaying();
    }

    // Pre-failed sources emit sourceerror (which advances) and return false —
    // skip recordPlay/onTrackStart just like the createPcmSource throw path.
    if (!this.#mixStream.setCurrent(source, { durationSec: track.duration ?? null })) {
      return;
    }
    this.#crossfadeStarted = false;
    this.#crossfadeTargetTrack = null;
    this.#startCrossfadeArm();
    this.#prefetchUpcoming();
    this.#recordPlay(track);
    this.#onTrackStart?.(track.videoId);
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
  }

  /**
   * @discordjs/voice destroys playStream when leaving Playing. If MixStream was
   * destroyed mid-session, rebuild it so later setCurrent/play can succeed.
   */
  #recoverMixerPlayback() {
    if (!this.#mixerEnabled) return;
    const dead = !this.#mixStream
      || this.#mixStream.destroyed
      || this.#mixerResource?.ended;
    if (dead) {
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
    if (!this.#mixerEnabled || !this.#mixerResource) return;
    if (this.#mixerResource.ended || this.#mixStream?.destroyed) {
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
    this.#mixStream?.setDurationSec(nextTrack.duration ?? null);
    this.#ensureMixerPlaying();
    this.#startCrossfadeArm();
    this.#prefetchUpcoming();
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
    if (this.#mixerEnabled) {
      this.#mixStream?.dropCurrent();
      return;
    }
    this.#audioPlayer.stop();
  }

  async stop() {
    this.#queue.clear();
    this.#clearWatchdog();
    this.#clearCrossfadeArm();
    await this.#cleanupCurrentTempFile();
    await this.#cleanupIncomingTempFile();
    this.#discardPrefetch();
    if (this.#mixerEnabled) {
      this.#mixStream?.endMixer();
      this.#mixerStarted = false;
      this.#audioPlayer.stop();
      return;
    }
    this.#audioPlayer.stop();
    this.#currentResource = null;
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
    this.#currentResource = null;
    this.#clearCrossfadeArm();
    await this.#cleanupCurrentTempFile();
    await this.#cleanupIncomingTempFile();

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

  async #createPcmSource(track, { forIncoming = false } = {}) {
    if (this.#createPcmSourceFn) {
      return this.#createPcmSourceFn(track, { forIncoming });
    }

    if (!forIncoming) {
      this.#currentTempFile = null;
    }

    // MIX path forces normalize when duration allows (crossfade quality).
    const normalizeOn = this.#mixerEnabled || getGuildSettings(this.#guildId).normalize;
    if (!normalizeOn || !isNormalizeDurationAllowed(track)) {
      if (!forIncoming) this.#discardPrefetch();
      return createStreamSource(track, { resolveAudioStreamFn: this.#resolveAudioStream });
    }

    try {
      const prefetched = await this.#getPrefetchedOrFetch(track);
      console.info(
        `[normalize] applying: ${track.title} ` +
        `(${prefetched.measured.measured_I} LUFS -> -16 LUFS)`
      );
      if (forIncoming) {
        this.#incomingTempFile = prefetched.filePath;
      } else {
        this.#currentTempFile = prefetched.filePath;
      }
      this.#scheduleAnalysis(track, prefetched.filePath);
      return createFileSource(prefetched.filePath, { measured: prefetched.measured });
    } catch (err) {
      console.warn(`[GuildPlayer] normalize fallback for ${track.title}:`, err.message);
      return createStreamSource(track, { resolveAudioStreamFn: this.#resolveAudioStream });
    }
  }

  #scheduleAnalysis(track, filePath) {
    if (!track?.videoId || !filePath) return;
    queueMicrotask(() => {
      this.#resolveAnalysis(track, filePath).catch((err) => {
        console.warn('[GuildPlayer] analysis failed:', err.message);
      });
    });
  }

  async #resolveAnalysis(track, filePath = null) {
    if (!track) return null;
    if (track.videoId && this.#analysisCache.has(track.videoId)) {
      return this.#analysisCache.get(track.videoId);
    }
    if (track.videoId && this.#getTrackAnalysisFn) {
      const cached = await this.#getTrackAnalysisFn(track.videoId);
      if (cached) {
        this.#analysisCache.set(track.videoId, cached);
        return cached;
      }
    }
    if (!filePath || !this.#analyzeTrackFileFn) return null;
    const analysis = await this.#analyzeTrackFileFn(filePath, {
      videoId: track.videoId,
      durationSec: track.duration,
    });
    if (track.videoId) {
      this.#analysisCache.set(track.videoId, analysis);
      this.#putTrackAnalysisFn?.(track.videoId, analysis);
    }
    return analysis;
  }

  #startCrossfadeArm() {
    this.#clearCrossfadeArm();
    if (!this.#mixerEnabled) return;
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
    if (!this.#mixerEnabled || this.#crossfadeStarted || this.#mixStream?.isCrossfading) return;
    if (this.#forceSkip || this.#handlingAfter) return;
    if (this.#audioPlayer.state.status !== AudioPlayerStatus.Playing) return;

    const remaining = this.#mixStream?.remainingSec;
    if (remaining == null) return;

    const current = this.#queue.current;
    if (!current) return;
    // TRACK loop must re-arm the same track; upcoming()[0] would advance on promote.
    const next = this.#queue.loopMode === LoopMode.TRACK
      ? current
      : this.#queue.upcoming()[0];
    if (!next) return;

    const outAnalysis = await this.#resolveAnalysis(current);
    const inAnalysis = await this.#resolveAnalysis(next);
    const plan = planTransition(outAnalysis, inAnalysis);
    if (plan.mode === 'gapless' || !(plan.fadeSec > 0)) return;
    if (remaining > plan.fadeSec + 0.2) return;

    this.#crossfadeStarted = true;
    this.#crossfadeTargetTrack = next;
    let source;
    try {
      source = await this.#createPcmSource(next, { forIncoming: true });
    } catch (err) {
      console.warn('[GuildPlayer] incoming pcm source failed:', err.message);
      this.#crossfadeStarted = false;
      this.#crossfadeTargetTrack = null;
      await this.#cleanupIncomingTempFile();
      return;
    }

    if (this.#queue.current !== current || this.#forceSkip) {
      source.destroy();
      await this.#cleanupIncomingTempFile();
      this.#crossfadeStarted = false;
      this.#crossfadeTargetTrack = null;
      return;
    }

    const started = this.#mixStream.startCrossfade(source, plan);
    if (!started) {
      source.destroy();
      await this.#cleanupIncomingTempFile();
      this.#crossfadeStarted = false;
      this.#crossfadeTargetTrack = null;
    }
  }

  async #cleanupIncomingTempFile() {
    const filePath = this.#incomingTempFile;
    this.#incomingTempFile = null;
    if (filePath) {
      await cleanupTempFile(filePath);
    }
  }

  #createFallbackResource(track) {
    const stream = this.#resolveAudioStream(track.webpageUrl);
    return this.#createAudioResource(stream, {
      inputType: StreamType.Arbitrary,
    });
  }

  async #createResource(track) {
    this.#currentTempFile = null;

    if (!getGuildSettings(this.#guildId).normalize || !isNormalizeDurationAllowed(track)) {
      this.#discardPrefetch();
      return this.#createFallbackResource(track);
    }

    try {
      const prefetched = await this.#getPrefetchedOrFetch(track);

      console.info(
        `[normalize] applying: ${track.title} ` +
        `(${prefetched.measured.measured_I} LUFS -> -16 LUFS)`
      );

      this.#currentTempFile = prefetched.filePath;
      return createNormalizedResource(prefetched.filePath, prefetched.measured);
    } catch (err) {
      console.warn(`[GuildPlayer] normalize fallback for ${track.title}:`, err);
      return this.#createFallbackResource(track);
    }
  }

  async #getPrefetchedOrFetch(track) {
    if (this.#prefetchTrack === track && this.#prefetchPromise) {
      const promise = this.#prefetchPromise;
      this.#prefetchTrack = null;
      this.#prefetchPromise = null;
      const result = await promise;
      if (result.error) throw result.error;
      return result.value;
    }

    this.#discardPrefetch(track);
    return prefetchTrack(track);
  }

  #prefetchUpcoming() {
    // Mixer path always prefers normalize prefetch so crossfade can use files.
    if (!this.#mixerEnabled && !getGuildSettings(this.#guildId).normalize) {
      this.#discardPrefetch();
      return;
    }

    const [track] = this.#queue.upcoming();
    if (!track || !isNormalizeDurationAllowed(track)) {
      this.#discardPrefetch();
      return;
    }

    if (this.#prefetchTrack === track) return;

    this.#discardPrefetch(track);
    this.#prefetchTrack = track;
    this.#prefetchPromise = prefetchTrack(track).then(
      value => ({ value }),
      error => ({ error })
    );
  }

  #discardPrefetch(keepTrack = null) {
    if (!this.#prefetchPromise || this.#prefetchTrack === keepTrack) return;

    const promise = this.#prefetchPromise;
    this.#prefetchTrack = null;
    this.#prefetchPromise = null;
    promise.then(result => {
      if (result.value?.filePath) {
        cleanupTempFile(result.value.filePath).catch(err => {
          console.error('[GuildPlayer] prefetch cleanup error:', err);
        });
      }
    });
  }

  async #discardStaleResource(resource) {
    if (this.#currentResource === resource) {
      this.#currentResource = null;
    }
    resource.playStream.destroy();
    await this.#cleanupCurrentTempFile();
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
    if (this.#mixerEnabled) {
      this.#watchdogTimer = setInterval(() => {
        // Pause/unpause stops Discord from pulling frames, which freezes
        // lastDataAt as the PCM buffer fills — same guard as the legacy path.
        if (this.#audioPlayer.state.status !== AudioPlayerStatus.Playing) return;
        const source = this.#mixStream?.currentSource;
        if (!source) return;
        if (Date.now() - source.lastDataAt > WATCHDOG_STALL_THRESHOLD) {
          console.warn('[GuildPlayer] watchdog: mixer stall detected');
          this.#hadError = true;
          this.#mixStream.dropCurrent();
        }
      }, WATCHDOG_INTERVAL);
      return;
    }

    let lastPlaybackDuration = 0;
    this.#watchdogTimer = setInterval(() => {
      const state = this.#audioPlayer.state;
      if (state.status !== AudioPlayerStatus.Playing) return;

      const duration = state.playbackDuration ?? 0;
      if (duration > lastPlaybackDuration) {
        lastPlaybackDuration = duration;
        this.#lastActiveAt = Date.now();
      } else if (Date.now() - this.#lastActiveAt > WATCHDOG_STALL_THRESHOLD) {
        console.warn('[GuildPlayer] watchdog: stall detected, stopping player');
        this.#hadError = true;
        this.#audioPlayer.stop();
      }
    }, WATCHDOG_INTERVAL);
  }

  #clearWatchdog() {
    if (this.#watchdogTimer !== null) {
      clearInterval(this.#watchdogTimer);
      this.#watchdogTimer = null;
    }
  }
}

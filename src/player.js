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

const RECONNECT_GRACE = 5000;
const WATCHDOG_INTERVAL = 10_000;
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

  constructor({
    guildId,
    connection,
    queue,
    onDisconnect,
    handleQueueExhausted = null,
    queueExhaustedTimeoutMs = QUEUE_EXHAUSTED_TIMEOUT,
    recordPlayFn = null,
    audioPlayer = createAudioPlayer(),
    createAudioResourceFn = createAudioResource,
    resolveAudioStreamFn = resolveAudioStream,
  }) {
    this.#guildId = guildId;
    this.#connection = connection;
    this.#queue = queue;
    this.#onDisconnect = onDisconnect;
    this.#handleQueueExhausted = handleQueueExhausted;
    this.#queueExhaustedTimeoutMs = queueExhaustedTimeoutMs;
    this.#recordPlayFn = recordPlayFn;
    this.#audioPlayer = audioPlayer;
    this.#createAudioResource = createAudioResourceFn;
    this.#resolveAudioStream = resolveAudioStreamFn;

    this.#audioPlayer.on(AudioPlayerStatus.Idle, () => {
      this.#advanceAfterPlayback();
    });

    this.#audioPlayer.on('stateChange', (oldState, newState) => {
      if (newState.status === AudioPlayerStatus.Playing) {
        this.#lastActiveAt = Date.now();
      }
    });

    this.#audioPlayer.on('error', err => {
      console.error('[GuildPlayer] audioPlayer error:', err);
      this.#hadError = true;
      const failedTrack = this.#queue.current;

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
    this.#audioPlayer.stop();
  }

  async stop() {
    this.#queue.clear();
    this.#audioPlayer.stop();
    this.#currentResource = null;
    this.#clearWatchdog();
    await this.#cleanupCurrentTempFile();
    this.#discardPrefetch();
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
    await this.#cleanupCurrentTempFile();

    if (this.#forceSkip) {
      this.#forceSkip = false;
      this.#queue.next({ forceAdvance: true });
      await this.playNext();
      return;
    }

    const elapsed = Date.now() - this.#playbackStart;
    const track = this.#queue.current;
    const isShortTrack = track?.duration != null && track.duration < 5;

    if (elapsed < RECONNECT_GRACE && !isShortTrack && !this.#hadError) {
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
    if (!getGuildSettings(this.#guildId).normalize) {
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

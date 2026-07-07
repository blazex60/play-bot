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

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export class GuildPlayer {
  #guildId;
  #connection;
  #queue;
  #onDisconnect;
  #audioPlayer;
  #forceSkip = false;
  #hadError = false;
  #playbackStart = 0;
  #lastActiveAt = 0;
  #watchdogTimer = null;
  #currentTempFile = null;
  #prefetchTrack = null;
  #prefetchPromise = null;

  constructor({ guildId, connection, queue, onDisconnect }) {
    this.#guildId = guildId;
    this.#connection = connection;
    this.#queue = queue;
    this.#onDisconnect = onDisconnect;
    this.#audioPlayer = createAudioPlayer();

    this.#audioPlayer.on(AudioPlayerStatus.Idle, () => {
      this.#handleAfter().catch(err => {
        console.error('[GuildPlayer] handleAfter error:', err);
      });
    });

    this.#audioPlayer.on('stateChange', (oldState, newState) => {
      if (newState.status === AudioPlayerStatus.Playing) {
        this.#lastActiveAt = Date.now();
      }
    });

    this.#audioPlayer.on('error', err => {
      console.error('[GuildPlayer] audioPlayer error:', err);
      this.#hadError = true;
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

    this.#audioPlayer.play(resource);
    this.#prefetchUpcoming();
  }

  pause() {
    return this.#audioPlayer.pause();
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
    this.#clearWatchdog();
    await this.#cleanupCurrentTempFile();
    this.#discardPrefetch();
  }

  async #handleAfter() {
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

    const shouldForceAdvance = this.#hadError;
    this.#hadError = false;
    const nextTrack = this.#queue.next({ forceAdvance: shouldForceAdvance });
    if (nextTrack === null) {
      this.#clearWatchdog();
      await this.#onDisconnect();
    } else {
      await this.playNext();
    }
  }

  #createFallbackResource(track) {
    const stream = resolveAudioStream(track.webpageUrl);
    return createAudioResource(stream, {
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

import { AudioPlayerStatus } from '@discordjs/voice';

const DEFAULT_INTERVAL_MS = 10_000;
const DEFAULT_STALL_THRESHOLD_MS = 30_000;

/**
 * Detects playback stalls: frames keep being produced but the voice
 * connection's `playbackDuration` stops advancing. Polls the AudioPlayer
 * state on an interval; when the duration hasn't grown for
 * `stallThresholdMs` (measured against the last activity timestamp the owner
 * maintains), it fires `onStall` — the owner decides how to recover
 * (GuildPlayer drops the current source and flags the error).
 *
 * Extracted from GuildPlayer's #resetWatchdog/#clearWatchdog so the player
 * doesn't own the polling loop itself.
 */
export class PlaybackWatchdog {
  #getAudioPlayerState;
  #getLastActiveAt;
  #markActive;
  #onStall;
  #intervalMs;
  #stallThresholdMs;
  #timer = null;

  constructor({
    getAudioPlayerState,
    getLastActiveAt,
    markActive,
    onStall,
    intervalMs = DEFAULT_INTERVAL_MS,
    stallThresholdMs = DEFAULT_STALL_THRESHOLD_MS,
  }) {
    this.#getAudioPlayerState = getAudioPlayerState;
    this.#getLastActiveAt = getLastActiveAt;
    this.#markActive = markActive;
    this.#onStall = onStall;
    this.#intervalMs = intervalMs;
    this.#stallThresholdMs = stallThresholdMs;
  }

  get running() {
    return this.#timer !== null;
  }

  start() {
    this.stop();
    // Discord playbackDuration progress detects stalls where frames are produced
    // but the voice connection stops advancing. Producer lastDataAt freezes on
    // pause while PCM still buffers, so it is not used as the stall signal.
    let lastPlaybackDuration = 0;
    this.#timer = setInterval(() => {
      const state = this.#getAudioPlayerState();
      if (state.status !== AudioPlayerStatus.Playing) return;

      const duration = state.playbackDuration ?? 0;
      if (duration > lastPlaybackDuration) {
        lastPlaybackDuration = duration;
        this.#markActive();
        return;
      }

      if (Date.now() - this.#getLastActiveAt() <= this.#stallThresholdMs) return;

      this.#onStall();
    }, this.#intervalMs);
  }

  stop() {
    if (this.#timer !== null) {
      clearInterval(this.#timer);
      this.#timer = null;
    }
  }
}

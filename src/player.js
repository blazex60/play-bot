import {
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  StreamType,

} from '@discordjs/voice';
import { resolveAudioStream } from './search.js';
import { LoopMode } from './queue.js';

const RECONNECT_GRACE = 5000;
const WATCHDOG_INTERVAL = 10_000;
const WATCHDOG_STALL_THRESHOLD = 30_000;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export class GuildPlayer {
  #connection;
  #queue;
  #onDisconnect;
  #audioPlayer;
  #currentResource = null;
  #volume = 1.0;
  #forceSkip = false;
  #hadError = false;
  #playbackStart = 0;
  #lastActiveAt = 0;
  #watchdogTimer = null;

  constructor({ connection, queue, onDisconnect }) {
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

    const stream = resolveAudioStream(track.webpageUrl);

    const resource = createAudioResource(stream, {
      inputType: StreamType.Arbitrary,
      inlineVolume: true,
    });
    resource.volume.setVolume(this.#volume);

    this.#currentResource = resource;
    this.#playbackStart = Date.now();
    this.#lastActiveAt = Date.now();

    this.#resetWatchdog();

    this.#audioPlayer.play(resource);
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
  }

  setVolume(level) {
    this.#volume = level;
    if (this.#currentResource?.volume) {
      this.#currentResource.volume.setVolume(level);
    }
  }

  async #handleAfter() {
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

    this.#hadError = false;
    const nextTrack = this.#queue.next({ forceAdvance: false });
    if (nextTrack === null) {
      this.#clearWatchdog();
      await this.#onDisconnect();
    } else {
      await this.playNext();
    }
  }

  #resetWatchdog() {
    this.#clearWatchdog();
    this.#watchdogTimer = setInterval(() => {
      if (
        this.#audioPlayer.state.status === AudioPlayerStatus.Playing &&
        Date.now() - this.#lastActiveAt > WATCHDOG_STALL_THRESHOLD
      ) {
        console.warn('[GuildPlayer] watchdog: stall detected, stopping player');
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

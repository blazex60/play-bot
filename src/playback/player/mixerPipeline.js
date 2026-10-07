import { StreamType } from '@discordjs/voice';
import { MixStream } from '../../audio/mixStream.js';

/** How long GuildPlayer waits for ffmpeg/yt-dlp to produce the first PCM. */
export const PCM_WAIT_TIMEOUT_MS = 15_000;

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

/**
 * Owns the audio-output pipeline behind GuildPlayer: the session-lived
 * MixStream, the single Raw opus AudioResource attach/rebuild lifecycle, the
 * "wait for the first PCM" machinery (source 'data'/'end'/'error' listeners
 * plus a generation-based abort and timeout), and the dead-mixer recovery
 * paths. Extracted from player.js so the player concentrates on the
 * advancement loop. mixStream/mixerStarted/mixerResource are plain public
 * fields because the player and the other coordinators legitimately read
 * them (same convention as AnalysisCoordinator's shared caches); the
 * advancement-loop entry points (#advanceAfterPlayback/#onCrossfadePromoted/
 * #onSnapHandoff/playNext) and the queues/flags they consult stay in the
 * player and reach here through injected callbacks.
 *
 * @param {{
 *   audioPlayer: object,
 *   connection: object,
 *   createAudioResourceFn: Function,
 *   pcmWaitTimeoutMs: number,
 *   pauseSource: object,  // the GuildPlayer instance — pause-source key for the shared analysis/stem queues' noteUnderrun accounting
 *   getQueueCurrent: () => object | null,
 *   isHandlingAfter: () => boolean,
 *   isForceSkip: () => boolean,
 *   markHadError: () => void,
 *   advanceAfterPlayback: () => void,
 *   onCrossfadePromoted: () => void,
 *   onSnapHandoff: (adopt: Function) => Promise<void>,
 *   onIncomingError: (err: Error) => void,
 *   playNext: () => Promise<void>,
 *   getAnalysisQueue: () => object,
 *   getStemQueue: () => object,
 * }} deps
 */
export class MixerPipeline {
  /** Session-lived PCM mixer; rebuilt whenever the resource/stream dies. */
  mixStream = null;
  mixerResource = null;
  mixerStarted = false;
  /** Prevents Idle recovery from stacking playNext() while a restart is in flight. */
  idleRecovering = false;
  cancelSourceAudioWait = null;
  pcmWaitGeneration = 0;

  #audioPlayer;
  #connection;
  #createAudioResource;
  #pcmWaitTimeoutMs;
  #pauseSource;
  #getQueueCurrent;
  #isHandlingAfter;
  #isForceSkip;
  #markHadError;
  #advanceAfterPlayback;
  #onCrossfadePromoted;
  #onSnapHandoff;
  #onIncomingError;
  #playNext;
  #getAnalysisQueue;
  #getStemQueue;

  constructor({
    audioPlayer,
    connection,
    createAudioResourceFn,
    pcmWaitTimeoutMs = PCM_WAIT_TIMEOUT_MS,
    pauseSource,
    getQueueCurrent,
    isHandlingAfter,
    isForceSkip,
    markHadError,
    advanceAfterPlayback,
    onCrossfadePromoted,
    onSnapHandoff,
    onIncomingError,
    playNext,
    getAnalysisQueue,
    getStemQueue,
  }) {
    this.#audioPlayer = audioPlayer;
    this.#connection = connection;
    this.#createAudioResource = createAudioResourceFn;
    this.#pcmWaitTimeoutMs = Number.isFinite(pcmWaitTimeoutMs)
      ? pcmWaitTimeoutMs
      : PCM_WAIT_TIMEOUT_MS;
    this.#pauseSource = pauseSource;
    this.#getQueueCurrent = getQueueCurrent;
    this.#isHandlingAfter = isHandlingAfter;
    this.#isForceSkip = isForceSkip;
    this.#markHadError = markHadError;
    this.#advanceAfterPlayback = advanceAfterPlayback;
    this.#onCrossfadePromoted = onCrossfadePromoted;
    this.#onSnapHandoff = onSnapHandoff;
    this.#onIncomingError = onIncomingError;
    this.#playNext = playNext;
    this.#getAnalysisQueue = getAnalysisQueue;
    this.#getStemQueue = getStemQueue;
  }

  initMixerPipeline() {
    this.mixStream = new MixStream();
    this.mixerResource = null;
    this.mixerStarted = false;
    this.mixStream.on('trackend', (info) => {
      if (info?.promoted) {
        this.#onCrossfadePromoted();
        return;
      }
      this.#advanceAfterPlayback();
    });
    this.mixStream.on('sourceerror', (err) => {
      console.error('[GuildPlayer] mix source error:', err.message);
      this.#markHadError();
      this.abortSourceAudioWait();
      this.mixStream.dropCurrent();
      // Codex review (PR #45, P1): see the audioPlayer 'error' handler's
      // identical comment above — dropCurrent() here has the same silent
      // underrun-state reset.
      this.#getStemQueue().noteUnderrunCleared(this.#pauseSource);
    });
    this.mixStream.on('incomingerror', (err) => {
      this.#onIncomingError(err);
    });
    this.mixStream.on('snaphandoff', ({ adopt }) => {
      this.#onSnapHandoff(adopt).catch((err) => {
        console.warn('[GuildPlayer] snap handoff failed:', err.message);
      });
    });
    this.mixStream.on('underrun', () => {
      this.#getAnalysisQueue().noteUnderrun(this.#pauseSource);
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
      this.#getStemQueue().noteUnderrun(this.#pauseSource);
    });
    this.mixStream.on('underrunClear', () => {
      this.#getAnalysisQueue().noteUnderrunCleared(this.#pauseSource);
      this.#getStemQueue().noteUnderrunCleared(this.#pauseSource);
    });
    // MixStream extends Node's Readable. @discordjs/voice's
    // createAudioResource() pipes it into an Opus encoder internally via
    // stream.pipeline(); if that pipeline ever tears down abnormally (e.g.
    // ERR_STREAM_PREMATURE_CLOSE when the encoder side closes early), Node
    // calls destroy(err) on mixStream too, which emits the standard 'error'
    // event. An EventEmitter emitting 'error' with no listener throws
    // synchronously — crashing the whole bot process, not just this guild's
    // playback (unlike sourceerror/incomingerror, which are this module's
    // own recoverable signals). Same recovery shape as the Idle handler
    // above: rebuild the mixer pipeline and restart the current track.
    this.mixStream.on('error', (err) => {
      console.error('[GuildPlayer] mixStream error:', err);
      if (this.idleRecovering) return;
      this.idleRecovering = true;
      this.#markHadError();
      this.abortSourceAudioWait();
      this.#getStemQueue().noteUnderrunCleared(this.#pauseSource);
      this.recoverMixerPlayback({ play: false });
      const restartCurrent = this.#getQueueCurrent() && !this.#isHandlingAfter() && !this.#isForceSkip();
      const done = () => { this.idleRecovering = false; };
      if (restartCurrent) {
        this.#playNext().catch((restartErr) => {
          console.error('[GuildPlayer] mixStream error recovery restart failed:', restartErr.message);
        }).finally(done);
      } else {
        done();
      }
    });
  }

  #isMixerStreamDead() {
    return !this.mixStream
      || this.mixStream.isDestroyed()
      || this.mixStream.destroyed;
  }

  isMixerDead() {
    return this.#isMixerStreamDead() || this.mixerResource?.ended === true;
  }

  #attachMixerResource() {
    this.mixerResource = this.#createAudioResource(
      this.mixStream,
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

  isSourceAudioWaitSuperseded(track, waited, waitGeneration) {
    return waited === 'aborted'
      || waitGeneration !== this.pcmWaitGeneration
      || this.#getQueueCurrent() !== track
      || this.#isForceSkip();
  }

  discardUnusedSource(source) {
    if (!source) return;
    if (this.mixStream?.currentSource === source) return;
    source.destroy?.();
  }

  abortSourceAudioWait() {
    this.pcmWaitGeneration += 1;
    const cancel = this.cancelSourceAudioWait;
    this.cancelSourceAudioWait = null;
    cancel?.();
  }

  waitForSourceAudio(source) {
    this.cancelSourceAudioWait?.();
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
        if (this.cancelSourceAudioWait === cancel) {
          this.cancelSourceAudioWait = null;
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
      this.cancelSourceAudioWait = cancel;
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
  recoverMixerPlayback({ play = false } = {}) {
    if (this.isMixerDead()) {
      console.warn('[GuildPlayer] mixer resource ended; rebuilding pipeline');
      try {
        this.mixStream?.removeAllListeners();
        if (this.mixStream && !this.mixStream.destroyed) {
          this.mixStream.destroy();
        }
      } catch {
        // already destroyed
      }
      this.initMixerPipeline();
    }
    this.mixerStarted = false;
    if (play) this.ensureMixerPlaying();
  }

  ensureMixerPlaying() {
    if (this.#isMixerStreamDead()) {
      this.recoverMixerPlayback({ play: false });
    }
    if (this.#isMixerStreamDead()) return;
    const hasSource = Boolean(this.mixStream.currentSource) || this.mixStream.isCrossfading;
    if (!this.mixerResource || this.mixerResource.ended) {
      if (!hasSource) return;
      this.#attachMixerResource();
    }
    try {
      this.#connection?.subscribe?.(this.#audioPlayer);
      this.#audioPlayer.play(this.mixerResource);
      this.mixerStarted = true;
    } catch (err) {
      console.error('[GuildPlayer] mixer play failed, rebuilding:', err.message);
      this.recoverMixerPlayback({ play: false });
      if (this.#isMixerStreamDead() || !this.mixStream.currentSource) return;
      this.#attachMixerResource();
      try {
        this.#connection?.subscribe?.(this.#audioPlayer);
        this.#audioPlayer.play(this.mixerResource);
        this.mixerStarted = true;
      } catch (err2) {
        console.error('[GuildPlayer] mixer recovery rebuild play failed:', err2.message);
      }
    }
  }
}

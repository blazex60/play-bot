import { shouldReconnectRetry } from './playbackPolicy.js';
import { LoopMode } from '../queue.js';

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Owns the after-playback advancement loop behind GuildPlayer: the
 * serialized handleAfter drain (trackend → queue advance → playNext, with
 * force-skip ordering, the reconnect-retry grace, and the #hadError
 * save-before-next bookkeeping), the queueExhausted handler invocation
 * with its timeout, and the deduped refill machinery (the queueRefill
 * single-attempt lock, the early #maybeRefillQueue trigger). Extracted
 * from player.js so the player concentrates on playback orchestration;
 * the bookkeeping the player's own paths still read/write
 * (handlingAfter/pendingAfter/playbackCount/queueRefill) is exposed as
 * plain public fields, same convention as TransitionCoordinator's shared
 * state and AnalysisCoordinator's shared caches.
 *
 * @param {{
 *   queue: import('../queue.js').GuildQueue,
 *   handleQueueExhausted: ((track: object) => Promise<boolean|null>) | null,
 *   queueExhaustedTimeoutMs: number,
 *   transitions: import('./transitionCoordinator.js').TransitionCoordinator,
 *   sourcePreparer: import('./sourcePreparer.js').SourcePreparer,
 *   playNext: (gaplessFrom?: object | null) => Promise<void>,
 *   disconnect: () => Promise<void>,
 *   cleanupCurrentTempFile: () => Promise<void>,
 *   clearWatchdog: () => void,
 *   isForceSkip: () => boolean,
 *   clearForceSkip: () => void,
 *   isHadError: () => boolean,
 *   clearHadError: () => void,
 *   getPlaybackStart: () => number,
 * }} deps
 */
export class QueueAdvancement {
  /**
   * True while the handleAfter drain owns advancement. Read by the
   * player's #playNextMixer error fallbacks, #onSnapHandoff, seekTo, and
   * the Idle-recovery restart, and by MixerPipeline's isHandlingAfter
   * thunk, all to avoid double-advancing the queue.
   */
  handlingAfter = false;
  handlingAfterPlayback = 0;
  pendingAfter = false;
  /**
   * Monotonic playback-instance counter, incremented by the player's three
   * track-start paths (#playNextMixer/#onSnapHandoff/#onCrossfadePromoted)
   * — NOT a track counter, so a TRACK-loop replay counts as a new
   * instance (see advanceAfterPlayback's own comment).
   */
  playbackCount = 0;
  /** @type {{ key: *, promise: Promise<boolean|null> } | null} */
  queueRefill = null;
  #queue;
  #handleQueueExhausted;
  #queueExhaustedTimeoutMs;
  #transitions;
  #sourcePreparer;
  #playNext;
  #disconnect;
  #cleanupCurrentTempFile;
  #clearWatchdog;
  #isForceSkip;
  #clearForceSkip;
  #isHadError;
  #clearHadError;
  #getPlaybackStart;

  constructor({
    queue,
    handleQueueExhausted,
    queueExhaustedTimeoutMs,
    transitions,
    sourcePreparer,
    playNext,
    disconnect,
    cleanupCurrentTempFile,
    clearWatchdog,
    isForceSkip,
    clearForceSkip,
    isHadError,
    clearHadError,
    getPlaybackStart,
  }) {
    this.#queue = queue;
    this.#handleQueueExhausted = handleQueueExhausted;
    this.#queueExhaustedTimeoutMs = queueExhaustedTimeoutMs;
    this.#transitions = transitions;
    this.#sourcePreparer = sourcePreparer;
    this.#playNext = playNext;
    this.#disconnect = disconnect;
    this.#cleanupCurrentTempFile = cleanupCurrentTempFile;
    this.#clearWatchdog = clearWatchdog;
    this.#isForceSkip = isForceSkip;
    this.#clearForceSkip = clearForceSkip;
    this.#isHadError = isHadError;
    this.#clearHadError = clearHadError;
    this.#getPlaybackStart = getPlaybackStart;
  }

  advanceAfterPlayback() {
    if (this.handlingAfter) {
      // A newly started track can fail while an exhausted-queue continuation
      // is still planning. Preserve that transition so it is handled after
      // the active handoff, but ignore duplicate events from the playback it
      // is already handling. Comparing playback instances (rather than tracks)
      // also preserves an error from a TRACK-loop replay of the same track.
      if (this.playbackCount !== this.handlingAfterPlayback) {
        this.pendingAfter = true;
      }
      return;
    }
    this.handlingAfter = true;
    this.#drainAfterPlayback()
      .catch(err => {
        console.error('[GuildPlayer] handleAfter error:', err);
      })
      .finally(() => {
        this.handlingAfter = false;
        this.handlingAfterPlayback = 0;
      });
  }

  async #drainAfterPlayback() {
    do {
      this.pendingAfter = false;
      this.handlingAfterPlayback = this.playbackCount;
      await this.#handleAfter();
    } while (this.pendingAfter);
  }

  async #handleAfter() {
    this.#transitions.clearCrossfadeArm();
    // Same reasoning as #onCrossfadePromoted()'s reset (Codex): a natural,
    // non-crossfade track end (no fallback was even eligible for the
    // failed pair) must also release the marker once that pair's attempt
    // has concluded, not just the crossfade-promotion path.
    this.#transitions.stemMixUnavailableKey = null;
    await this.#cleanupCurrentTempFile();

    const upcomingBeforeAdvance = this.#queue.loopMode === LoopMode.TRACK
      ? this.#queue.current
      : this.#queue.upcoming()[0];
    const preserveIncoming = upcomingBeforeAdvance
      && this.#sourcePreparer.preparedIncoming?.track === upcomingBeforeAdvance;
    if (!preserveIncoming) {
      this.#sourcePreparer.clearPreparedIncoming();
      await this.#sourcePreparer.cleanupIncomingTempFile();
    }

    if (this.#isForceSkip()) {
      this.#clearForceSkip();
      this.#queue.next({ forceAdvance: true });
      await this.#playNext();
      return;
    }

    const elapsed = Date.now() - this.#getPlaybackStart();
    const track = this.#queue.current;

    if (shouldReconnectRetry({ elapsedMs: elapsed, track, hadError: this.#isHadError() })) {
      await sleep(2000);
      await this.#playNext();
      return;
    }

    const finishedTrack = track;
    const shouldForceAdvance = this.#isHadError();
    this.#clearHadError();
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
        this.#transitions.pendingGaplessFrom = { track: finishedTrack, setAt: Date.now() };
      }
      const handled = await this.#startQueueRefill(finishedTrack);
      // null = another round already owns the autoplay lock; do not disconnect.
      if (handled !== false) return;
      this.#transitions.pendingGaplessFrom = null;
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
      await this.#playNext(shouldForceAdvance ? null : finishedTrack);
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

  queueRefillKey(track) {
    return track?.videoId || track?.webpageUrl || track || null;
  }

  #startQueueRefill(track) {
    const key = this.queueRefillKey(track);
    if (this.queueRefill?.key === key) return this.queueRefill.promise;
    const promise = this.#tryHandleQueueExhausted(track);
    this.queueRefill = { key, promise };
    return promise;
  }

  maybeRefillQueue() {
    if (this.#queue.loopMode === LoopMode.TRACK) return;
    if (this.#queue.upcoming().length > 0) return;
    if (!this.#handleQueueExhausted) return;
    const current = this.#queue.current;
    if (!current) return;
    if (this.queueRefill?.key === this.queueRefillKey(current)) return;
    this.#startQueueRefill(current)
      .then((handled) => {
        if (handled) this.#sourcePreparer.prefetchUpcoming();
      })
      .catch((err) => {
        console.warn('[GuildPlayer] early queue refill failed:', err.message);
      });
  }
}

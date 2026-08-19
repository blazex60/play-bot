import { Readable } from 'node:stream';
import {
  FRAME_BYTES,
  FRAME_MS,
  BYTES_PER_SECOND,
  gainForPosition,
  mixFrames,
  scaleFrame,
  softLimitFrame,
  blendFrame,
} from './fade.js';
import {
  createOutgoingBaseSwapProcessor,
  createIncomingBaseSwapProcessor,
} from './eq.js';
import { MAX_UNDERRUN_MS } from './config.js';

const SILENCE_FRAME = Buffer.alloc(FRAME_BYTES);

function clamp01(n) {
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

/**
 * Phase 7 §11.1: for a `mode: 'beatmix'` plan, the bass-swap EQ ramps in over
 * `eq.swapBar` bars instead of applying instantly for the whole crossfade
 * (the doc's diagram — A/B LOW% cross over gradually, not switched at bar 1).
 * `sync.beatsPerBar` and `targetBpm` (the session tempo both sides play the
 * overlap at) give the real bar length; any other mode (plain crossfade,
 * phrase-crossfade) keeps the existing instant on/off EQ, so this returns
 * null for them.
 * @returns {number|null} ramp duration in seconds, or null for "apply fully".
 */
function computeEqRampSec(plan) {
  if (plan.mode !== 'beatmix') return null;
  const targetBpm = plan.targetBpm;
  const beatsPerBar = plan.sync?.beatsPerBar;
  const swapBar = plan.eq?.swapBar;
  if (!(targetBpm > 0) || !(beatsPerBar > 0) || !(swapBar > 0)) return null;
  const barSec = (60 / targetBpm) * beatsPerBar;
  return barSec > 0 ? barSec * swapBar : null;
}

export class MixStream extends Readable {
  #current = null;
  #incoming = null;
  #consumedBytes = 0;
  #durationSec = null;
  #underrunSince = null;
  #pendingRead = false;
  #destroyed = false;
  #betweenTracks = false;
  #crossfade = null;
  #fadeElapsedSec = 0;
  #outEq = null;
  #inEq = null;
  /** @type {WeakMap<object, Buffer>} partial PCM kept across underruns per source */
  #pendingExact = new WeakMap();
  /** Held partner frame when only one side of a crossfade frame is ready */
  #heldOutFrame = null;
  #heldInFrame = null;
  #incomingSkipSec = 0;
  #incomingSkippedSec = 0;

  constructor() {
    super();
  }

  get positionSec() {
    return this.#consumedBytes / BYTES_PER_SECOND;
  }

  get remainingSec() {
    if (this.#durationSec == null) return null;
    return Math.max(0, this.#durationSec - this.positionSec);
  }

  get currentSource() {
    return this.#current;
  }

  get isCrossfading() {
    return this.#crossfade != null;
  }

  /** True after `endMixer()` / `_destroy()`. Distinct from Node's `.destroyed`. */
  isDestroyed() {
    return this.#destroyed;
  }

  setDurationSec(durationSec) {
    this.#durationSec = durationSec;
  }

  /**
   * @param {object} source
   * @param {{ durationSec?: number|null }} [options]
   * @returns {boolean}
   */
  setCurrent(source, { durationSec = null } = {}) {
    if (this.#destroyed) {
      source.destroy();
      return false;
    }

    this.#clearIncoming();
    if (this.#current) {
      this.#current.removeAllListeners();
      this.#current.destroy();
    }

    if (source.error) {
      source.destroy();
      this.#current = null;
      this.#betweenTracks = true;
      this.#underrunSince = null;
      this.emit('sourceerror', source.error);
      return false;
    }

    this.#current = source;
    this.#consumedBytes = 0;
    this.#durationSec = durationSec;
    this.#underrunSince = null;
    this.#betweenTracks = false;
    this.#crossfade = null;
    this.#fadeElapsedSec = 0;
    this.#outEq = null;
    this.#inEq = null;
    this.#heldOutFrame = null;
    this.#heldInFrame = null;
    this.#incomingSkipSec = 0;
    this.#incomingSkippedSec = 0;

    source.on('data', () => this.#scheduleRead());
    source.on('end', () => this.#scheduleRead());
    source.on('error', (err) => {
      // Consumer (GuildPlayer) dropCurrent/advances; do not finishCurrent here —
      // that would race snaphandoff against the error handoff.
      this.emit('sourceerror', err);
    });

    this.#wakeConsumer();
    return true;
  }

  /**
   * Begin overlapping the current track with an incoming source.
   * @param {object} source
   * @param {{ fadeSec: number, curve?: string, baseSwap?: boolean, highpassHz?: number, lowshelfGainDb?: number, mode?: string, incomingOffsetSec?: number }} plan
   */
  startCrossfade(source, plan) {
    if (this.#destroyed || !this.#current || this.#crossfade) {
      source?.destroy?.();
      return false;
    }
    if (!plan?.fadeSec || plan.fadeSec <= 0) {
      source?.destroy?.();
      return false;
    }
    if (source.error) {
      // Incoming arming failure is recoverable — keep the outgoing track.
      source.destroy();
      this.emit('incomingerror', source.error);
      return false;
    }

    const mode = plan.mode === 'tail-fade' ? 'tail-fade' : 'crossfade';
    this.#incoming = source;
    this.#crossfade = {
      fadeSec: plan.fadeSec,
      curve: plan.curve ?? 'equal-power',
      baseSwap: plan.baseSwap === true && mode !== 'tail-fade',
      mode,
      eqRampSec: computeEqRampSec(plan),
      // plan.mode itself collapses to 'crossfade' in #crossfade.mode above
      // (MixStream doesn't otherwise distinguish beatmix from a plain
      // crossfade) — remembered separately so a later stall-cancel decision
      // (Codex round-6) still knows this attempt was originally beat-synced
      // even after eqRampSec has already been neutralized by an earlier stall.
      isBeatmix: plan.mode === 'beatmix',
    };
    this.#fadeElapsedSec = 0;
    this.#incomingSkipSec = mode === 'tail-fade' ? 0 : Math.max(0, plan.incomingOffsetSec ?? 0);
    this.#incomingSkippedSec = 0;
    this.#outEq = this.#crossfade.baseSwap
      ? createOutgoingBaseSwapProcessor(48000, plan.highpassHz ?? 120)
      : null;
    this.#inEq = this.#crossfade.baseSwap
      ? createIncomingBaseSwapProcessor(48000, plan.highpassHz ?? 120, plan.lowshelfGainDb ?? 2)
      : null;

    source.on('data', () => this.#scheduleRead());
    source.on('end', () => this.#scheduleRead());
    source.on('error', (err) => {
      // Cancel overlap only; do not emit sourceerror (that aborts outgoing).
      this.emit('incomingerror', err);
      this.#clearIncoming();
    });

    this.#wakeConsumer();
    this.emit('crossfadestart', plan);
    return true;
  }

  dropCurrent() {
    if (this.#current) {
      this.#current.removeAllListeners();
      this.#current.destroy();
      this.#current = null;
    }
    this.#clearIncoming();
    this.#betweenTracks = true;
    this.#underrunSince = null;
    this.#crossfade = null;
    this.emit('trackend');
    this.#wakeConsumer();
  }

  endMixer() {
    if (this.#destroyed) return;
    this.#destroyed = true;
    this.#current?.destroy();
    this.#incoming?.destroy();
    this.#current = null;
    this.#incoming = null;
    this.push(null);
  }

  _read() {
    this.#pendingRead = true;
    this.#tryPushFrame();
  }

  #unpauseIfNeeded() {
    // createAudioResource(StreamType.Raw) pipelines MixStream into an opus
    // encoder, which is flowing-mode — not paused reads. pause() here used
    // to stop that pipeline after one between-tracks silence frame, so the
    // next setCurrent never delivered PCM (Discord showed speaking from the
    // leftover packets, but the track itself never played).
    if (this.isPaused()) this.resume();
  }

  #wakeConsumer() {
    this.#unpauseIfNeeded();
    this.#scheduleRead();
  }

  #scheduleRead() {
    if (this.#pendingRead) {
      this.#tryPushFrame();
    }
  }

  #tryPushFrame() {
    if (!this.#pendingRead || this.#destroyed) return;

    const frame = this.#readFrame();
    if (frame === null) {
      // Pipeline from createAudioResource(StreamType.Raw) starts flowing
      // MixStream immediately, before GuildPlayer.setCurrent / play().
      // Waiting for the first source is not an underrun — do not push
      // silence or start the 8s watchdog, or Discord transmits packets
      // (speaking indicator) while no track is attached, then sourceerror
      // races the real PCM source and playback never starts.
      if (!this.#current && !this.#betweenTracks && !this.#incoming) {
        return;
      }
      // Between tracks (handoff / prefetch) we MUST keep delivering frames.
      // Starving the AudioPlayer for ~5 packets (~100ms) makes it Idle, and
      // @discordjs/voice then destroy()s this MixStream — killing the mixer
      // for the rest of the session (2nd track never audible, queue races).
      if (this.#betweenTracks) {
        this.push(SILENCE_FRAME);
        this.#pendingRead = false;
        // Yield one tick instead of staying paused: a flowing pipeline
        // (createAudioResource → opus encoder) must keep receiving 20ms
        // frames or AudioPlayer goes Idle and destroys MixStream. A
        // synchronous pause() here never resumed, so Discord kept sending
        // leftover packets (speaking indicator) while the next track's PCM
        // never reached the encoder. setImmediate lets tests with 'data'
        // listeners avoid a tight loop without starving production.
        if (this.readableFlowing) {
          this.pause();
          setImmediate(() => {
            if (!this.#destroyed && this.isPaused()) this.resume();
          });
        }
        return;
      }
      if (!this.#underrunSince) {
        this.#underrunSince = Date.now();
      }
      if (Date.now() - this.#underrunSince >= MAX_UNDERRUN_MS) {
        this.emit('sourceerror', new Error(`underrun exceeded ${MAX_UNDERRUN_MS}ms`));
        this.#pendingRead = false;
        return;
      }
      this.push(SILENCE_FRAME);
      this.#pendingRead = false;
      this.emit('underrun');
      return;
    }

    const recovering = this.#underrunSince != null;
    this.#underrunSince = null;
    if (recovering) this.emit('underrunClear');
    this.push(frame);
    this.#pendingRead = false;
    this.#current?._onFrameConsumed?.();
    this.#incoming?._onFrameConsumed?.();
  }

  _destroy(err, callback) {
    this.#destroyed = true;
    this.#current?.destroy();
    this.#incoming?.destroy();
    this.#current = null;
    this.#incoming = null;
    this.#crossfade = null;
    this.#heldOutFrame = null;
    this.#heldInFrame = null;
    this.#incomingSkipSec = 0;
    this.#incomingSkippedSec = 0;
    callback(err);
  }

  #readExact(source, bytes) {
    if (!source) return null;
    let frame = this.#pendingExact.get(source) ?? Buffer.alloc(0);
    this.#pendingExact.delete(source);
    while (frame.length < bytes) {
      const chunk = source.read(bytes - frame.length);
      if (!chunk || chunk.length === 0) {
        if (source.ended) {
          if (frame.length > 0) {
            return Buffer.concat([frame, Buffer.alloc(bytes - frame.length)]);
          }
          return null;
        }
        // Underrun: keep already-consumed PCM for the next attempt.
        if (frame.length > 0) {
          this.#pendingExact.set(source, frame);
        }
        return null;
      }
      frame = Buffer.concat([frame, chunk]);
    }
    return frame;
  }

  #readFrame() {
    if (this.#crossfade?.mode === 'tail-fade' && this.#current) {
      return this.#readTailFadeFrame();
    }
    if (this.#crossfade && this.#current && this.#incoming) {
      return this.#readCrossfadeFrame();
    }

    if (!this.#current) {
      return null;
    }

    const frame = this.#readExact(this.#current, FRAME_BYTES);
    if (!frame) {
      if (this.#current?.ended) {
        this.#finishCurrent();
        // Adopted/promoted sources may already be producer-EOF while PCM remains
        // buffered — drain that buffer instead of inserting a silence frame.
        if (this.#current) {
          const adopted = this.#readExact(this.#current, FRAME_BYTES);
          if (adopted) {
            this.#consumedBytes += FRAME_BYTES;
            return adopted;
          }
        }
      }
      return null;
    }
    this.#consumedBytes += FRAME_BYTES;
    return frame;
  }

  #readTailFadeFrame() {
    const outFrame = this.#heldOutFrame ?? this.#readExact(this.#current, FRAME_BYTES);
    this.#heldOutFrame = null;

    if (!outFrame) {
      if (this.#current?.ended) {
        this.#promoteIncoming({ consumeIncoming: false });
        return this.#current ? this.#readExact(this.#current, FRAME_BYTES) : SILENCE_FRAME;
      }
      return null;
    }

    const outGain = gainForPosition({
      positionSec: this.#fadeElapsedSec,
      fadeSec: this.#crossfade.fadeSec,
      curve: this.#crossfade.curve,
      role: 'out',
    });
    // §11.2: unlike the crossfade path (mixFrames() already soft-limits),
    // tail-fade only ever scales a single frame — no other source is
    // summed in — but scaleFrame() alone has no headroom/clip protection.
    const faded = softLimitFrame(scaleFrame(outFrame, outGain));
    this.#consumedBytes += FRAME_BYTES;
    this.#fadeElapsedSec += FRAME_MS / 1000;

    if (this.#fadeElapsedSec >= this.#crossfade.fadeSec) {
      this.#promoteIncoming({ consumeIncoming: false });
    }
    return faded;
  }

  #skipIncomingLead() {
    while (this.#incomingSkipSec >= FRAME_MS / 1000 && this.#incoming) {
      const skipped = this.#readExact(this.#incoming, FRAME_BYTES);
      if (!skipped) return false;
      this.#incomingSkipSec -= FRAME_MS / 1000;
      this.#incomingSkippedSec += FRAME_MS / 1000;
    }
    return true;
  }

  #readCrossfadeFrame() {
    if (!this.#skipIncomingLead()) {
      const outFrame = this.#heldOutFrame ?? this.#readExact(this.#current, FRAME_BYTES);
      this.#heldOutFrame = null;
      if (outFrame) {
        this.#consumedBytes += FRAME_BYTES;
        return outFrame;
      }
      return null;
    }

    const outFrame = this.#heldOutFrame ?? this.#readExact(this.#current, FRAME_BYTES);
    this.#heldOutFrame = null;
    const inFrame = this.#heldInFrame ?? this.#readExact(this.#incoming, FRAME_BYTES);
    this.#heldInFrame = null;

    if (!outFrame && this.#current?.ended) {
      // Promote incoming to current mid-fade if outgoing ends first.
      this.#promoteIncoming();
      return inFrame ?? (this.#current ? this.#readExact(this.#current, FRAME_BYTES) : SILENCE_FRAME);
    }
    if (!inFrame) {
      if (this.#incoming?.ended) {
        // Same recovery path as decode failure: clear overlap and let
        // GuildPlayer reset arm flags so another incoming can be tried.
        this.emit('incomingerror', new Error('incoming ended during crossfade'));
        this.#clearIncoming();
        return outFrame;
      }
      // Incoming not ready yet — keep playing/consuming outgoing outro
      // instead of inserting underrun silence that freezes the current track.
      // A beatmix's whole premise is that outgoing's downbeat and incoming's
      // (seeked) downbeat land together once mixing starts — outgoing keeps
      // advancing through this stall while incoming stays pinned at its
      // entry point, so that alignment is broken by however long the stall
      // lasts. If NO dual-mixed frame has played yet (fadeElapsedSec still
      // 0), nothing beat-synced has actually been heard — cancel this
      // attempt outright (same recovery path as an incoming decode error)
      // rather than start an overlap already desynced from its plan, and
      // let GuildPlayer retry once a freshly-spawned decoder has had time to
      // buffer. Once fadeElapsedSec has advanced past 0, real beat-matched
      // audio already played; discarding it on top of an alignment glitch
      // would be worse, so only the bar-timed EQ ramp downgrades there,
      // falling back to an instant swap for the rest of the transition
      // (Codex round-5 and round-6).
      if (this.#fadeElapsedSec === 0 && this.#crossfade.isBeatmix) {
        this.emit('incomingerror', new Error('incoming stalled before beatmix could start'));
        this.#clearIncoming();
        return outFrame;
      }
      if (this.#crossfade.eqRampSec != null) {
        this.#crossfade.eqRampSec = null;
      }
      if (outFrame) {
        this.#consumedBytes += FRAME_BYTES;
        return outFrame;
      }
      return null;
    }
    if (!outFrame) {
      // Outgoing underrun with a ready incoming frame — hold it for the next tick.
      this.#heldInFrame = inFrame;
      return null;
    }

    // The biquad filters are stateful IIR processors — always run them every
    // frame so their history stays continuous, then blend the dry/wet result
    // by the ramp mix (shared by both sides — the ramp is one crossfade-wide
    // envelope, not per-channel). eqRampSec == null (non-beatmix) resolves
    // mix to 1, reproducing the prior "always fully filtered" behavior
    // exactly. mixFrames() below only reads outFrame/processedOut (never
    // mutates), so skip the defensive copy when there is no filter to blend.
    const eqMix = this.#crossfade.eqRampSec != null
      ? clamp01(this.#fadeElapsedSec / this.#crossfade.eqRampSec)
      : 1;
    const processedOut = this.#outEq
      ? blendFrame(outFrame, this.#outEq(Buffer.from(outFrame)), eqMix)
      : outFrame;
    const processedIn = this.#inEq
      ? blendFrame(inFrame, this.#inEq(Buffer.from(inFrame)), eqMix)
      : inFrame;

    const outGain = gainForPosition({
      positionSec: this.#fadeElapsedSec,
      fadeSec: this.#crossfade.fadeSec,
      curve: this.#crossfade.curve,
      role: 'out',
    });
    const inGain = gainForPosition({
      positionSec: this.#fadeElapsedSec,
      fadeSec: this.#crossfade.fadeSec,
      curve: this.#crossfade.curve,
      role: 'in',
    });

    const mixed = mixFrames(processedOut, processedIn, outGain, inGain);
    this.#consumedBytes += FRAME_BYTES;
    this.#fadeElapsedSec += FRAME_MS / 1000;

    if (this.#fadeElapsedSec >= this.#crossfade.fadeSec) {
      this.#promoteIncoming({ consumeIncoming: true });
    }
    return mixed;
  }

  #promoteIncoming({ consumeIncoming = true } = {}) {
    const next = this.#incoming;
    // Incoming already played fadeElapsedSec of PCM during overlap; keep that
    // offset so remainingSec matches real audio left after setDurationSec.
    const playedSec = consumeIncoming
      ? this.#fadeElapsedSec + this.#incomingSkippedSec
      : 0;
    const promotedConsumedBytes = Math.round(playedSec * BYTES_PER_SECOND);
    if (this.#current) {
      this.#current.removeAllListeners();
      this.#current.destroy();
    }
    this.#incoming = null;
    this.#crossfade = null;
    this.#outEq = null;
    this.#inEq = null;
    this.#fadeElapsedSec = 0;
    this.#heldOutFrame = null;
    this.#heldInFrame = null;
    this.#incomingSkipSec = 0;
    this.#incomingSkippedSec = 0;

    if (!next) {
      this.#current = null;
      this.#betweenTracks = true;
      // Emit trackend for the outgoing track; GuildPlayer advances queue
      // metadata without calling setCurrent again when already crossfading.
      this.emit('trackend', { promoted: true });
      return;
    }

    // Drop startCrossfade's incomingerror handler and rebind as current source
    // so later decode failures go through sourceerror / #hadError recovery.
    next.removeAllListeners();
    this.#current = next;
    this.#consumedBytes = promotedConsumedBytes;
    this.#durationSec = null;
    this.#betweenTracks = false;

    next.on('data', () => this.#scheduleRead());
    next.on('end', () => this.#scheduleRead());
    next.on('error', (err) => {
      this.emit('sourceerror', err);
    });

    // Emit only after #current/#durationSec are already switched to the
    // promoted source: a listener's setDurationSec() call (GuildPlayer's
    // #onCrossfadePromoted, which runs synchronously inside this emit) must
    // not be immediately overwritten by the #durationSec = null reset above.
    this.emit('trackend', { promoted: true });
  }

  #clearIncoming() {
    if (this.#incoming) {
      this.#incoming.removeAllListeners();
      this.#incoming.destroy();
      this.#incoming = null;
    }
    this.#crossfade = null;
    this.#outEq = null;
    this.#inEq = null;
    this.#fadeElapsedSec = 0;
    this.#heldOutFrame = null;
    this.#heldInFrame = null;
    this.#incomingSkipSec = 0;
    this.#incomingSkippedSec = 0;
  }

  /**
   * Replace the outgoing source without entering betweenTracks silence.
   * Used when the next track was prefetched but crossfade did not arm in time.
   * @param {object} source
   * @param {{ durationSec?: number|null }} [options]
   * @returns {boolean}
   */
  adoptCurrent(source, { durationSec = null } = {}) {
    if (this.#destroyed || !source) {
      source?.destroy?.();
      return false;
    }
    if (source.error) {
      source.destroy();
      return false;
    }

    if (this.#current) {
      this.#current.removeAllListeners();
      this.#current.destroy();
    }
    this.#clearIncoming();

    this.#current = source;
    this.#consumedBytes = 0;
    this.#durationSec = durationSec;
    this.#underrunSince = null;
    this.#betweenTracks = false;

    source.on('data', () => this.#scheduleRead());
    source.on('end', () => this.#scheduleRead());
    source.on('error', (err) => {
      this.emit('sourceerror', err);
    });

    // Do not #wakeConsumer here: natural-end snap runs inside #readFrame while
    // #pendingRead is still true; scheduling would re-enter #tryPushFrame and
    // double-push. The caller reads the first adopted frame instead (like promote).
    // Still unpause: createAudioResource's pipeline may have paused us during
    // the previous between-tracks silence, and the caller only pulls one frame.
    this.#unpauseIfNeeded();
    return true;
  }

  #finishCurrent() {
    const outgoing = this.#current;
    if (this.#incoming) {
      this.#promoteIncoming();
      return;
    }

    let adopted = false;
    let adoptWindowOpen = true;
    // Listeners must call adopt() synchronously during this emit. Async adopt
    // after emit returns races trackend / queue advance and is rejected.
    this.emit('snaphandoff', {
      adopt: (source, opts = {}) => {
        if (!adoptWindowOpen) {
          source?.destroy?.();
          return false;
        }
        adopted = this.adoptCurrent(source, opts);
        return adopted;
      },
    });
    adoptWindowOpen = false;
    if (adopted) {
      return;
    }

    this.#current = null;
    outgoing?.removeAllListeners();
    outgoing?.destroy();
    this.#betweenTracks = true;
    this.#underrunSince = null;
    this.emit('trackend');
  }
}

export { BYTES_PER_SECOND };

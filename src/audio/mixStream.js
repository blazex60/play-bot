import { Readable } from 'node:stream';
import {
  FRAME_BYTES,
  FRAME_MS,
  BYTES_PER_SECOND,
  gainForPosition,
  mixFrames,
} from './fade.js';
import {
  createOutgoingBaseSwapProcessor,
  createIncomingBaseSwapProcessor,
} from './eq.js';
import { MAX_UNDERRUN_MS } from './config.js';

const SILENCE_FRAME = Buffer.alloc(FRAME_BYTES);

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

    source.on('data', () => this.#scheduleRead());
    source.on('end', () => this.#scheduleRead());
    source.on('error', (err) => {
      this.emit('sourceerror', err);
      this.#finishCurrent();
    });

    this.#scheduleRead();
    return true;
  }

  /**
   * Begin overlapping the current track with an incoming source.
   * @param {object} source
   * @param {{ fadeSec: number, curve?: string, baseSwap?: boolean, highpassHz?: number, lowshelfGainDb?: number }} plan
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

    this.#incoming = source;
    this.#crossfade = {
      fadeSec: plan.fadeSec,
      curve: plan.curve ?? 'equal-power',
      baseSwap: plan.baseSwap === true,
    };
    this.#fadeElapsedSec = 0;
    this.#outEq = plan.baseSwap
      ? createOutgoingBaseSwapProcessor(48000, plan.highpassHz ?? 120)
      : null;
    this.#inEq = plan.baseSwap
      ? createIncomingBaseSwapProcessor(48000, plan.highpassHz ?? 120, plan.lowshelfGainDb ?? 2)
      : null;

    source.on('data', () => this.#scheduleRead());
    source.on('end', () => this.#scheduleRead());
    source.on('error', (err) => {
      // Cancel overlap only; do not emit sourceerror (that aborts outgoing).
      this.emit('incomingerror', err);
      this.#clearIncoming();
    });

    this.#scheduleRead();
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

  #scheduleRead() {
    if (this.#pendingRead) {
      this.#tryPushFrame();
    }
  }

  #tryPushFrame() {
    if (!this.#pendingRead || this.#destroyed) return;

    const frame = this.#readFrame();
    if (frame === null) {
      // Between tracks (handoff / prefetch) we MUST keep delivering frames.
      // Starving the AudioPlayer for ~5 packets (~100ms) makes it Idle, and
      // @discordjs/voice then destroy()s this MixStream — killing the mixer
      // for the rest of the session (2nd track never audible, queue races).
      if (this.#betweenTracks) {
        this.push(SILENCE_FRAME);
        this.#pendingRead = false;
        // Flowing-mode consumers (tests using 'data') would otherwise sync-spin
        // on endless silence. AudioPlayer uses paused reads, so it is unaffected.
        if (this.readableFlowing) this.pause();
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

    this.#underrunSince = null;
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
    callback(err);
  }

  #readExact(source, bytes) {
    if (!source) return null;
    let frame = Buffer.alloc(0);
    while (frame.length < bytes) {
      const chunk = source.read(bytes - frame.length);
      if (!chunk || chunk.length === 0) {
        if (source.ended) {
          if (frame.length > 0) {
            return Buffer.concat([frame, Buffer.alloc(bytes - frame.length)]);
          }
          return null;
        }
        return null;
      }
      frame = Buffer.concat([frame, chunk]);
    }
    return frame;
  }

  #readFrame() {
    if (this.#crossfade && this.#current && this.#incoming) {
      return this.#readCrossfadeFrame();
    }

    if (!this.#current) {
      return null;
    }

    const frame = this.#readExact(this.#current, FRAME_BYTES);
    if (!frame) {
      if (this.#current.ended) {
        this.#finishCurrent();
      }
      return null;
    }
    this.#consumedBytes += FRAME_BYTES;
    return frame;
  }

  #readCrossfadeFrame() {
    const outFrame = this.#readExact(this.#current, FRAME_BYTES);
    const inFrame = this.#readExact(this.#incoming, FRAME_BYTES);

    if (!outFrame && this.#current?.ended) {
      // Promote incoming to current mid-fade if outgoing ends first.
      this.#promoteIncoming();
      return inFrame ?? (this.#current ? this.#readExact(this.#current, FRAME_BYTES) : SILENCE_FRAME);
    }
    if (!inFrame) {
      if (this.#incoming?.ended) {
        this.#clearIncoming();
        return outFrame;
      }
      // Incoming not ready yet — keep playing/consuming outgoing outro
      // instead of inserting underrun silence that freezes the current track.
      if (outFrame) {
        this.#consumedBytes += FRAME_BYTES;
        return outFrame;
      }
      return null;
    }
    if (!outFrame) return null;

    let processedOut = Buffer.from(outFrame);
    let processedIn = Buffer.from(inFrame);
    if (this.#outEq) processedOut = this.#outEq(processedOut);
    if (this.#inEq) processedIn = this.#inEq(processedIn);

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
      this.#promoteIncoming();
    }
    return mixed;
  }

  #promoteIncoming() {
    const next = this.#incoming;
    if (this.#current) {
      this.#current.removeAllListeners();
      this.#current.destroy();
    }
    this.#incoming = null;
    this.#crossfade = null;
    this.#outEq = null;
    this.#inEq = null;
    this.#fadeElapsedSec = 0;

    // Emit trackend for the outgoing track; GuildPlayer advances queue metadata
    // without calling setCurrent again when already crossfading.
    this.emit('trackend', { promoted: true });

    if (!next) {
      this.#current = null;
      this.#betweenTracks = true;
      return;
    }

    // Drop startCrossfade's incomingerror handler and rebind as current source
    // so later decode failures go through sourceerror / #hadError recovery.
    next.removeAllListeners();
    this.#current = next;
    this.#consumedBytes = 0;
    this.#durationSec = null;
    this.#betweenTracks = false;

    next.on('data', () => this.#scheduleRead());
    next.on('end', () => this.#scheduleRead());
    next.on('error', (err) => {
      this.emit('sourceerror', err);
      this.#finishCurrent();
    });
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
  }

  #finishCurrent() {
    const source = this.#current;
    this.#current = null;
    source?.removeAllListeners();
    source?.destroy();
    if (this.#incoming) {
      this.#promoteIncoming();
      return;
    }
    this.#betweenTracks = true;
    this.#underrunSince = null;
    this.emit('trackend');
  }
}

export { BYTES_PER_SECOND };

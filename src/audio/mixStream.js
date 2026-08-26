import { Readable } from 'node:stream';
import {
  FRAME_BYTES,
  FRAME_MS,
  BYTES_PER_SECOND,
  gainForPosition,
  gainForStemPosition,
  mixFrames,
  mixNFrames,
  scaleFrame,
  softLimitFrame,
  blendFrame,
} from './fade.js';
import {
  createOutgoingBaseSwapProcessor,
  createIncomingBaseSwapProcessor,
} from './eq.js';
import { MAX_UNDERRUN_MS } from './config.js';
import { deriveStemEnvelopesFromEvents } from './stemTransition.js';

const SILENCE_FRAME = Buffer.alloc(FRAME_BYTES);
/**
 * Phase 8: hard cap on how many ticks #readStemCrossfadeFrame() will hold
 * promotion waiting for #incoming to catch up to #stemCrossfadeTicks's live
 * (ever-growing) target. A transient stall (spawn latency, a missed read)
 * closes within a handful of ticks; sustained decoder pressure (CPU
 * contention keeping #incoming to ~1 new frame per tick, matching the
 * target's own growth rate 1-for-1) would otherwise never close the gap and
 * block GuildPlayer's queue advancement for up to the rest of the incoming
 * track (Codex). 50 ticks (1s) comfortably covers ordinary spawn-latency
 * deficits while bounding the worst case to something GuildPlayer can
 * recover from quickly.
 */
const MAX_STEM_CATCHUP_HOLD_TICKS = 50;

function clamp01(n) {
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

/**
 * Phase 7 §11.1: for a `mode: 'beatmix'` plan (and Phase 8's `'stem-mix'`,
 * which is derived from and carries the same sync/eq/targetBpm fields as a
 * beatmix plan), the bass-swap EQ ramps in over `eq.swapBar` bars instead of
 * applying instantly for the whole crossfade (the doc's diagram — A/B LOW%
 * cross over gradually, not switched at bar 1). `sync.beatsPerBar` and
 * `targetBpm` (the session tempo both sides play the overlap at) give the
 * real bar length; any other mode (plain crossfade, phrase-crossfade) keeps
 * the existing instant on/off EQ, so this returns null for them.
 * @returns {number|null} ramp duration in seconds, or null for "apply fully".
 */
function computeEqRampSec(plan) {
  // stem-mix plans carry the same sync/eq/targetBpm fields as the beatmix
  // plan they were derived from (planStemTransition() spreads it through)
  // — the bar-timed ramp applies identically to the instrumental pair.
  if (plan.mode !== 'beatmix' && plan.mode !== 'stem-mix') return null;
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
  #betweenTrackTimer = null;
  /** Phase 8 (docs/mix-transition-phase8.md): stem-mix crossfade state — mutually exclusive with #crossfade. */
  #stemCrossfade = null;
  #outVocal = null;
  #outInstrumental = null;
  #inVocal = null;
  #inInstrumental = null;
  /**
   * Per-stem count of ticks whose real frame was substituted with silence
   * (a transient stall or a not-yet-ready decoder) and never made up —
   * #readStemCatchingUp() drains an extra already-buffered frame per
   * outstanding deficit point the next time that stem IS ready, so a
   * momentary stall doesn't leave that stem's content permanently trailing
   * the others by however many ticks it missed (Codex).
   */
  #outVocalDeficit = 0;
  #outInstrumentalDeficit = 0;
  #inVocalDeficit = 0;
  #inInstrumentalDeficit = 0;
  /** Same per-tick deficit tracking as the 4 stems above, but for #current's own lockstep-drain read (its rare error-cancellation fallback position). */
  #currentFallbackDeficit = 0;
  /** Frames actually drained from #incoming during the current stem window — used to catch up any deficit before promotion. */
  #incomingStemFramesRead = 0;
  /** Total stem-mix ticks processed during the current window (including ticks held past fadeSec while catching up #incoming) — the live target #incomingStemFramesRead must reach before promotion. */
  #stemCrossfadeTicks = 0;
  /** Ticks spent holding past fadeSec waiting for #incoming to catch up — capped by MAX_STEM_CATCHUP_HOLD_TICKS so sustained decoder pressure can't block promotion indefinitely. */
  #stemCatchupHoldTicks = 0;

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
    return this.#crossfade != null || this.#stemCrossfade != null;
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

    source.on('data', () => this.#wakeConsumer());
    source.on('end', () => this.#wakeConsumer());
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

    source.on('data', () => this.#wakeConsumer());
    source.on('end', () => this.#wakeConsumer());
    source.on('error', (err) => {
      // Cancel overlap only; do not emit sourceerror (that aborts outgoing).
      this.emit('incomingerror', err);
      this.#clearIncoming();
    });

    this.#wakeConsumer();
    this.emit('crossfadestart', plan);
    return true;
  }

  /**
   * Phase 8 (docs/mix-transition-phase8.md): begin a stem-aware crossfade —
   * each side's vocal/instrumental stems get their own independent gain
   * envelope (`plan.stems`) instead of one shared envelope per side.
   * `incoming.full` is the SAME full-mix continuation source a plain
   * startCrossfade() would have used (seeked to the same entrySec/
   * tempoFilter as `incoming.vocal`/`incoming.instrumental`) — it is read
   * and discarded in lockstep with the stems throughout the window (see
   * #readStemCrossfadeFrame()) purely to keep its position synced for
   * #promoteStemIncoming(), never mixed into the audible output itself.
   * @param {{ outgoing: {vocal:object, instrumental:object}, incoming: {vocal:object, instrumental:object, full:object} }} sources
   * @param {{ fadeSec: number, curve?: string, baseSwap?: boolean, highpassHz?: number, lowshelfGainDb?: number, mode?: string, stems: object }} plan
   */
  startStemCrossfade({ outgoing, incoming } = {}, plan) {
    const allSources = [outgoing?.vocal, outgoing?.instrumental, incoming?.vocal, incoming?.instrumental, incoming?.full];
    if (this.#destroyed || !this.#current || this.#crossfade || this.#stemCrossfade || allSources.some((s) => !s)) {
      for (const s of allSources) s?.destroy?.();
      return false;
    }
    if (!plan?.fadeSec || plan.fadeSec <= 0 || !plan?.stems) {
      for (const s of allSources) s.destroy();
      return false;
    }
    const errored = allSources.find((s) => s.error);
    if (errored) {
      // Incoming/outgoing-stem arming failure is recoverable — keep the
      // outgoing (plain) track, same posture as startCrossfade().
      for (const s of allSources) s.destroy();
      this.emit('incomingerror', errored.error);
      return false;
    }

    this.#incoming = incoming.full;
    this.#outVocal = outgoing.vocal;
    this.#outInstrumental = outgoing.instrumental;
    this.#inVocal = incoming.vocal;
    this.#inInstrumental = incoming.instrumental;
    const baseSwap = plan.baseSwap === true;
    // Phase 9G (docs/mix-transition-phase9.md §9): TransitionPlan v3's
    // mixZone/events, when the planner could derive a bar clock (needs
    // sync.bars/beatsPerBar/targetBpm — see stemTransition.js's
    // buildTransitionEvents()). null/undefined for a plan without one.
    const events = Array.isArray(plan.events) && plan.events.length > 0 ? plan.events : null;
    const mixZone = plan.mixZone ?? null;
    // Codex review (PR #53, P1): the events schedule must actually DRIVE
    // gain state, not just fire notifications alongside an unrelated
    // computation — every tick's stem envelopes are reconstructed FROM the
    // schedule (deriveStemEnvelopesFromEvents()) whenever one is available,
    // rather than reading plan.stems directly. Falls back to plan.stems for
    // a plan with no bar-clock data (legacy caller, or a hand-built test
    // plan) so #fireDueMixZoneEvents() no-ops and this stays exactly the
    // pre-9G behavior.
    const stems = (events && mixZone?.bars > 0 && mixZone?.durationSec > 0)
      ? deriveStemEnvelopesFromEvents(events, mixZone, plan.curve)
      : plan.stems;
    this.#stemCrossfade = {
      fadeSec: plan.fadeSec,
      stems,
      baseSwap,
      eqRampSec: computeEqRampSec(plan),
      events,
      mixZone,
      nextEventIndex: 0,
    };
    this.#fadeElapsedSec = 0;
    this.#incomingStemFramesRead = 0;
    this.#stemCrossfadeTicks = 0;
    this.#stemCatchupHoldTicks = 0;
    this.#outVocalDeficit = 0;
    this.#outInstrumentalDeficit = 0;
    this.#inVocalDeficit = 0;
    this.#inInstrumentalDeficit = 0;
    this.#currentFallbackDeficit = 0;
    this.#outEq = baseSwap ? createOutgoingBaseSwapProcessor(48000, plan.highpassHz ?? 120) : null;
    this.#inEq = baseSwap
      ? createIncomingBaseSwapProcessor(48000, plan.highpassHz ?? 120, plan.lowshelfGainDb ?? 2)
      : null;

    for (const s of allSources) {
      s.on('data', () => this.#wakeConsumer());
      s.on('end', () => this.#wakeConsumer());
    }
    // Stem sources read local, already-separated cache files (§8.2 of the
    // doc) — an error there is treated the same as a natural EOF by
    // #readStemCrossfadeFrame()'s per-stem exhaustion handling (that stem
    // just contributes silence for the rest of the window), not as a
    // whole-transition abort, so no listener is needed beyond #wakeConsumer.
    // `incoming.full` is different: it is what #promoteStemIncoming() installs
    // as #current, never mixed/validated frame-by-frame itself, so a failure
    // here must cancel the whole overlap now — otherwise a dead source could
    // silently get promoted later. Same posture/cleanup as plain
    // startCrossfade()'s incoming error handler, plus the stem sources.
    incoming.full.on('error', (err) => {
      this.emit('incomingerror', err);
      this.#clearIncoming();
      this.#clearStemSources();
    });

    this.#wakeConsumer();
    this.emit('crossfadestart', plan);
    return true;
  }

  #clearStemSources() {
    this.#outVocal?.removeAllListeners();
    this.#outVocal?.destroy();
    this.#outVocal = null;
    this.#outInstrumental?.removeAllListeners();
    this.#outInstrumental?.destroy();
    this.#outInstrumental = null;
    this.#inVocal?.removeAllListeners();
    this.#inVocal?.destroy();
    this.#inVocal = null;
    this.#inInstrumental?.removeAllListeners();
    this.#inInstrumental?.destroy();
    this.#inInstrumental = null;
    this.#stemCrossfade = null;
  }

  dropCurrent() {
    if (this.#current) {
      this.#current.removeAllListeners();
      this.#current.destroy();
      this.#current = null;
    }
    this.#clearIncoming();
    this.#clearStemSources();
    this.#betweenTracks = true;
    this.#underrunSince = null;
    this.#crossfade = null;
    this.emit('trackend');
    this.#wakeConsumer();
  }

  endMixer() {
    if (this.#destroyed) return;
    this.#destroyed = true;
    if (this.#betweenTrackTimer) clearTimeout(this.#betweenTrackTimer);
    this.#betweenTrackTimer = null;
    this.#current?.destroy();
    this.#incoming?.destroy();
    this.#current = null;
    this.#incoming = null;
    this.#clearStemSources();
    this.push(null);
  }

  _read() {
    this.#pendingRead = true;
    this.#tryPushFrame();
  }

  #unpauseIfNeeded() {
    // Only resume a stream that was already flowing and then paused (pipe
    // backpressure or an explicit pause). A never-piped MixStream is paused
    // with readableFlowing === null; resume() would dump PCM with no consumer.
    if (this.readableFlowing === false) this.resume();
  }

  #wakeConsumer() {
    // A newly attached/ready source must not wait for the between-track pacing
    // timer. Resuming here preserves the existing source-ready wake-up; the
    // pacing callback itself never resumes against downstream backpressure.
    if (!this.#betweenTracks) this.#clearKeepAliveTimer();
    this.#unpauseIfNeeded();
    this.#scheduleRead();
  }

  #scheduleRead() {
    if (this.#pendingRead) {
      this.#tryPushFrame();
    }
  }

  #clearKeepAliveTimer() {
    if (this.#betweenTrackTimer) {
      clearTimeout(this.#betweenTrackTimer);
      this.#betweenTrackTimer = null;
    }
  }

  /**
   * Pace 20 ms PCM silence while idle or between tracks. push() may
   * synchronously request another frame; install the timer first so a
   * re-entrant _read() leaves #pendingRead set instead of spinning.
   * Do not resume() here: that overrides pipe backpressure and grows an
   * encoded-silence backlog.
   */
  #pushKeepAliveSilence() {
    if (this.#betweenTrackTimer) return;
    this.#pendingRead = false;
    this.#betweenTrackTimer = setTimeout(() => {
      this.#betweenTrackTimer = null;
      if (this.#destroyed) return;
      if (this.#current && !this.#betweenTracks) return;
      if (this.readableFlowing) this.#pendingRead = true;
      this.#scheduleRead();
    }, FRAME_MS);
    this.#betweenTrackTimer.unref?.();
    this.push(SILENCE_FRAME);
  }

  #tryPushFrame() {
    if (!this.#pendingRead || this.#destroyed) return;

    const frame = this.#readFrame();
    if (frame === null) {
      // No PCM this tick. Keep delivering 20 ms silence so a piped opus
      // encoder stays readable: @discordjs/voice AudioPlayer.checkPlayable()
      // otherwise starts silencePaddingFrames (default 5) and then destroy()s
      // this MixStream after ~100 ms. Waiting for the first source is not an
      // underrun — do not start the 8s watchdog.
      if (!this.#current && !this.#incoming) {
        this.#pushKeepAliveSilence();
        return;
      }
      if (this.#betweenTracks) {
        this.#pushKeepAliveSilence();
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

    this.#clearKeepAliveTimer();

    const recovering = this.#underrunSince != null;
    this.#underrunSince = null;
    if (recovering) this.emit('underrunClear');
    this.push(frame);
    this.#pendingRead = false;
    this.#current?._onFrameConsumed?.();
    this.#incoming?._onFrameConsumed?.();
    // Phase 8: a stem crossfade reads 4 additional real decoders (ffmpeg-
    // backed PcmSources, same MAX_BUFFER_BYTES pause-on-backpressure as
    // #current/#incoming) that #readStemCrossfadeFrame() consumes from
    // directly — without this, they pause after their initial ~2s buffer
    // and never resume, stalling any overlap longer than that.
    this.#outVocal?._onFrameConsumed?.();
    this.#outInstrumental?._onFrameConsumed?.();
    this.#inVocal?._onFrameConsumed?.();
    this.#inInstrumental?._onFrameConsumed?.();
  }

  _destroy(err, callback) {
    this.#destroyed = true;
    if (this.#betweenTrackTimer) clearTimeout(this.#betweenTrackTimer);
    this.#betweenTrackTimer = null;
    this.#current?.destroy();
    this.#incoming?.destroy();
    this.#current = null;
    this.#incoming = null;
    this.#crossfade = null;
    this.#heldOutFrame = null;
    this.#heldInFrame = null;
    this.#incomingSkipSec = 0;
    this.#incomingSkippedSec = 0;
    this.#clearStemSources();
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

  /**
   * Phase 8: like #readExact(), but also closes any outstanding per-stem
   * deficit (ticks this stem was silence-substituted for and never made
   * up) by draining extra already-buffered frames this tick, keeping only
   * the freshest one — a stem that stalled for a tick otherwise plays that
   * content permanently one-or-more ticks behind the others for the rest
   * of the window, since a Readable's `.read()` can't be un-consumed and
   * nothing else ever re-syncs it (Codex). Draining (not holding) the
   * catch-up frames means at most one, already-buffered, already-decoded
   * extra frame's worth of THIS stem's own audio is skipped to restore
   * alignment — inaudible next to a growing cross-stem skew for the rest
   * of the transition. Best-effort: if no extra data is buffered yet, the
   * deficit carries forward and is retried on a later successful tick.
   * @returns {[Buffer|null, number]} [frame, newDeficit]
   */
  #readStemCatchingUp(source, bytes, deficit) {
    let frame = this.#readExact(source, bytes);
    if (!frame) return [null, deficit + 1];
    while (deficit > 0) {
      const next = this.#readExact(source, bytes);
      if (!next) break;
      frame = next;
      deficit -= 1;
    }
    return [frame, deficit];
  }

  #readFrame() {
    if (this.#crossfade?.mode === 'tail-fade' && this.#current) {
      return this.#readTailFadeFrame();
    }
    if (this.#stemCrossfade && this.#current) {
      return this.#readStemCrossfadeFrame();
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

  /**
   * Phase 8: mixes 4 independently-enveloped stem streams instead of the
   * plain path's 2 whole-track streams. Any of the 4 that has no frame this
   * tick — whether permanently exhausted (EOF) or merely a transient
   * underrun — contributes silence for THIS tick only and is retried
   * normally next tick; the other stems keep playing and the fade clock
   * always advances. Two earlier designs were tried and both broke under
   * Codex review across rounds 8-9:
   *   1. Return null (silence the WHOLE mix) when any one of 4 isn't ready —
   *      the original design; silenced all 4 stems for what's usually just
   *      one decoder's brief hiccup.
   *   2. Substitute #current's real (non-gain-weighted) audio for the whole
   *      tick, holding whichever of the 4 stems DID arrive for reuse once
   *      the stalled one catches up — fixed (1)'s full-silence problem, but
   *      whichever held frames got reused on the recovery tick had already
   *      been "sonically superseded" by the #current audio played as filler
   *      in between, an audible replay (Codex, round 8→9). Discarding the
   *      held frames instead (round 9) fixed the replay but left the 3
   *      already-consumed-and-discarded stems permanently 1 tick ahead of
   *      the stalled one once it resumes, since a Readable's `.read()`
   *      can't be un-consumed — a skew that grows with every further stall
   *      (Codex, round 9 follow-up).
   * This design (per-stem silence substitution, unconditional every tick —
   * same shape as the existing EOF/exhaustion handling, just no longer
   * gated on `.ended`) avoids both: nothing is ever held across ticks, so
   * there is nothing to go stale or desync. On its own, though, this still
   * leaves a stalled stem's OWN content permanently trailing the other 3
   * by however many ticks it missed, since it just resumes its normal
   * one-frame-per-tick cadence from wherever it left off (Codex, round 9
   * follow-up #2) — #readStemCatchingUp() closes that per-stem deficit by
   * draining an extra already-buffered frame (discarding the older one)
   * the next time that stem IS ready, so the skip is a single, bounded,
   * self-contained skip within that one stem's own audio rather than a
   * skew relative to the other 3 that never closes on its own.
   */
  #readStemCrossfadeFrame() {
    let outVocalFrame; let outInstFrame; let inVocalFrame; let inInstFrame;
    [outVocalFrame, this.#outVocalDeficit] = this.#readStemCatchingUp(this.#outVocal, FRAME_BYTES, this.#outVocalDeficit);
    [outInstFrame, this.#outInstrumentalDeficit] = this.#readStemCatchingUp(this.#outInstrumental, FRAME_BYTES, this.#outInstrumentalDeficit);
    [inVocalFrame, this.#inVocalDeficit] = this.#readStemCatchingUp(this.#inVocal, FRAME_BYTES, this.#inVocalDeficit);
    [inInstFrame, this.#inInstrumentalDeficit] = this.#readStemCatchingUp(this.#inInstrumental, FRAME_BYTES, this.#inInstrumentalDeficit);

    const outVocal = outVocalFrame ?? SILENCE_FRAME;
    const outInst = outInstFrame ?? SILENCE_FRAME;
    const inVocal = inVocalFrame ?? SILENCE_FRAME;
    const inInst = inInstFrame ?? SILENCE_FRAME;

    const { stems, fadeSec, eqRampSec } = this.#stemCrossfade;
    const eqMix = eqRampSec != null ? clamp01(this.#fadeElapsedSec / eqRampSec) : 1;
    // Bass-swap EQ applies only to the instrumental pair — bass energy
    // lives there, not in the vocal stem, and post-sum filtering would
    // re-couple vocal/instrumental through a shared filter, undermining the
    // whole point of separating them (docs/mix-transition-phase8.md).
    const processedOutInst = this.#outEq
      ? blendFrame(outInst, this.#outEq(Buffer.from(outInst)), eqMix)
      : outInst;
    const processedInInst = this.#inEq
      ? blendFrame(inInst, this.#inEq(Buffer.from(inInst)), eqMix)
      : inInst;

    const outVocalGain = gainForStemPosition({ positionSec: this.#fadeElapsedSec, ...stems.outVocal });
    const outInstGain = gainForStemPosition({ positionSec: this.#fadeElapsedSec, ...stems.outInstrumental });
    const inInstGain = gainForStemPosition({ positionSec: this.#fadeElapsedSec, ...stems.inInstrumental });
    const inVocalGain = gainForStemPosition({ positionSec: this.#fadeElapsedSec, ...stems.inVocal });

    const mixed = mixNFrames(
      [outVocal, processedOutInst, processedInInst, inVocal],
      [outVocalGain, outInstGain, inInstGain, inVocalGain],
    );
    this.#consumedBytes += FRAME_BYTES;
    this.#fadeElapsedSec += FRAME_MS / 1000;
    this.#fireDueMixZoneEvents();
    // Counts every processed tick, including ticks held past fadeSec while
    // catching up #incoming — unlike a fadeSec-derived constant, this grows
    // by 1 on each such hold tick too, since a hold tick also advances the
    // audible stems by one frame. Comparing #incomingStemFramesRead against
    // this live count (not a fixed target) is what makes promotion wait for
    // the ACTUAL number of ticks elapsed, not just the nominal window length
    // (Codex: a fixed target let a held tick's own new #incoming frame count
    // toward covering old backlog, still leaving a 1-frame gap at promotion).
    this.#stemCrossfadeTicks += 1;

    // Keep #incoming (the post-window full-mix continuation source, seeked
    // once at prep time to the same entrySec/tempoFilter as the incoming
    // stems) draining in lockstep with the stems it stands in for, so its
    // position lands correctly for #promoteStemIncoming() — best-effort,
    // not blocking: a tick where it isn't ready yet (spawn startup latency)
    // is simply skipped, which can leave it trailing by that latency. The
    // catch-up drain right before promotion below recovers this deficit
    // rather than leaving #incoming permanently behind (Codex).
    if (this.#readExact(this.#incoming, FRAME_BYTES)) {
      this.#incomingStemFramesRead += 1;
    }
    // #current (the ORIGINAL outgoing full-mix source, distinct from
    // #outVocal/#outInstrumental which read the separated stem files) is
    // the fallback #clearIncoming()/#clearStemSources() resumes from if
    // incoming.full errors mid-window (see startStemCrossfade()'s error
    // handler). Without draining it too, it would sit frozen at its
    // position from the START of the stem window, replaying already-heard
    // audio on that (rare) cancel path — same best-effort lockstep drain
    // as #incoming, for the same reason (Codex). Uses the same per-tick
    // catch-up drain as the 4 stems (not just a plain #readExact()) so a
    // tick where #current itself has no complete frame yet doesn't leave
    // it permanently trailing the stem timeline either — same underlying
    // bug, just on this fallback's own read instead of a stem's (Codex).
    [, this.#currentFallbackDeficit] = this.#readStemCatchingUp(this.#current, FRAME_BYTES, this.#currentFallbackDeficit);

    if (this.#fadeElapsedSec >= fadeSec) {
      // Drain any accumulated #incoming deficit (early-window buffering
      // stalls the best-effort read above skipped) before promoting it to
      // #current — each tick only ever recovers at most one missed frame
      // otherwise, which can never fully catch up a multi-frame backlog.
      // Target #stemCrossfadeTicks (the live count of ticks actually
      // processed so far), not a fadeSec-derived constant: a constant target
      // stops growing once computed, but a tick spent here HOLDING (this
      // very branch, below) is itself one more processed tick — its own
      // #incoming read at the top of the function competes for the same
      // fixed target as the old backlog, so a constant target could be
      // satisfied one frame short of the real backlog at promotion (Codex,
      // caught after the earlier Math.ceil fix: "every held tick also
      // advances the audible incoming stems, but expectedFrames remains
      // fixed"). #stemCrossfadeTicks increments every processed tick
      // (including this hold), so it stays exactly in step.
      while (this.#incomingStemFramesRead < this.#stemCrossfadeTicks && this.#readExact(this.#incoming, FRAME_BYTES)) {
        this.#incomingStemFramesRead += 1;
      }
      // Only promote once #incoming has actually caught up — a decoder
      // that's genuinely still lagging (not just "hadn't been read yet")
      // can't be drained faster than it decodes, so the loop above may
      // still exit short. Holding here instead of promoting behind is
      // safe: gainForStemPosition() already clamps out/in gains to their
      // terminal values past fadeSec, so continuing to mix the 4 stems for
      // a few more ticks is audibly equivalent to the post-promotion
      // full-mix source (inVocal/inInstrumental already at full gain,
      // out* already silent) — just retry the catch-up next tick (Codex).
      // #stemCrossfadeTicks growing on every hold tick (the fix above) means
      // the target keeps rising for as long as we hold — if #incoming ends
      // (genuinely out of data, e.g. a very short track/clip) before
      // catching up, it can never gain enough frames to reach a still-
      // growing target, holding — and, since the 4 stem sources can go on
      // producing silence-substituted frames indefinitely once THEY end too
      // (see the held/Done handling above), spinning the synchronous push
      // loop — forever. Ended is exactly "no more frames will ever arrive",
      // so promote with whatever #incoming did manage to read rather than
      // wait on frames that can never come.
      //
      // That reasoning breaks down under SUSTAINED pressure: if #incoming
      // settles into producing at most one new frame per tick from here on
      // (e.g. CPU contention), it can never close a pre-existing deficit —
      // #stemCrossfadeTicks grows by 1 every hold tick too, exactly
      // matching #incoming's own best-case growth rate, so the gap it
      // needed to close stays constant forever instead of shrinking. Left
      // unbounded this blocks GuildPlayer's queue advancement for
      // potentially the rest of the incoming track (Codex). Cap the hold at
      // MAX_STEM_CATCHUP_HOLD_TICKS and promote anyway past that point —
      // still audibly safe per the clamped-gain reasoning above, just with
      // a small remaining desync instead of an unbounded stall.
      const caughtUp = this.#incomingStemFramesRead >= this.#stemCrossfadeTicks;
      if (caughtUp || this.#incoming?.ended) {
        this.#promoteStemIncoming();
      } else {
        this.#stemCatchupHoldTicks += 1;
        if (this.#stemCatchupHoldTicks >= MAX_STEM_CATCHUP_HOLD_TICKS) {
          this.#promoteStemIncoming();
        }
      }
    }
    return mixed;
  }

  /**
   * Phase 9G (docs/mix-transition-phase9.md §9.2): fires 'mixzoneevent' for
   * every scheduled bar-event #fadeElapsedSec has now reached or passed,
   * exactly once each and in schedule order — the concrete mechanism by
   * which this transition "progresses through multiple bar events" instead
   * of existing only as one continuous equal-power curve. `barSec` is
   * derived from mixZone.durationSec/bars (the exact same relationship
   * planBeatmixTransition() used to compute fadeSec in the first place —
   * see beatmixTransition.js's `barSec = (60/targetBpm)*beatsPerBar`,
   * `fadeSec = barSec*bars`) rather than recomputed from targetBpm, so this
   * can never drift from the window the gain envelopes themselves are
   * defined over. No-op when the current stem crossfade has no events/
   * mixZone (the planner couldn't derive a bar clock — see
   * buildTransitionEvents()'s own guard).
   *
   * Codex review (PR #53, P2): a synchronous 'mixzoneevent' listener that
   * itself changes crossfade state (dropCurrent(), endMixer(), a future
   * planner recovery hook) can null #stemCrossfade before this returns —
   * writing the advanced cursor back onto `this.#stemCrossfade` after such
   * a listener ran would then throw on `null`, killing the mixer stream
   * over a downstream listener's own unrelated action. `crossfade` is
   * captured once and mutated directly (never re-read from
   * `this.#stemCrossfade`), so a listener nulling the live field can never
   * make this throw; the loop also stops firing further (now-stale) events
   * the moment that happens, rather than continuing to describe a
   * crossfade that no longer exists.
   */
  #fireDueMixZoneEvents() {
    const crossfade = this.#stemCrossfade;
    const { events, mixZone } = crossfade;
    if (!events || !(mixZone?.bars > 0) || !(mixZone?.durationSec > 0)) return;
    const barSec = mixZone.durationSec / mixZone.bars;
    while (crossfade.nextEventIndex < events.length
      && this.#fadeElapsedSec >= events[crossfade.nextEventIndex].bar * barSec - 1e-6) {
      const event = events[crossfade.nextEventIndex];
      crossfade.nextEventIndex += 1; // advance before emit — see docstring
      this.emit('mixzoneevent', { ...event, mixZone });
      if (this.#stemCrossfade !== crossfade) return; // torn down by the listener
    }
  }

  #promoteStemIncoming() {
    const next = this.#incoming;
    this.#clearStemSources();
    this.#outEq = null;
    this.#inEq = null;
    this.#fadeElapsedSec = 0;

    if (this.#current) {
      this.#current.removeAllListeners();
      this.#current.destroy();
    }
    this.#incoming = null;

    if (!next) {
      this.#current = null;
      this.#betweenTracks = true;
      this.emit('trackend', { promoted: true });
      return;
    }

    next.removeAllListeners();
    this.#current = next;
    // Unlike #promoteIncoming(), #incoming here was read-and-discarded in
    // lockstep with the stem mix throughout the window (see
    // #readStemCrossfadeFrame()), so its own read position already sits at
    // the right native continuation point — consumedBytes only needs to
    // reflect how much playback-domain audio has actually been read from
    // `next` so far. That is normally fadeElapsedSec's worth (the caught-up
    // case), but MAX_STEM_CATCHUP_HOLD_TICKS can force promotion while
    // #incoming is still short of #stemCrossfadeTicks frames — deriving
    // consumedBytes from fadeElapsedSec in that case overstates it by the
    // residual deficit, since that many frames were never actually read
    // from `next`. Using #incomingStemFramesRead (the real count) instead
    // keeps consumedBytes matching next's true read position in both cases
    // (Codex: forced promotion desyncs position bookkeeping).
    this.#consumedBytes = this.#incomingStemFramesRead * FRAME_BYTES;
    this.#durationSec = null;
    this.#betweenTracks = false;

    next.on('data', () => this.#wakeConsumer());
    next.on('end', () => this.#wakeConsumer());
    next.on('error', (err) => {
      this.emit('sourceerror', err);
    });

    this.emit('trackend', { promoted: true });
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

    next.on('data', () => this.#wakeConsumer());
    next.on('end', () => this.#wakeConsumer());
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

    source.on('data', () => this.#wakeConsumer());
    source.on('end', () => this.#wakeConsumer());
    source.on('error', (err) => {
      this.emit('sourceerror', err);
    });

    // Do not #wakeConsumer here: natural-end snap runs inside #readFrame while
    // #pendingRead is still true; scheduling would re-enter #tryPushFrame and
    // double-push. The caller reads the first adopted frame instead (like promote).
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

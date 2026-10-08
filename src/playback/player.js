import {
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  NoSubscriberBehavior,
  VoiceConnectionStatus,
} from '@discordjs/voice';
import { resolveAudioStream } from '../media/search.js';
import {
  cleanupTempFile,
  prefetchTrack,
  stageTempFileCopy,
} from '../audio/normalize.js';
import { AnalysisCoordinator } from './player/analysisCoordinator.js';
import { QueueAdvancement } from './player/queueAdvancement.js';
import { PlaybackWatchdog } from './player/playbackWatchdog.js';
import { SourcePreparer } from './player/sourcePreparer.js';
import { TransitionCoordinator } from './player/transitionCoordinator.js';
import { MixerPipeline, PCM_WAIT_TIMEOUT_MS } from './player/mixerPipeline.js';
import { createFileSource } from '../audio/pcmSource.js';
import { analyzeTrackFile } from '../audio/trackAnalysis.js';
import { resetSessionTempo, probeTempoBackend, compensateDurationSec } from '../audio/tempo.js';
import { LoopMode } from './queue.js';
import { getAnalysisQueue, getStemPreparationQueue } from '../audio/analysisQueue.js';
import { getCachedStems, separateTrackStems } from '../audio/stemCache.js';
import { planStemTransition } from '../audio/stemTransition.js';
import { logTransitionPlan, logGaplessTransition } from '../audio/transitionLog.js';
import { StemPreparationState, StemPrefetchTracker } from '../audio/stemPrefetch.js';

const QUEUE_EXHAUSTED_TIMEOUT = 30_000;
// Codex review (PR #43, round 4): #pendingGaplessFrom is stashed instance
// state that can outlive the specific autoplay continuation it was meant
// for (e.g. recommend-mode returns `true` without immediately starting a
// track) — bound its validity to a short window so a much-later, unrelated
// playNext() call (a fresh /play after the player sat idle) can't
// misattribute a stale gapless transition.
const PENDING_GAPLESS_MAX_AGE_MS = 30_000;
/**
 * Default AudioPlayer.maxMissedFrames is 5 (100 ms of null opus reads), after
 * which stop() destroy()s the session MixStream. ffmpeg/yt-dlp hiccups are
 * longer than that; 50 × 20 ms = 1 s.
 */
export const MIXER_MAX_MISSED_FRAMES = 50;
// Moved to player/mixerPipeline.js with the pipeline code; re-exported so
// existing importers (tests) keep working.
export { PCM_WAIT_TIMEOUT_MS, MIXER_AUDIO_RESOURCE_OPTIONS } from './player/mixerPipeline.js';

export const MIXER_AUDIO_PLAYER_OPTIONS = {
  behaviors: {
    // Default Pause: if the VC drops out of Ready (reconnect), do not keep
    // reading MixStream and discarding packets / advancing tracks unheard.
    // sessions.js already waits for Ready before constructing GuildPlayer.
    noSubscriber: NoSubscriberBehavior.Pause,
    maxMissedFrames: MIXER_MAX_MISSED_FRAMES,
  },
};

export class GuildPlayer {
  #guildId;
  #connection;
  #queue;
  #onDisconnect;
  #handleQueueExhausted;
  #queueExhaustedTimeoutMs;
  #recordPlayFn;
  #onTrackStart;
  #pauseRequested = false;
  #audioPlayer;
  #forceSkip = false;
  #hadError = false;
  #playbackStart = 0;
  #lastActiveAt = 0;
  #watchdog;
  #currentTempFile = null;
  // Phase 8: mirrors #incomingMeasured's lifecycle exactly (set at spawn,
  // transferred at every point #currentTempFile itself is transferred from
  // #incomingTempFile, cleared at every point #currentTempFile is cleared)
  // so #ensureOutgoingStemPrep() can loudnorm the outgoing stems with the
  // same measured LUFS value the currently-playing full-mix source used.
  #currentMeasured = null;
  #pipeline;
  #analysis;
  #sourcePreparer;
  #transitions;
  #advancement;
  #analysisQueue;
  /**
   * Phase 9C (docs/mix-transition-phase9.md §5): dedicated pausable serial
   * queue for full-track Demucs only (Phase 8's outgoing-track separation
   * and Phase 9B's next/next+1 prefetch), kept separate from
   * #analysisQueue so a long-running Demucs job can never sit in front of
   * (or share pause/kill state with) realtime BPM/downbeat/phrase/key/
   * vocal-activity analysis for an unrelated track. Same DI convention as
   * #analysisQueue: null falls back to the process-wide
   * getStemPreparationQueue() singleton via #stemQ().
   */
  #stemQueue;
  /** Phase 9A (docs/mix-transition-phase9.md §3): test-only override — see logTransitionPlan()'s own docstring for the always-on-metrics/MIX_DEBUG-gated-log split. */
  #logTransitionPlanFn;
  /** Phase 9A (Codex review, PR #43): test-only override — see logGaplessTransition()'s own docstring for why the snap-handoff path needs a separate, report-less logging entry point. */
  #logGaplessTransitionFn;
  /** Test-only override — the two stem-prep methods call createFileSource() directly (they bypass #createPcmSource entirely, since stem WAVs need no download/normalize/loudnorm pass), so a dedicated injection point mirrors this file's existing DI convention for every other real-process spawn. */
  #createFileSourceFn;
  /**
   * Phase 9B (docs/mix-transition-phase9.md §4): per-videoId prefetch
   * bookkeeping for next (HIGH) / next+1 (LOW), driven from
   * #prefetchUpcoming(). Purely observational for the HIGH lane (B already
   * gets a real download+separate pass from Phase 8's own
   * #ensureFullPrefetch()/#scheduleAnalysis() pipeline regardless of this
   * tracker's existence); for the LOW lane (C) it also drives the actual
   * dispatch, since nothing else in the pipeline keeps C's audio around
   * long enough for Demucs — see #ensureStemPrefetch()/#runLowPriorityStemPrefetch().
   */
  #stemPrefetchTracker = new StemPrefetchTracker();
  /**
   * Stop lifecycle guard. #stopGeneration bumps synchronously at every
   * stop() invocation — before any of its async teardown runs — so every
   * path that can race stop's cleanup window (playNext's source prep, a
   * PlaybackService.enqueue start decision) snapshots it and abandons the
   * moment a stop begins instead of reviving playback on the rebuilt
   * mixer. #stopTail serializes the teardown itself (overlapping stop()s
   * run one at a time) and is the single "no stop in flight" await point;
   * it never rejects so awaiters can't be poisoned by a teardown error
   * (the stop() caller itself still sees the rejection via `tail`).
   */
  #stopGeneration = 0;
  #stopping = false;
  #stopTail = Promise.resolve();

  constructor({
    guildId,
    connection,
    queue,
    onDisconnect,
    handleQueueExhausted = null,
    queueExhaustedTimeoutMs = QUEUE_EXHAUSTED_TIMEOUT,
    recordPlayFn = null,
    onTrackStart = null,
    audioPlayer = createAudioPlayer(MIXER_AUDIO_PLAYER_OPTIONS),
    createAudioResourceFn = createAudioResource,
    resolveAudioStreamFn = resolveAudioStream,
    /**
     * Test-only override for the real normalize/prefetch pcm source
     * pipeline. §9.3/§2.3/§8.4: the player treats a returned source's
     * `tempoHonored !== false` as "startSec/tempoFilter were actually
     * applied" and stashes beatmix/phrase promotion bookkeeping (session
     * tempo, entry-offset subtraction) accordingly — a custom factory that
     * ignores startSec/tempoFilter must set `source.tempoHonored = false`,
     * or the player will wrongly believe a plain/native-tempo source was
     * seeked and stretched as requested.
     */
    createPcmSourceFn = null,
    getTrackAnalysisFn = null,
    putTrackAnalysisFn = null,
    analyzeTrackFileFn = analyzeTrackFile,
    analysisQueue = null,
    stemQueue = null,
    prefetchTrackFn = prefetchTrack,
    probeTempoBackendFn = probeTempoBackend,
    stageTempFileCopyFn = stageTempFileCopy,
    separateTrackStemsFn = separateTrackStems,
    getCachedStemsFn = getCachedStems,
    planStemTransitionFn = planStemTransition,
    createFileSourceFn = createFileSource,
    logTransitionPlanFn = logTransitionPlan,
    logGaplessTransitionFn = logGaplessTransition,
    pcmWaitTimeoutMs = PCM_WAIT_TIMEOUT_MS,
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
    this.#analysisQueue = analysisQueue;
    this.#stemQueue = stemQueue;
    this.#createFileSourceFn = createFileSourceFn;
    this.#logTransitionPlanFn = logTransitionPlanFn;
    this.#logGaplessTransitionFn = logGaplessTransitionFn;

    // Mixer + first-PCM wait lifecycle — the session-lived MixStream, the
    // opus resource attach/rebuild, and the dead-mixer recovery paths —
    // lives in the MixerPipeline (same DI pattern as the coordinators
    // below). Built first because #transitions reaches it through the
    // getMixStream thunk; the advancement/handoff entry points
    // (#advancement.advanceAfterPlayback/#onCrossfadePromoted/
    // #onSnapHandoff/playNext) are injected as bound callbacks into it, so
    // `this` still resolves to the right owner inside them.
    this.#pipeline = new MixerPipeline({
      audioPlayer,
      connection,
      createAudioResourceFn,
      pcmWaitTimeoutMs,
      pauseSource: this,
      getQueueCurrent: () => this.#queue.current,
      isHandlingAfter: () => this.#advancement.handlingAfter,
      isForceSkip: () => this.#forceSkip,
      markHadError: () => {
        this.#hadError = true;
      },
      advanceAfterPlayback: () => this.#advancement.advanceAfterPlayback(),
      onCrossfadePromoted: () => this.#onCrossfadePromoted(),
      onSnapHandoff: (adopt) => this.#onSnapHandoff(adopt),
      onIncomingError: (err) => {
        // Mid-fade incoming failure: MixStream already cleared overlap and
        // kept outgoing. Reset arm state so #maybeStartCrossfade can retry,
        // and drop any normalize temp created for the failed incoming leg.
        console.warn('[GuildPlayer] mix incoming error:', err.message);
        this.#transitions.crossfadeStarted = false;
        this.#transitions.crossfadeTargetTrack = null;
        // §2.3/§8.4: this attempt never reached promotion — a stashed
        // beatmix tempo here belongs to the failed incoming, not whatever
        // eventually does get promoted. Left set, it would wrongly apply to
        // a later, unrelated (possibly non-beatmix) promotion.
        this.#transitions.pendingSessionTempo = null;
        this.#transitions.pendingIncomingEntrySec = 0;
        this.#sourcePreparer.cleanupIncomingTempFile().catch((cleanupErr) => {
          console.warn('[GuildPlayer] incoming temp cleanup failed:', cleanupErr.message);
        });
      },
      playNext: () => this.playNext(),
      getAnalysisQueue: () => this.#analysisQ(),
      getStemQueue: () => this.#stemQ(),
    });

    // Analysis/stem-separation scheduling + caches live in the coordinator;
    // the player only applies settled results (duration/tempo) via the
    // applyAnalysisDuration callback.
    this.#analysis = new AnalysisCoordinator({
      analyzeTrackFileFn,
      getTrackAnalysisFn,
      putTrackAnalysisFn,
      separateTrackStemsFn,
      stageTempFileCopyFn,
      stemPrefetchTracker: this.#stemPrefetchTracker,
      analysisQueue,
      stemQueue,
      applyAnalysisDuration: (track, analysis) => this.#maybeApplyAnalysisDuration(track, analysis),
    });
    // Next-source preparation — the prefetch window, the prepared incoming
    // source, and the prepared stem pairs — lives in the SourcePreparer
    // (same DI pattern as the coordinator above). Current-track temp-file
    // ownership and the duration/tempo apply step stay here via callbacks.
    this.#sourcePreparer = new SourcePreparer({
      queue,
      analysis: this.#analysis,
      stemPrefetchTracker: this.#stemPrefetchTracker,
      analysisQueue,
      stemQueue,
      prefetchTrackFn,
      resolveAudioStreamFn,
      createPcmSourceFn,
      createFileSourceFn,
      getCachedStemsFn,
      separateTrackStemsFn,
      stageTempFileCopyFn,
      setCurrentTemp: (filePath, measured) => {
        this.#currentTempFile = filePath;
        this.#currentMeasured = measured;
      },
      getCurrentMeasured: () => this.#currentMeasured,
      applyAnalysisDuration: (track, analysis) => this.#maybeApplyAnalysisDuration(track, analysis),
    });
    // Transition planning/arming — the crossfade arm timer, candidate
    // evaluation + plan selection, and the session-tempo / promotion
    // bookkeeping those decisions carry — lives in the TransitionCoordinator
    // (same DI pattern as #analysis/#sourcePreparer). The advancement loop
    // itself now lives in QueueAdvancement below; the remaining handoff
    // paths (#playNextMixer/#onCrossfadePromoted/#onSnapHandoff) stay here
    // and read/write the coordinator's public state fields.
    this.#transitions = new TransitionCoordinator({
      guildId,
      queue,
      analysis: this.#analysis,
      sourcePreparer: this.#sourcePreparer,
      audioPlayer,
      getMixStream: () => this.#pipeline.mixStream,
      isForceSkip: () => this.#forceSkip,
      isHandlingAfter: () => this.#advancement.handlingAfter,
      maybeRefillQueue: () => this.#advancement.maybeRefillQueue(),
      resolvePlaybackDurationSec: (track) => this.#resolvePlaybackDurationSec(track),
      probeTempoBackendFn,
      getCachedStemsFn,
      planStemTransitionFn,
      logTransitionPlanFn,
    });
    this.#watchdog = new PlaybackWatchdog({
      getAudioPlayerState: () => this.#audioPlayer.state,
      getLastActiveAt: () => this.#lastActiveAt,
      markActive: () => {
        this.#lastActiveAt = Date.now();
      },
      onStall: () => {
        console.warn('[GuildPlayer] watchdog: stall detected');
        this.#hadError = true;
        this.mixStream?.dropCurrent();
        // Codex review (PR #45, P1): same silent underrun-state reset as the
        // other dropCurrent() call sites.
        this.#stemQ().noteUnderrunCleared(this);
      },
    });

    // After-playback advancement — the serialized handleAfter drain, the
    // force-skip/error ordering, and the queue-exhaustion/refill machinery
    // — lives in QueueAdvancement (same DI pattern as the coordinators
    // above). Built after #transitions/#sourcePreparer because it drives
    // them directly; the pipeline/transitions thunks above only reach it
    // lazily, so this ordering is safe.
    this.#advancement = new QueueAdvancement({
      queue,
      handleQueueExhausted,
      queueExhaustedTimeoutMs,
      transitions: this.#transitions,
      sourcePreparer: this.#sourcePreparer,
      playNext: (gaplessFrom) => this.playNext(gaplessFrom),
      disconnect: () => this.#disconnect(),
      cleanupCurrentTempFile: () => this.#cleanupCurrentTempFile(),
      clearWatchdog: () => this.#clearWatchdog(),
      isStopping: () => this.#stopping,
      isForceSkip: () => this.#forceSkip,
      clearForceSkip: () => {
        this.#forceSkip = false;
      },
      isHadError: () => this.#hadError,
      clearHadError: () => {
        this.#hadError = false;
      },
      getPlaybackStart: () => this.#playbackStart,
    });

    this.#pipeline.initMixerPipeline();
    this.#audioPlayer.on(AudioPlayerStatus.Idle, () => {
      if (!this.#pipeline.mixerStarted || this.#pipeline.idleRecovering) return;
      console.warn('[GuildPlayer] unexpected Idle, recovering mixer playback');
      this.#pipeline.idleRecovering = true;
      // Never play the rebuilt mixer empty: MixStream's 8s underrun guard
      // would sourceerror while playNext is still downloading/analyzing.
      // handleAfter already calls playNext; mid-track Idle must restart here.
      this.#pipeline.recoverMixerPlayback({ play: false });
      const restartCurrent = this.#queue.current && !this.#advancement.handlingAfter && !this.#forceSkip;
      const done = () => { this.#pipeline.idleRecovering = false; };
      if (restartCurrent) {
        this.playNext().catch((err) => {
          console.error('[GuildPlayer] mixer Idle restart failed:', err.message);
        }).finally(done);
      } else {
        done();
      }
    });

    this.#audioPlayer.on('stateChange', (oldState, newState) => {
      if (newState.status === AudioPlayerStatus.Playing) {
        this.#lastActiveAt = Date.now();
      }
    });

    this.#audioPlayer.on('error', err => {
      console.error('[GuildPlayer] audioPlayer error:', err);
      this.#hadError = true;
      this.#pipeline.abortSourceAudioWait();
      this.mixStream?.dropCurrent();
      // Codex review (PR #45, P1): dropCurrent() resets MixStream's own
      // underrun state WITHOUT emitting 'underrunClear' — if this player
      // had a stem-queue pause source registered (mid-underrun when this
      // error hit), nothing would ever clear it otherwise, indefinitely
      // SIGSTOPping the shared process-wide stem queue's current job for
      // every guild. See MixerPipeline.initMixerPipeline()s 'underrun' wiring.
      this.#stemQ().noteUnderrunCleared(this);
    });

    // AutoPaused means playable.length === 0. Re-subscribe so a Ready
    // connection is visible on the next 20 ms tick and playback resumes.
    this.#audioPlayer.on(AudioPlayerStatus.AutoPaused, () => {
      this.#connection?.subscribe?.(this.#audioPlayer);
    });

    this.#connection.subscribe(this.#audioPlayer);
    this.#connection.on?.('stateChange', (_oldState, newState) => {
      if (newState?.status === VoiceConnectionStatus.Destroyed) {
        this.#pipeline.abortSourceAudioWait();
      }
    });
  }

  /**
   * Codex review (PR #43, round 3): `gaplessFrom` — the track that just
   * naturally finished, when this call is a hard handoff (no crossfade, no
   * snap adoption) — is consume-once via #pendingGaplessFrom when the
   * caller doesn't pass it explicitly, so the external autoplay-continuation
   * path (#handleAfter's #startQueueRefill branch, whose own
   * handleQueueExhausted callback eventually calls this public method after
   * adding a track) is covered too, not just #handleAfter's own direct
   * playNext() call. Logged only after #playNextMixer's setCurrent()
   * actually accepts the source (see there) — never here — so a track that
   * fails to start (Codex round-3 P2) doesn't get counted as a committed
   * transition.
   */
  async playNext(gaplessFrom = null) {
    // A stop() in flight always wins: a playNext issued inside stop()'s
    // teardown window abandons here instead of starting on a mixer the
    // tail is about to endMixer() and rebuild. Callers that decide start
    // eligibility themselves (PlaybackService.enqueue) gate on
    // isStopping/stopGeneration up front, so what reaches here mid-stop
    // is a stale internal path (advancement drain, Idle recovery) whose
    // start must not survive the stop.
    const generation = this.#stopGeneration;
    if (this.#stopping) {
      await this.#stopTail;
      return;
    }
    const track = this.#queue.current;
    if (!track) {
      await this.#disconnect();
      return;
    }
    const pending = this.#transitions.pendingGaplessFrom;
    this.#transitions.pendingGaplessFrom = null;
    const pendingStillFresh = pending && Date.now() - pending.setAt < PENDING_GAPLESS_MAX_AGE_MS;
    const resolvedGaplessFrom = gaplessFrom ?? (pendingStillFresh ? pending.track : null);
    await this.#playNextMixer(track, { gaplessFrom: resolvedGaplessFrom, generation });
  }

  async #playNextMixer(track, { gaplessFrom = null, generation = this.#stopGeneration } = {}) {
    if (this.#advancement.queueRefill && this.#advancement.queueRefill.key !== this.#advancement.queueRefillKey(track)) {
      this.#advancement.queueRefill = null;
    }
    let source;
    try {
      source = await this.#sourcePreparer.takePreparedIncoming(track, { forPlayback: true });
    } catch (err) {
      console.warn(`[GuildPlayer] pcm source failed for ${track.title}:`, err.message);
      this.#hadError = true;
      // A stop() that began during the prep await owns teardown — kicking
      // the advancement drain here could end in a disconnect the stop
      // never asked for.
      if (this.#stopGeneration !== generation) return;
      if (this.#advancement.handlingAfter) {
        this.#advancement.pendingAfter = true;
      } else {
        this.#advancement.advanceAfterPlayback();
      }
      return;
    }

    if (this.#stopGeneration !== generation) {
      // A stop() began while this source was being prepared: it already
      // cleared the queue and owns teardown — abandoning here must not
      // fall into the no-current disconnect below (/stop is not /leave).
      source.destroy();
      await this.#cleanupCurrentTempFile();
      return;
    }
    if (this.#queue.current !== track) {
      source.destroy();
      await this.#cleanupCurrentTempFile();
      if (!this.#queue.current) await this.#disconnect();
      return;
    }
    if (this.#forceSkip) {
      source.destroy();
      await this.#cleanupCurrentTempFile();
      this.#forceSkip = false;
      const nextTrack = this.#queue.next({ forceAdvance: true });
      if (nextTrack === null) {
        await this.#disconnect();
      } else {
        await this.playNext();
      }
      return;
    }

    // Wait for real PCM *before* setCurrent. MixStream's 8s underrun guard
    // starts as soon as a current source is attached; a slow decoder would
    // sourceerror/skip the track while this 15s wait was still pending.
    // Between tracks MixStream stays in keep-alive silence until then.
    const waitGeneration = this.#pipeline.pcmWaitGeneration;
    const waited = await this.#pipeline.waitForSourceAudio(source);
    if (this.#pipeline.isSourceAudioWaitSuperseded(track, waited, waitGeneration)) {
      this.#pipeline.discardUnusedSource(source);
      return;
    }
    if (waited !== 'ready') {
      this.#pipeline.discardUnusedSource(source);
      this.#hadError = true;
      if (this.#advancement.handlingAfter) {
        this.#advancement.pendingAfter = true;
      } else {
        this.#advancement.advanceAfterPlayback();
      }
      return;
    }
    if (this.#stopGeneration !== generation) {
      // Same overtake guard as after the prep await: a stop that began
      // during the PCM wait owns teardown — discard, never setCurrent.
      this.#pipeline.discardUnusedSource(source);
      return;
    }

    this.#playbackStart = Date.now();
    this.#lastActiveAt = Date.now();
    this.#resetWatchdog();
    this.#advancement.playbackCount += 1;

    // Rebuild first if Idle/stop ended the mixer, attach PCM, then play.
    // Playing before setCurrent leaves MixStream with no current source and
    // starts the underrun guard against silence.
    if (this.#pipeline.isMixerDead()) {
      this.#pipeline.recoverMixerPlayback({ play: false });
    }
    const durationSec = this.#resolvePlaybackDurationSec(track);
    if (!this.mixStream.setCurrent(source, { durationSec })) {
      return;
    }
    // Codex review (PR #43, round 3): only now that setCurrent() has
    // actually accepted this source — a track that fails earlier in this
    // method (PCM/source-audio-wait errors above) never reaches here and is
    // correctly never counted as a committed transition.
    if (gaplessFrom) {
      // Codex review (PR #43, round 4): prefer a fresh evaluation of this
      // exact pair from #maybeStartCrossfade() (the plan that was actually
      // in flight when prep raced EOF) over the generic gapless stub, so
      // the log reflects what was really evaluated/missed.
      const evaluated = this.#transitions.takeMatchingEvaluatedTransition(gaplessFrom, track);
      if (evaluated) {
        this.#logTransitionPlanFn(evaluated);
      } else {
        this.#logGaplessTransitionFn({ outgoingTrack: gaplessFrom, incomingTrack: track });
      }
    }
    this.#transitions.resetSessionTempoFor(track);
    // Attach the opus pipeline only after PCM has arrived so the encoder's
    // first packet is music, not keep-alive silence. A /pause during the
    // wait leaves AudioPlayer Idle; honor it and do not start until resume.
    if (!this.#pauseRequested) {
      this.#pipeline.ensureMixerPlaying();
    }
    this.#sourcePreparer.clearPreparedIncoming();
    this.#transitions.crossfadeStarted = false;
    this.#transitions.crossfadeTargetTrack = null;
    // A fresh track start must never carry a stale beatmix stash from a
    // prior, abandoned crossfade attempt (§2.3/§8.4) — #resetSessionTempoFor
    // above already establishes this track's own baseline.
    this.#transitions.pendingSessionTempo = null;
    this.#transitions.pendingIncomingEntrySec = 0;
    this.#transitions.currentEntrySec = 0;
    this.#transitions.currentEntryOverlapConsumedSec = 0;
    this.#transitions.startCrossfadeArm();
    this.#sourcePreparer.prefetchUpcoming();
    this.#sourcePreparer.ensureIncomingPrepForUpcoming();
    this.#recordPlay(track);
    this.#onTrackStart?.(track.videoId);
  }

  #resolvePlaybackDurationSec(track) {
    if (!track) return null;
    if (track.videoId && this.#analysis.probedDurationCache.has(track.videoId)) {
      return this.#analysis.probedDurationCache.get(track.videoId);
    }
    if (track.videoId && this.#analysis.analysisCache.has(track.videoId)) {
      const fromAnalysis = this.#analysis.analysisCache.get(track.videoId)?.durationSec;
      if (fromAnalysis != null) return fromAnalysis;
    }
    return track.duration ?? null;
  }

  #analysisQ() {
    return this.#analysisQueue ?? getAnalysisQueue();
  }

  /** Phase 9C (docs/mix-transition-phase9.md §5): the dedicated StemPreparationQueue — see #stemQueue's own docstring. */
  #stemQ() {
    return this.#stemQueue ?? getStemPreparationQueue();
  }

  async #onSnapHandoff(adopt) {
    // Error path already dropCurrent → #handleAfter; adopting here would
    // advance the queue twice and skip/replace the snapped-in track.
    if (
      this.#hadError
      || this.#advancement.handlingAfter
      || this.#transitions.crossfadeStarted
      || this.mixStream?.isCrossfading
    ) return;
    const current = this.#queue.current;
    if (!current) return;
    const next = this.#queue.loopMode === LoopMode.TRACK
      ? current
      : this.#queue.upcoming()[0];
    if (!next || this.#sourcePreparer.preparedIncoming?.track !== next) return;

    const source = this.#sourcePreparer.preparedIncoming.source;
    if (!source) return;

    // §2.3/§8.4: prep may have already spawned this source with a beatmix
    // tempo filter baked in (see #ensureIncomingPrep) even though the
    // crossfade itself never armed in time — a natural end-of-stream raced
    // it. Adopting the source without carrying that stretch forward would
    // desync session tempo bookkeeping from what is actually playing.
    // Same tempoHonored check as #maybeStartCrossfade (Codex round-2): if
    // prep fell back to createStreamSource, the prep record still describes
    // the ORIGINALLY-REQUESTED startSec/tempoFilter, not what the source
    // actually does — trusting it here would corrupt duration/tempo
    // bookkeeping the same way an unchecked stash would in the crossfade path.
    const sourceHonorsPlan = source.tempoHonored !== false;
    const promotedTempo = sourceHonorsPlan ? (this.#sourcePreparer.preparedIncoming.prep?.sessionTempo ?? null) : null;
    const tempoRatio = promotedTempo?.tempoRatio ?? 1;
    // Same native-seek-offset subtraction as #onCrossfadePromoted (Codex
    // round-1 P1) — this source may have been spawned with startSec baked
    // in even though it's being adopted outside a crossfade.
    const entrySec = sourceHonorsPlan ? (this.#sourcePreparer.preparedIncoming.prep?.startSec ?? 0) : 0;
    const nativeDurationSec = this.#resolvePlaybackDurationSec(next);
    const remainingNativeDurationSec = nativeDurationSec != null
      ? Math.max(0, nativeDurationSec - entrySec)
      : null;
    if (!adopt(source, { durationSec: compensateDurationSec(remainingNativeDurationSec, tempoRatio) })) {
      // Failed adopt (e.g. prefetched decoder already errored): drop the bad
      // prepared entry so trackend / playNext retries a fresh source.
      this.#sourcePreparer.clearPreparedIncoming();
      await this.#sourcePreparer.cleanupIncomingTempFile();
      return;
    }

    // Codex review (PR #43): this is a real, committed track handoff that
    // never touches #maybeStartCrossfade()'s own [MIX PLAN] report/log — no
    // candidate evaluation runs on this path (a prepared source simply won
    // the race to EOF), so record it separately or `totalTransitions`
    // undercounts real playback and `selected.gapless` never populates.
    // Codex review (PR #43, round 4): prefer a fresh evaluation of this
    // exact pair over the generic stub, same reasoning as #playNextMixer's
    // own gapless log site.
    const evaluated = this.#transitions.takeMatchingEvaluatedTransition(current, next, entrySec);
    if (evaluated) {
      this.#logTransitionPlanFn(evaluated);
    } else {
      this.#logGaplessTransitionFn({ outgoingTrack: current, incomingTrack: next }, { kind: 'snap-handoff' });
    }

    this.#sourcePreparer.takePreparedIncomingEntry();
    // A stem-mix attempt could have been prepping in parallel with this
    // snap-adopted full-mix source — #clearPreparedIncoming() is what
    // normally piggybacks the stem cleanup onto every abandoned-prep call
    // site, but this path sets #preparedIncoming directly (adopting the
    // source, not discarding it) and would otherwise leave four ffmpeg
    // processes alive for the rest of the adopted track.
    this.#sourcePreparer.clearPreparedOutgoingStems();
    this.#sourcePreparer.clearPreparedIncomingStems();
    // Same reasoning as #onCrossfadePromoted()/#handleAfter()'s reset
    // (Codex): a snap-adopted plain source is a THIRD way this (current,
    // next) pair's transition attempt can conclude, alongside those two —
    // an earlier failed stem-mix attempt for this exact pair must not
    // leave it permanently downgraded for a later QUEUE-loop/duplicate
    // recurrence just because THIS occurrence happened to resolve via
    // snap-adoption instead of a crossfade promotion or a natural end.
    this.#transitions.stemMixUnavailableKey = null;
    const outgoingTemp = this.#currentTempFile;
    this.#sourcePreparer.promoteIncomingTempToCurrent();

    if (this.#queue.loopMode !== LoopMode.TRACK && this.#queue.current !== next) {
      this.#queue.next({ forceAdvance: true });
    }

    this.#transitions.crossfadeStarted = false;
    this.#transitions.crossfadeTargetTrack = null;
    // Defensive: this path only runs when no crossfade was in flight (see
    // the guard above), so #pendingSessionTempo should already be null —
    // but never let a stale stash from an earlier aborted attempt leak into
    // a later #onCrossfadePromoted call.
    this.#transitions.pendingSessionTempo = null;
    this.#transitions.pendingIncomingEntrySec = 0;
    this.#transitions.currentEntrySec = entrySec;
    // No overlap ran on this path (a prepared source simply won the race to
    // EOF — see this function's own docstring), so positionSec starts at 0.
    this.#transitions.currentEntryOverlapConsumedSec = 0;
    this.#transitions.clearCrossfadeArm();
    this.#playbackStart = Date.now();
    this.#lastActiveAt = Date.now();
    this.#advancement.playbackCount += 1;
    if (promotedTempo) {
      this.#transitions.sessionTempo = promotedTempo;
    } else {
      this.#transitions.resetSessionTempoFor(next);
    }
    this.#transitions.startCrossfadeArm();
    this.#sourcePreparer.prefetchUpcoming();
    this.#sourcePreparer.ensureIncomingPrepForUpcoming();
    this.#recordPlay(this.#queue.current);
    this.#onTrackStart?.(this.#queue.current?.videoId);

    if (outgoingTemp) {
      await cleanupTempFile(outgoingTemp);
    }
  }

  async #onCrossfadePromoted() {
    this.#forceSkip = false;
    this.#hadError = false;
    this.#transitions.clearCrossfadeArm();
    // Codex: #stemMixUnavailableKey scopes a failed stem-mix attempt to the
    // (current, next) pair it happened against — clear it here, once that
    // pairing's transition attempt has actually concluded (this fires for
    // every promotion, stem-mix or not), so a LATER recurrence of the same
    // videoId pair (QUEUE loop mode, a duplicated playlist entry) gets a
    // fresh, unbiased stem-mix attempt instead of staying downgraded for
    // the rest of the GuildPlayer's lifetime over a since-resolved (or
    // simply transient) earlier failure.
    this.#transitions.stemMixUnavailableKey = null;

    const target = this.#transitions.crossfadeTargetTrack;
    this.#transitions.crossfadeTargetTrack = null;

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
    this.#sourcePreparer.promoteIncomingTempToCurrent();

    const nextTrack = this.#queue.current;
    if (!nextTrack) {
      if (outgoingTemp) await cleanupTempFile(outgoingTemp);
      await this.#disconnect();
      return;
    }

    this.#playbackStart = Date.now();
    this.#lastActiveAt = Date.now();
    this.#advancement.playbackCount += 1;
    this.#transitions.crossfadeStarted = false;
    // §8.4: a beatmix transition stashed the incoming track's stretched
    // tempo state in #pendingSessionTempo when the crossfade started — carry
    // it forward instead of resetting to native BPM. Any other transition
    // (no stash) resets to the new current track's native BPM, same as
    // before. #resolvePlaybackDurationSec returns native duration; convert
    // to playback-domain by whichever tempo state actually applies.
    const promotedTempo = this.#transitions.pendingSessionTempo;
    const promotedEntrySec = this.#transitions.pendingIncomingEntrySec;
    this.#transitions.pendingSessionTempo = null;
    this.#transitions.pendingIncomingEntrySec = 0;
    // This source is now #current — later arm-loop ticks must subtract this
    // from any exit timestamp they compare against positionSec (see
    // #currentEntrySec's own comment).
    this.#transitions.currentEntrySec = promotedEntrySec;
    if (promotedTempo) {
      this.#transitions.sessionTempo = promotedTempo;
    } else {
      this.#transitions.resetSessionTempoFor(nextTrack);
    }
    // Codex review (PR #52, P2, round 2): MixStream.setCurrent() (mixStream.js)
    // already initialized positionSec to the overlap portion just consumed
    // (fadeElapsedSec + incomingSkippedSec) by the time this synchronous
    // handler runs — snapshot it now, in native seconds, before any further
    // playback advances it. See #currentEntryOverlapConsumedSec's own
    // comment for why this must be captured once here rather than derived
    // live from positionSec on every later arm-loop tick.
    this.#transitions.currentEntryOverlapConsumedSec = (this.mixStream?.positionSec ?? 0) * this.#transitions.sessionTempo.tempoRatio;
    // The incoming source was seeked forward by promotedEntrySec (native
    // seconds) at spawn — its remaining native content is only
    // (duration - promotedEntrySec), not the full native duration. Convert
    // to playback-domain last, same as everywhere else (Codex round-1 P1).
    const nativeDurationSec = this.#resolvePlaybackDurationSec(nextTrack);
    const remainingNativeDurationSec = nativeDurationSec != null
      ? Math.max(0, nativeDurationSec - promotedEntrySec)
      : null;
    this.mixStream?.setDurationSec(
      compensateDurationSec(remainingNativeDurationSec, this.#transitions.sessionTempo.tempoRatio),
    );
    this.#pipeline.ensureMixerPlaying();
    this.#transitions.startCrossfadeArm();
    this.#sourcePreparer.prefetchUpcoming();
    this.#sourcePreparer.ensureIncomingPrepForUpcoming();
    this.#recordPlay(nextTrack);
    this.#onTrackStart?.(nextTrack.videoId);

    if (outgoingTemp) {
      await cleanupTempFile(outgoingTemp);
    }
  }

  get mixStream() {
    return this.#pipeline.mixStream;
  }

  get positionSec() {
    return this.mixStream?.positionSec ?? 0;
  }

  /**
   * Position on the track's own timeline: MixStream.positionSec plus the
   * native offset the current source's decoder started at (seeked sources,
   * beatmix/stem promotions). Use this for display — plain positionSec is
   * relative to decoder start.
   */
  get trackPositionSec() {
    // positionSec is in the playback (output-frame) domain; convert it to
    // native seconds with the session tempo ratio before adding the entry
    // offset — same formula as #currentEntryOverlapConsumedSec.
    const ratio = this.#transitions.sessionTempo?.tempoRatio ?? 1;
    return (this.#transitions.currentEntrySec ?? 0) + (this.mixStream?.positionSec ?? 0) * ratio;
  }

  get sessionTempo() {
    return this.#transitions.sessionTempo;
  }

  /**
   * Phase 9B (docs/mix-transition-phase9.md §4): read-only snapshot of the
   * stem prefetch tracker, for tests/observability. Not consumed by any
   * playback decision — transition mode selection stays exactly what it
   * was (that's Phase 9D's job), this only reports what #prefetchUpcoming()
   * has learned so far about next/next+1's stem-separation progress.
   */
  get stemPrefetchStatus() {
    return this.#stemPrefetchTracker.snapshot();
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
    if (this.#audioPlayer.pause()) {
      this.#pauseRequested = true;
      return true;
    }
    // AudioPlayer.pause() is a no-op while Idle (PCM still buffering).
    if (this.#pipeline.cancelSourceAudioWait != null || Boolean(this.mixStream?.currentSource)) {
      this.#pauseRequested = true;
      return true;
    }
    return false;
  }

  get status() {
    return this.#audioPlayer.state.status;
  }

  /**
   * Stop lifecycle counter: incremented synchronously at every stop()
   * entry. PlaybackService.enqueue snapshots it so a stop that began
   * after the enqueue entered is detected even once the stop finished.
   */
  get stopGeneration() {
    return this.#stopGeneration;
  }

  /** True while a stop()'s serialized teardown tail is in flight. */
  get isStopping() {
    return this.#stopping;
  }

  /**
   * Settles once the in-flight stop() teardown finishes (immediately when
   * none is running) — never rejects. Awaited by anything that must not
   * run inside stop()'s async cleanup window.
   */
  get stopTail() {
    return this.#stopTail;
  }

  resume() {
    if (this.#pauseRequested) {
      this.#pauseRequested = false;
      if (this.#pipeline.cancelSourceAudioWait) return true;
      if (this.mixStream?.currentSource) {
        if (!this.#pipeline.mixerStarted) this.#pipeline.ensureMixerPlaying();
        else this.#audioPlayer.unpause();
        return true;
      }
      return true;
    }
    return this.#audioPlayer.unpause();
  }

  /**
   * Seek within the current track by rebuilding the PCM source at an
   * offset and adopting it in place — no trackend, no queue advance.
   * Normalized (file) sources seek via ffmpeg -ss; stream sources
   * re-resolve with yt-dlp --download-sections.
   * @param {number} targetSec absolute position on the native timeline
   * @returns {Promise<number|false>} the applied (clamped) position, or
   *          false when nothing is playing / a crossfade is in flight
   */
  async seekTo(targetSec) {
    const track = this.#queue.current;
    if (!track || !this.mixStream?.currentSource || this.mixStream.isDestroyed()) return false;
    if (this.mixStream.isCrossfading || this.#advancement.handlingAfter) return false;
    const durationSec = this.#resolvePlaybackDurationSec(track);
    let target = Math.max(0, targetSec);
    if (durationSec != null) target = Math.min(target, Math.max(0, durationSec - 0.5));
    let source;
    try {
      if (this.#currentTempFile) {
        // Reuse the already-normalized file: -ss inside it instead of a
        // full re-download + re-loudnorm (and #currentTempFile stays the
        // tracked owner, so the old file isn't orphaned).
        const fileSource = this.#createFileSourceFn ?? createFileSource;
        source = fileSource(this.#currentTempFile, { measured: this.#currentMeasured, startSec: target });
        source.tempoHonored = true;
      } else {
        source = await this.#sourcePreparer.createPcmSource(track, { startSec: target });
      }
    } catch (err) {
      console.error('[GuildPlayer] seek source failed:', err);
      return false;
    }
    // Same rule as playNext: wait for real PCM before adopting — the
    // MixStream underrun guard starts as soon as a current source is
    // attached, so a still-buffering decoder would sourceerror the track.
    const waitGeneration = this.#pipeline.pcmWaitGeneration;
    const waited = await this.#pipeline.waitForSourceAudio(source);
    if (this.#pipeline.isSourceAudioWaitSuperseded(track, waited, waitGeneration) || waited !== 'ready') {
      source.destroy?.();
      return false;
    }
    const remainingSec = durationSec != null ? Math.max(0, durationSec - target) : null;
    if (!this.mixStream.adoptCurrent(source, { durationSec: remainingSec })) {
      source.destroy();
      return false;
    }
    // The decoder now starts at `target` on the native timeline — mirror
    // the bookkeeping a fresh track start performs, plus cancel anything
    // prepped/armed against the pre-seek position.
    this.#transitions.clearCrossfadeArm();
    this.#sourcePreparer.clearPreparedIncoming();
    this.#transitions.crossfadeStarted = false;
    this.#transitions.crossfadeTargetTrack = null;
    this.#transitions.pendingSessionTempo = null;
    this.#transitions.pendingIncomingEntrySec = 0;
    this.#transitions.lastEvaluatedTransitionReport = null;
    this.#transitions.currentEntrySec = target;
    this.#transitions.currentEntryOverlapConsumedSec = 0;
    this.#transitions.resetSessionTempoFor(track);
    this.#playbackStart = Date.now();
    this.#lastActiveAt = Date.now();
    this.#transitions.startCrossfadeArm();
    return target;
  }

  async skip() {
    this.#forceSkip = true;
    this.#pipeline.abortSourceAudioWait();
    this.mixStream?.dropCurrent();
    // Codex review (PR #45, P1): same silent underrun-state reset as the
    // other dropCurrent() call sites — a /skip landing mid-underrun must
    // not leave this player's stem-queue pause source stuck forever.
    this.#stemQ().noteUnderrunCleared(this);
    // Codex review (PR #43, round 10): a skip abandons whatever pair was
    // just evaluated/stashed for the skipped track, same reasoning as
    // stop()'s own clear above — without this, a later recurrence of the
    // same pair within the 30s freshness window (e.g. QUEUE loop) could
    // attribute a stale evaluation to a hard handoff that never actually
    // evaluated it.
    this.#transitions.lastEvaluatedTransitionReport = null;
  }

  /**
   * Codex review (PR #45, P1): several normal paths (queue exhaustion with
   * no autoplay handler, a track failing to start, etc.) call the injected
   * #onDisconnect callback directly, without going through stop() first —
   * stop()'s own noteUnderrunCleared()/resume() calls only run when it's
   * actually invoked. Every #onDisconnect() call site in this file goes
   * through this wrapper instead, so a player that disconnects mid-underrun
   * always releases its stem-queue pause source too, not just on an
   * explicit /leave or /stop.
   */
  async #disconnect() {
    this.#stemQ().noteUnderrunCleared(this);
    await this.#onDisconnect();
  }

  async stop() {
    // Synchronous invalidation: the generation bumps before any async
    // teardown runs, so every path that snapshots it (playNext's source
    // prep, PlaybackService.enqueue's start decision) sees the stop the
    // moment it begins — not when cleanup happens to finish.
    this.#stopGeneration += 1;
    this.#stopping = true;
    // Serialized tail: overlapping stop()s run their teardown strictly
    // one at a time, and #stopTail stays a never-rejecting await point
    // for "no stop in flight".
    const tail = this.#stopTail.then(() => this.#stopTeardown());
    const settled = tail.catch(() => {});
    this.#stopTail = settled;
    try {
      await tail;
    } finally {
      // Only the most recent stop() clears the flag — an overlapping one
      // keeps #stopping true until its own tail finishes.
      if (this.#stopTail === settled) this.#stopping = false;
    }
  }

  async #stopTeardown() {
    this.#pauseRequested = false;
    this.#queue.clear();
    this.#pipeline.abortSourceAudioWait();
    this.#clearWatchdog();
    this.#transitions.clearCrossfadeArm();
    this.#sourcePreparer.clearPreparedIncoming();
    this.#advancement.queueRefill = null;
    // Codex review (PR #43, round 4/5): an explicit stop must not leave a
    // stashed gapless continuation OR evaluated-plan snapshot around for a
    // later, unrelated playNext() (e.g. a fresh /play in the same session,
    // possibly even the same video-id pair replayed) to pick up.
    this.#transitions.pendingGaplessFrom = null;
    this.#transitions.lastEvaluatedTransitionReport = null;
    this.#analysisQ().noteUnderrunCleared(this);
    // Symmetric with the underrunClear wiring above (MixerPipeline.initMixerPipeline) —
    // release this player's pause source on the stem queue too, so a
    // stopped guild never leaves it stuck paused for other guilds.
    this.#stemQ().resume(this);
    await this.#cleanupCurrentTempFile();
    await this.#sourcePreparer.cleanupIncomingTempFile();
    this.#sourcePreparer.discardPrefetch();
    // Ignore Idle from stop()/endMixer so recovery does not fight teardown.
    this.#pipeline.mixerStarted = false;
    this.#pipeline.idleRecovering = false;
    try {
      this.mixStream?.removeAllListeners();
      // audioPlayer.stop() below destroys the resource, and the opus
      // encoder's pipeline() then destroy()s this MixStream with
      // ERR_STREAM_PREMATURE_CLOSE — possibly on a later tick, after the
      // 'error' listeners were just removed. An 'error' event with no
      // listener throws synchronously, so keep a swallowing handler until
      // the stream is fully torn down (same crash class fixed in 96b0f58).
      this.mixStream?.on('error', () => {});
      this.mixStream?.endMixer();
    } catch {
      // already ended
    }
    this.#audioPlayer.stop();
    // endMixer() permanently closes MixStream. Rebuild so a later playNext()
    // (same session, no /leave) can setCurrent on a live mixer.
    this.#pipeline.initMixerPipeline();
  }

  async #maybeApplyAnalysisDuration(track, analysis) {
    if (this.#queue.current !== track) return;
    if (analysis?.durationSec && this.mixStream?.remainingSec == null) {
      // §8.4: if this track was itself promoted via a beatmix, #sessionTempo
      // already carries its stretched tempoRatio (see #onCrossfadePromoted) —
      // native analysis duration must convert to playback-domain before
      // feeding setDurationSec, the same conversion promotion itself applies.
      // A no-op (ratio 1) for the common non-stretched case.
      this.mixStream.setDurationSec(compensateDurationSec(analysis.durationSec, this.#transitions.sessionTempo.tempoRatio));
    }
    // Phase 7 §8.4: the fast-path #analysisCache read in #resetSessionTempoFor
    // usually misses (analysis isn't scheduled/fetched until after a track
    // becomes current) — this is the shared arrival point for all three ways
    // analysis reaches the current track (persisted lookup, in-memory cache
    // hit, freshly completed #runAnalysis), so it is where nativeBpm actually
    // gets backfilled once known.
    if (analysis?.bpm != null && this.#transitions.sessionTempo.nativeBpm == null) {
      // Same headBpm preference as #resetSessionTempoFor, for the same reason.
      this.#transitions.sessionTempo = resetSessionTempo(analysis.headBpm ?? analysis.bpm);
    }
  }

  async #cleanupCurrentTempFile() {
    const filePath = this.#currentTempFile;
    this.#currentTempFile = null;
    this.#currentMeasured = null;
    if (filePath) {
      await cleanupTempFile(filePath);
    }
  }

  #resetWatchdog() {
    this.#watchdog.start();
  }

  #clearWatchdog() {
    this.#watchdog.stop();
  }
}

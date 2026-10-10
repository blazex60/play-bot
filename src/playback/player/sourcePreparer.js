import {
  cleanupTempFile,
  isNormalizeDurationAllowed,
} from '../../audio/normalize.js';
import { createStreamSource, createFileSource } from '../../audio/pcmSource.js';
import { probeDurationSec } from '../../audio/duration.js';
import { getAnalysisQueue, getStemPreparationQueue } from '../../audio/analysisQueue.js';
import { StemPrefetchPriority } from '../../audio/stemPrefetch.js';
import { LoopMode } from '../queue.js';

function analysisKilledError() {
  const err = new Error('analysis killed');
  err.code = 'ANALYSIS_KILLED';
  return err;
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw analysisKilledError();
}

/**
 * Owns the per-guild "prepare the next track's audio source" pipeline behind
 * GuildPlayer: the #prefetchEntries download/analysis lookahead window
 * (prefetchUpcoming + ensureFullPrefetch/ensureAnalysisPrefetch/
 * ensureStemPrefetch), the prepared incoming full-mix source
 * (#preparedIncoming + #incomingTempFile/#incomingMeasured, prepId-guarded),
 * and the late-bound prepared stem pairs a stem-mix transition can adopt.
 * Extracted from GuildPlayer (player.js) — same dependency-injection pattern
 * as AnalysisCoordinator — so the player concentrates on playback
 * orchestration.
 *
 * Shared references injected: the GuildQueue (the prefetch window reads
 * loopMode/current/wrappedUpcoming), the AnalysisCoordinator (analysis/stem
 * caches + scheduleAnalysis), and the StemPrefetchTracker (the player's
 * stemPrefetchStatus getter still exposes it). What stays with the player
 * arrives as callbacks: #currentTempFile/#currentMeasured ownership
 * (setCurrentTemp/getCurrentMeasured) and the duration/tempo apply step
 * (applyAnalysisDuration).
 */
export class SourcePreparer {
  #queue;
  #analysis;
  #stemPrefetchTracker;
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
  #prefetchTrackFn;
  #resolveAudioStreamFn;
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
  #createPcmSourceFn;
  /** Test-only override — the two stem-prep methods call createFileSource() directly (they bypass createPcmSource entirely, since stem WAVs need no download/normalize/loudnorm pass), so a dedicated injection point mirrors this file's existing DI convention for every other real-process spawn. */
  #createFileSourceFn;
  #getCachedStemsFn;
  #separateTrackStemsFn;
  #stageTempFileCopyFn;
  /** (filePath, measured) -> assigns the player's #currentTempFile/#currentMeasured pair — the current track's temp ownership stays there. */
  #setCurrentTemp;
  /** () -> the player's live #currentMeasured — read by the outgoing stem-prep identity checks. */
  #getCurrentMeasured;
  /** Routes a settled/probed analysis result back to the player's duration/tempo apply step. */
  #applyAnalysisDuration;

  #prefetchEntries = new Map();
  /** @type {{ track: object, promise: Promise<object>, source: object|null } | null} */
  #preparedIncoming = null;
  /** Bumped when cancelling prep so in-flight createPcmSource won't claim temps. */
  #incomingPrepId = 0;
  #incomingTempFile = null;
  /**
   * Loudnorm measurement for #incomingTempFile, cached alongside it so a
   * re-prep for the SAME track with different startSec/tempoFilter (a
   * beatmix plan replacing the eager default prep) can respawn just the
   * ffmpeg decoder on the already-downloaded file instead of re-running the
   * full yt-dlp fetch + loudnorm measurement pass (Codex round-2).
   */
  #incomingMeasured = null;
  /** @type {{ videoId: string, prep: {startSec:number,tempoFilter:string|null}, vocal: object, instrumental: object } | null} */
  #preparedOutgoingStems = null;
  /** Identity key of an in-flight ensureOutgoingStemPrep() cache-revalidation await, or null. Lets a later/different call — or an explicit clear — invalidate an earlier one still awaiting, instead of every arm tick spawning its own independent attempt. */
  #preparingOutgoingStemsKey = null;
  /** @type {{ videoId: string, prep: {startSec:number,tempoFilter:string|null}, vocal: object, instrumental: object } | null} */
  #preparedIncomingStems = null;
  /** Identity key of an in-flight ensureIncomingStemPrep() cache-revalidation await, or null — same rationale as #preparingOutgoingStemsKey. */
  #preparingIncomingStemsKey = null;
  /** Dedup guard for #runLowPriorityStemPrefetch() — same rationale as #scheduledAnalysisTokens, but keyed by videoId presence only since this path has no killed-job/stale-token race to guard against (it never gets restarted mid-flight, only skipped while already in the Set). */
  #lowPriorityStemPrefetch = new Set();

  constructor({
    queue,
    analysis,
    stemPrefetchTracker,
    analysisQueue = null,
    stemQueue = null,
    prefetchTrackFn,
    resolveAudioStreamFn,
    createPcmSourceFn = null,
    createFileSourceFn,
    getCachedStemsFn,
    separateTrackStemsFn,
    stageTempFileCopyFn,
    setCurrentTemp,
    getCurrentMeasured,
    applyAnalysisDuration,
  }) {
    this.#queue = queue;
    this.#analysis = analysis;
    this.#stemPrefetchTracker = stemPrefetchTracker;
    this.#analysisQueue = analysisQueue;
    this.#stemQueue = stemQueue;
    this.#prefetchTrackFn = prefetchTrackFn;
    this.#resolveAudioStreamFn = resolveAudioStreamFn;
    this.#createPcmSourceFn = createPcmSourceFn;
    this.#createFileSourceFn = createFileSourceFn;
    this.#getCachedStemsFn = getCachedStemsFn;
    this.#separateTrackStemsFn = separateTrackStemsFn;
    this.#stageTempFileCopyFn = stageTempFileCopyFn;
    this.#setCurrentTemp = setCurrentTemp;
    this.#getCurrentMeasured = getCurrentMeasured;
    this.#applyAnalysisDuration = applyAnalysisDuration;
  }

  #analysisQ() {
    return this.#analysisQueue ?? getAnalysisQueue();
  }

  /** Phase 9C (docs/mix-transition-phase9.md §5): the dedicated StemPreparationQueue — see #stemQueue's own docstring. */
  #stemQ() {
    return this.#stemQueue ?? getStemPreparationQueue();
  }

  /** The pending ensureIncomingPrep() entry ({ track, promise, source, prep }), or null. */
  get preparedIncoming() {
    return this.#preparedIncoming;
  }

  /**
   * Detaches the pending prepared-incoming entry WITHOUT destroying it —
   * for #onSnapHandoff's adopt path, which takes ownership of the source
   * instead of discarding it.
   */
  takePreparedIncomingEntry() {
    const entry = this.#preparedIncoming;
    this.#preparedIncoming = null;
    return entry;
  }

  /**
   * Transfers the prepared incoming temp file (and its cached loudnorm
   * measurement) into the player's current-track slots — the promotion
   * bookkeeping shared by takePreparedIncoming(forPlayback), the snap
   * handoff, and crossfade promotion.
   */
  promoteIncomingTempToCurrent() {
    this.#setCurrentTemp(this.#incomingTempFile, this.#incomingMeasured);
    this.#incomingTempFile = null;
    this.#incomingMeasured = null;
  }

  async createPcmSource(track, { forIncoming = false, prepId = null, startSec = 0, tempoFilter = null } = {}) {
    if (this.#createPcmSourceFn) {
      return this.#createPcmSourceFn(track, { forIncoming, startSec, tempoFilter });
    }

    if (!forIncoming) {
      this.#setCurrentTemp(null, null);
    }

    // Mixer path forces normalize when duration allows (crossfade quality).
    if (!isNormalizeDurationAllowed(track)) {
      if (!forIncoming) this.discardPrefetch();
      // Live/untrimmed stream — do not keep a prior trimmed duration.
      if (track.videoId) this.#analysis.probedDurationCache.delete(track.videoId);
      // §9.3: createStreamSource has no tempoFilter support at all — mark
      // the source so a caller that requested one doesn't stash beatmix
      // bookkeeping (session tempo) for audio actually playing at native
      // tempo. startSec is honored via yt-dlp --download-sections.
      const source = createStreamSource(track, { resolveAudioStreamFn: this.#resolveAudioStreamFn, startSec });
      source.tempoHonored = false;
      return source;
    }

    try {
      const prefetched = await this.#getPrefetchedOrFetch(track);
      const probedDuration = await probeDurationSec(prefetched.filePath).catch(() => null);
      if (track.videoId && probedDuration != null) {
        this.#analysis.probedDurationCache.set(track.videoId, probedDuration);
        this.#applyAnalysisDuration(track, { durationSec: probedDuration });
      }
      console.info(
        `[normalize] applying: ${track.title} ` +
        `(${prefetched.measured.measured_I} LUFS -> -16 LUFS)`
      );
      if (forIncoming) {
        if (prepId != null && prepId !== this.#incomingPrepId) {
          cleanupTempFile(prefetched.filePath).catch((err) => {
            console.error('[GuildPlayer] abandoned incoming temp cleanup error:', err);
          });
          // Do not schedule analysis or open a FileSource on a temp we are
          // deleting — callers treat rejection as a cancelled/failed prep.
          const cancelErr = new Error('incoming prep cancelled');
          cancelErr.code = 'INCOMING_PREP_CANCELLED';
          throw cancelErr;
        }
        this.#incomingTempFile = prefetched.filePath;
        this.#incomingMeasured = prefetched.measured;
      } else {
        this.#setCurrentTemp(prefetched.filePath, prefetched.measured);
      }
      this.#analysis.scheduleAnalysis(track, prefetched.filePath);
      const source = createFileSource(prefetched.filePath, { measured: prefetched.measured, startSec, tempoFilter });
      source.tempoHonored = true;
      return source;
    } catch (err) {
      if (err?.code === 'INCOMING_PREP_CANCELLED') throw err;
      console.warn(`[GuildPlayer] normalize fallback for ${track.title}:`, err.message);
      if (track.videoId) this.#analysis.probedDurationCache.delete(track.videoId);
      const source = createStreamSource(track, { resolveAudioStreamFn: this.#resolveAudioStreamFn, startSec });
      source.tempoHonored = false;
      return source;
    }
  }

  /**
   * Phase 8 (docs/mix-transition-phase8.md): the outgoing side's stem pair
   * must be spawned LATE — seeked to the exit point — from inside
   * #maybeStartCrossfade()'s own prepDue gate, never at track-promotion
   * time. A PcmSource opened at startSec:0 and left unread for however long
   * the track has left to play would just sit blocked on backpressure at
   * the wrong native position by the time it's actually needed.
   */
  async ensureOutgoingStemPrep(cached, videoId, { startSec = 0, tempoFilter = null } = {}) {
    // Loudnorm the stems with the same measured LUFS #current's own full-mix
    // source used — otherwise the stem window jumps to unfiltered loudness
    // relative to the surrounding, already-normalized audio. Included in the
    // identity check (not just videoId/startSec/tempoFilter): if this fires
    // before #currentMeasured is populated, an unmeasured pair gets prepped;
    // without this, a later tick that finally sees the real value would
    // treat the existing prep as still valid and never re-spawn with it.
    const measured = this.#getCurrentMeasured();
    if (
      this.#preparedOutgoingStems?.videoId === videoId
      && this.#preparedOutgoingStems.prep?.startSec === startSec
      && this.#preparedOutgoingStems.prep?.tempoFilter === tempoFilter
      && this.#preparedOutgoingStems.prep?.measured === measured
    ) return;
    // Dedup concurrent in-flight attempts for the SAME identity — the cache
    // revalidation below is async, and the 200ms arm interval can call this
    // again before it resolves. Without this, every such tick spawns its
    // own independent ffmpeg pair; whichever's await happens to resolve
    // last silently wins even if it started before another, and a
    // completion that lands after the pair has already been taken (or
    // cleared) installs an orphaned pair whose paused processes never get
    // destroyed (Codex).
    const key = `${videoId}:${startSec}:${tempoFilter}:${measured}`;
    if (this.#preparingOutgoingStemsKey === key) return;
    this.#preparingOutgoingStemsKey = key;
    try {
      // Revalidate against the live cache right before actually spawning —
      // this only runs on a genuine (re)prep, i.e. rarely, not on the
      // steady-state no-op ticks above, so it doesn't reintroduce the
      // per-tick fs cost player.js's #outStemCacheHit/#inStemCacheHit memo exists to avoid.
      // `cached` (the caller's argument) may be a memoized lookup from
      // several arm-ticks ago; pruneStemCache() can evict the entry any
      // time in the background, and a stale path here would spawn ffmpeg
      // against a deleted file, silently failing prep forever for this
      // pair as long as the memo key doesn't change (Codex).
      const fresh = await this.#getCachedStemsFn(videoId);
      // A newer call (different identity) or an explicit clear (stop, plan
      // downgrade, ...) superseded this attempt while it awaited — the
      // caller no longer wants this result; do not install it.
      if (this.#preparingOutgoingStemsKey !== key) return;
      if (!fresh) {
        this.clearPreparedOutgoingStems();
        return;
      }
      const vocal = this.#createFileSourceFn(fresh.vocalPath, { startSec, tempoFilter, measured });
      const instrumental = this.#createFileSourceFn(fresh.instrumentalPath, { startSec, tempoFilter, measured });
      this.clearPreparedOutgoingStems();
      this.#preparedOutgoingStems = { videoId, prep: { startSec, tempoFilter, measured }, vocal, instrumental };
    } finally {
      // Always release the in-flight marker for THIS attempt, including on
      // a rejected getCachedStemsFn() — otherwise a transient cache-read
      // error leaves the key stuck forever, and every later tick for this
      // same identity hits the dedup no-op above, permanently disabling
      // stem prep for the rest of the transition even if a later read
      // would have succeeded (CodeRabbit). Only clear it if it's still
      // OURS — a newer call already replacing it with its own key must
      // keep that key, not have it wiped out from under it.
      if (this.#preparingOutgoingStemsKey === key) this.#preparingOutgoingStemsKey = null;
    }
  }

  takePreparedOutgoingStems(videoId, { startSec = 0, tempoFilter = null } = {}) {
    if (
      this.#preparedOutgoingStems?.videoId === videoId
      && this.#preparedOutgoingStems.prep?.startSec === startSec
      && this.#preparedOutgoingStems.prep?.tempoFilter === tempoFilter
      // #currentMeasured can still change between the prepDue tick that
      // prepped these stems and this take — e.g. normalization for the
      // OTHER side resolving in the same arm pass shouldn't matter here,
      // but a stale unmeasured pair must not silently win over a since-
      // populated value (CodeRabbit, follow-up to the ensure-side fix).
      && this.#preparedOutgoingStems.prep?.measured === this.#getCurrentMeasured()
    ) {
      const { vocal, instrumental } = this.#preparedOutgoingStems;
      this.#preparedOutgoingStems = null;
      return { vocal, instrumental };
    }
    this.clearPreparedOutgoingStems();
    return null;
  }

  clearPreparedOutgoingStems() {
    this.#preparedOutgoingStems?.vocal?.destroy?.();
    this.#preparedOutgoingStems?.instrumental?.destroy?.();
    this.#preparedOutgoingStems = null;
    // Invalidate any in-flight #ensureOutgoingStemPrep() attempt too — a
    // completion for a pair the caller just explicitly discarded must not
    // be allowed to silently reinstall one once its await resolves.
    this.#preparingOutgoingStemsKey = null;
  }

  /**
   * Incoming-side stem pair — same late-binding rationale as
   * ensureOutgoingStemPrep(). The incoming side's FULL-mix continuation
   * source (needed once the stem window ends) is NOT prepared here — that
   * still goes through the existing ensureIncomingPrep()/
   * takePreparedIncoming() machinery (download/normalize/analysis-
   * scheduling already lives there; no need to duplicate it), spawned with
   * the SAME startSec/tempoFilter so all three incoming sources decode in
   * lockstep (see mixStream.js's startStemCrossfade() docstring).
   */
  async ensureIncomingStemPrep(cached, videoId, { startSec = 0, tempoFilter = null } = {}) {
    // Same rationale as #ensureOutgoingStemPrep() — reuse whichever measured
    // value the incoming full-mix prep has captured for this track so far,
    // and include it in the identity check so a later tick that sees
    // #incomingMeasured finally populated (a slow download/prefetch can
    // still be resolving the first time this fires) re-preps with it
    // instead of permanently keeping an unmeasured pair.
    const measured = this.#incomingMeasured;
    if (
      this.#preparedIncomingStems?.videoId === videoId
      && this.#preparedIncomingStems.prep?.startSec === startSec
      && this.#preparedIncomingStems.prep?.tempoFilter === tempoFilter
      && this.#preparedIncomingStems.prep?.measured === measured
    ) return;
    // Dedup concurrent in-flight attempts — see #ensureOutgoingStemPrep()'s
    // matching comment (Codex).
    const key = `${videoId}:${startSec}:${tempoFilter}:${measured}`;
    if (this.#preparingIncomingStemsKey === key) return;
    this.#preparingIncomingStemsKey = key;
    try {
      // Revalidate against the live cache right before actually spawning —
      // see #ensureOutgoingStemPrep()'s matching comment (Codex).
      const fresh = await this.#getCachedStemsFn(videoId);
      if (this.#preparingIncomingStemsKey !== key) return;
      if (!fresh) {
        this.clearPreparedIncomingStems();
        return;
      }
      const vocal = this.#createFileSourceFn(fresh.vocalPath, { startSec, tempoFilter, measured });
      const instrumental = this.#createFileSourceFn(fresh.instrumentalPath, { startSec, tempoFilter, measured });
      this.clearPreparedIncomingStems();
      this.#preparedIncomingStems = { videoId, prep: { startSec, tempoFilter, measured }, vocal, instrumental };
    } finally {
      // Always release the in-flight marker for THIS attempt — see
      // #ensureOutgoingStemPrep()'s matching comment (CodeRabbit).
      if (this.#preparingIncomingStemsKey === key) this.#preparingIncomingStemsKey = null;
    }
  }

  takePreparedIncomingStems(videoId, { startSec = 0, tempoFilter = null } = {}) {
    if (
      this.#preparedIncomingStems?.videoId === videoId
      && this.#preparedIncomingStems.prep?.startSec === startSec
      && this.#preparedIncomingStems.prep?.tempoFilter === tempoFilter
      // takePreparedIncoming() (the full-mix side) can resolve normalization
      // and populate #incomingMeasured within the SAME arm pass, after these
      // stems were already prepped unmeasured — without this check the stale
      // unmeasured pair would win over the full-mix source's now-measured
      // loudness (CodeRabbit, follow-up to the ensure-side fix).
      && this.#preparedIncomingStems.prep?.measured === this.#incomingMeasured
    ) {
      const { vocal, instrumental } = this.#preparedIncomingStems;
      this.#preparedIncomingStems = null;
      return { vocal, instrumental };
    }
    this.clearPreparedIncomingStems();
    return null;
  }

  clearPreparedIncomingStems() {
    this.#preparedIncomingStems?.vocal?.destroy?.();
    this.#preparedIncomingStems?.instrumental?.destroy?.();
    this.#preparedIncomingStems = null;
    // Invalidate any in-flight #ensureIncomingStemPrep() attempt too — see
    // #clearPreparedOutgoingStems()'s matching comment.
    this.#preparingIncomingStemsKey = null;
  }

  /** Destroys a prepared entry's source, resolved or still in flight. */
  #destroyPreparedSource(entry) {
    if (!entry) return;
    if (entry.source) {
      entry.source.destroy?.();
    } else if (entry.promise) {
      entry.promise.then((resolved) => {
        resolved?.destroy?.();
      }).catch(() => {});
    }
  }

  clearPreparedIncoming() {
    // Invalidate in-flight createPcmSource so it won't assign #incomingTempFile
    // after cancel (stop / skip / replace prep / playNextMixer).
    this.#incomingPrepId += 1;
    // Phase 8: a prepared stem pair is only ever prepped alongside an
    // attempted stem-mix transition's full-mix incoming prep — piggyback on
    // every existing call site that abandons the latter rather than
    // duplicating them.
    this.clearPreparedOutgoingStems();
    this.clearPreparedIncomingStems();
    if (!this.#preparedIncoming) return;
    const pending = this.#preparedIncoming;
    this.#preparedIncoming = null;
    this.#destroyPreparedSource(pending);
    const filePath = this.#incomingTempFile;
    this.#incomingTempFile = null;
    this.#incomingMeasured = null;
    if (filePath) {
      cleanupTempFile(filePath).catch((err) => {
        console.error('[GuildPlayer] prepared incoming temp cleanup error:', err);
      });
    }
  }

  /**
   * Phase 7D: dedup key includes startSec/tempoFilter, not just the track —
   * an earlier no-op prep (called eagerly on track start, before any
   * transition plan exists — see ensureIncomingPrepForUpcoming) must be
   * torn down and re-spawned once a real beatmix/phrase-crossfade entry
   * point is known, or the incoming source plays from its native start at
   * native tempo regardless of what the plan decided.
   */
  ensureIncomingPrep(next, { startSec = 0, tempoFilter = null, sessionTempo = null } = {}) {
    if (
      this.#preparedIncoming?.track === next
      && this.#preparedIncoming.prep?.startSec === startSec
      && this.#preparedIncoming.prep?.tempoFilter === tempoFilter
    ) return;

    const entry = { track: next, source: null, promise: null, prep: { startSec, tempoFilter, sessionTempo } };

    // Reuse the already-downloaded/normalized file for the SAME track when
    // only startSec/tempoFilter changed (e.g. a beatmix plan replacing the
    // eager default prep) — clearPreparedIncoming() below would otherwise
    // delete #incomingTempFile, and #getPrefetchedOrFetch() consumes (and
    // deletes) its prefetch map entry on first use, so a full createPcmSource
    // re-run would re-download + re-normalize a file already on disk.
    if (
      this.#preparedIncoming?.track === next
      && this.#incomingTempFile != null
      && this.#incomingMeasured != null
    ) {
      this.#destroyPreparedSource(this.#preparedIncoming);
      const source = createFileSource(this.#incomingTempFile, {
        measured: this.#incomingMeasured,
        startSec,
        tempoFilter,
      });
      source.tempoHonored = true;
      entry.source = source;
      entry.promise = Promise.resolve(source);
      this.#preparedIncoming = entry;
      return;
    }

    this.clearPreparedIncoming();
    const prepId = this.#incomingPrepId;
    entry.promise = this.createPcmSource(next, { forIncoming: true, prepId, startSec, tempoFilter })
      .then((resolved) => {
        if (this.#preparedIncoming === entry) {
          entry.source = resolved;
        }
        return resolved;
      })
      .catch((err) => {
        if (this.#preparedIncoming === entry) {
          this.#preparedIncoming = null;
        }
        throw err;
      });
    this.#preparedIncoming = entry;
  }

  async takePreparedIncoming(next, { forPlayback = false, startSec = 0, tempoFilter = null } = {}) {
    if (
      this.#preparedIncoming?.track === next
      && this.#preparedIncoming.prep?.startSec === startSec
      && this.#preparedIncoming.prep?.tempoFilter === tempoFilter
    ) {
      const pending = this.#preparedIncoming;
      this.#preparedIncoming = null;
      const source = pending.source ?? await pending.promise;
      if (forPlayback && this.#incomingTempFile) {
        this.promoteIncomingTempToCurrent();
      }
      return source;
    }
    // Mismatched prep (e.g. #playNextMixer's cold-start default request
    // reusing a track that was mid-prep as a beatmix incoming target with a
    // different startSec/tempoFilter, or a skip racing #handleAfter) — never
    // silently hand back a spawn configured for a different plan.
    if (this.#preparedIncoming?.track === next) {
      this.clearPreparedIncoming();
    }
    const prepId = this.#incomingPrepId;
    return this.createPcmSource(next, { forIncoming: !forPlayback, prepId, startSec, tempoFilter });
  }

  ensureIncomingPrepForUpcoming() {
    const current = this.#queue.current;
    if (!current) return;
    const next = this.#queue.loopMode === LoopMode.TRACK
      ? current
      : this.#queue.upcoming()[0];
    if (next) this.ensureIncomingPrep(next);
  }

  async cleanupIncomingTempFile() {
    const filePath = this.#incomingTempFile;
    this.#incomingTempFile = null;
    this.#incomingMeasured = null;
    if (filePath) {
      await cleanupTempFile(filePath);
    }
  }

  async #getPrefetchedOrFetch(track) {
    const key = this.prefetchKey(track);
    const entry = key ? this.#prefetchEntries.get(key) : null;
    if (entry?.kind === 'full' && entry.promise) {
      this.#prefetchEntries.delete(key);
      const result = await entry.promise;
      if (result.error) throw result.error;
      if (result.value?.filePath) return result.value;
    }

    this.discardPrefetch(track);
    return this.#prefetchTrackFn(track);
  }

  prefetchKey(track) {
    return track?.videoId || track?.webpageUrl || null;
  }

  prefetchUpcoming() {
    // Codex review (PR #44): wrappedUpcoming() (not upcoming().slice()) so
    // QUEUE loop mode's last track still gets a HIGH stem-prefetch/full
    // prefetch pass and the penultimate track still gets its LOW/lookahead
    // pass, instead of both silently missing lookahead right at the loop
    // boundary even though next() really does wrap there.
    const upcoming = this.#queue.loopMode === LoopMode.TRACK
      ? (this.#queue.current ? [this.#queue.current] : [])
      : this.#queue.wrappedUpcoming(3);

    const keep = new Set(upcoming.map((t) => this.prefetchKey(t)).filter(Boolean));
    for (const key of [...this.#prefetchEntries.keys()]) {
      if (!keep.has(key)) this.#discardPrefetchKey(key);
    }

    const first = upcoming[0];
    if (first && isNormalizeDurationAllowed(first)) {
      this.#ensureFullPrefetch(first);
    }
    for (const track of upcoming.slice(1)) {
      if (track && isNormalizeDurationAllowed(track)) {
        this.#ensureAnalysisPrefetch(track);
      }
    }

    // Phase 9B (docs/mix-transition-phase9.md §4.2): next (B) gets HIGH
    // stem prefetch, next+1 (C) gets LOW. next+2 (D) and beyond stay
    // untouched by this — only the two loops above (full prefetch for the
    // track that's about to become current, lightweight BPM/phrase
    // lookahead for the rest) apply to them, exactly as before Phase 9B.
    const second = upcoming[1];
    if (first && isNormalizeDurationAllowed(first)) {
      this.#ensureStemPrefetch(first, StemPrefetchPriority.HIGH);
    }
    if (second && isNormalizeDurationAllowed(second)) {
      this.#ensureStemPrefetch(second, StemPrefetchPriority.LOW);
    }
    const activeVideoIds = new Set(upcoming.map((t) => t?.videoId).filter(Boolean));
    this.#stemPrefetchTracker.prune(activeVideoIds);
    for (const videoId of [...this.#analysis.stemPrefetchRetriedAfterKill]) {
      if (!activeVideoIds.has(videoId)) this.#analysis.stemPrefetchRetriedAfterKill.delete(videoId);
    }
  }

  /**
   * Phase 9B (docs/mix-transition-phase9.md §4): registers/refreshes this
   * videoId's stem-prefetch bookkeeping and, on a cache miss, makes sure
   * the actual separation work is (or gets) dispatched.
   *
   * HIGH (B, next): purely observational beyond registering intent — B
   * already gets a full download+normalize+analyze pass for real playback
   * prep (#ensureFullPrefetch() -> #scheduleAnalysis(), Phase 8's existing
   * pipeline), which itself ends by calling separateTrackStemsFn(). This
   * piggybacks on that pipeline's own dedup (#prefetchEntries by key,
   * #scheduledAnalysisTokens by videoId, stemCache.js's own per-videoId
   * in-flight map) instead of opening a second, redundant download path
   * for the same file — so this method never itself calls
   * #prefetchTrackFn for a HIGH-priority track.
   *
   * LOW (C, next+1): drives the download + staged-copy + separation
   * directly via #runLowPriorityStemPrefetch(), because nothing else in
   * the existing pipeline keeps C's audio around long enough for Demucs —
   * #ensureAnalysisPrefetch()'s own lookahead deletes its temp file the
   * instant BPM/phrase analysis finishes (by design, phase8.md §21: running
   * full-track Demucs against an unconfirmed 2-3-tracks-ahead candidate was
   * judged disproportionate — Phase 9B narrows that specifically to next+1).
   * This is independent of the BPM-analysis cache: a track can have
   * analysis cached from an earlier play while still missing its Demucs
   * stems, so #ensureAnalysisPrefetch()'s own persisted-analysis
   * short-circuit must not also gate stem prefetch.
   *
   * Either way, dispatch happens only after #getCachedStemsFn() confirms a
   * miss — a cache HIT just (re-)marks the entry READY. Unlike
   * #outStemCacheHit/#inStemCacheHit's own "only positive results are
   * memoized", READY is NOT sticky here: every prefetchUpcoming() call
   * re-probes the cache regardless of the entry's current state
   * (background separation completing mid-window is the whole point for a
   * MISS, and a previously cached pair can be evicted later by
   * pruneStemCache() — see the Codex review note at this method's
   * cache-probe call site).
   * Nothing here is awaited by #maybeStartCrossfade() or anything else on
   * the realtime playback path — every call this method makes is
   * fire-and-forget from that path's perspective (§5.4 "Playback Safety",
   * in spirit — the dedicated pausable priority queue itself is Phase 9C's
   * job).
   */
  #ensureStemPrefetch(track, priority) {
    const videoId = track?.videoId;
    if (!videoId) return;

    const entry = this.#stemPrefetchTracker.queue(videoId, priority);
    // Codex review (PR #44, round 3, P2): READY used to be treated as
    // permanently sticky (an early return here, skipping the cache probe
    // below entirely) — but stemCache.js's pruneStemCache() can evict a
    // previously-separated pair's files later (LRU eviction once the shared
    // 2GB cache fills, driven by unrelated guilds' separations), and nothing
    // ever told this tracker its READY entry had gone stale. The real
    // transition path re-`access()`s the files at take time and falls back
    // safely when they're gone, so eviction was never a playback bug — but
    // this prefetch status would stay stuck reporting READY forever for
    // that pair, never re-dispatching a fresh separation. Falling through
    // to the same getCachedStemsFn() probe every MISS entry already gets
    // re-checks READY entries too; a HIT just re-confirms READY (no-op), a
    // MISS now correctly falls into the same HIGH/LOW re-dispatch logic
    // below that a fresh MISS uses.
    this.#getCachedStemsFn(videoId).then((cached) => {
      if (cached) {
        this.#stemPrefetchTracker.markReady(videoId);
        return;
      }

      if (entry.priority === StemPrefetchPriority.HIGH) {
        const key = this.prefetchKey(track);
        const prefetchEntry = key ? this.#prefetchEntries.get(key) : null;
        if (prefetchEntry?.kind === 'full' && prefetchEntry.track === track) {
          this.#stemPrefetchTracker.markProcessing(videoId);
          prefetchEntry.promise.then((result) => {
            // A resolved value only means the DOWNLOAD/normalize step
            // succeeded — separation itself runs asynchronously afterward
            // inside #scheduleAnalysis()'s own analysisQueue job, which
            // has no promise this method can await. The next
            // prefetchUpcoming() tick's getCachedStemsFn() probe (above)
            // is what actually detects real separation completion; this
            // only catches the one failure mode visible from here.
            if (result?.error) this.#stemPrefetchTracker.markFailed(videoId);
          });
        }
        return;
      }

      if (this.#lowPriorityStemPrefetch.has(videoId)) return;
      this.#lowPriorityStemPrefetch.add(videoId);
      this.#stemPrefetchTracker.markProcessing(videoId);
      this.#runLowPriorityStemPrefetch(track)
        .then((stems) => {
          if (stems) this.#stemPrefetchTracker.markReady(videoId);
          else this.#stemPrefetchTracker.markFailed(videoId);
        })
        .catch((err) => {
          if (err?.code === 'ANALYSIS_KILLED') {
            console.warn('[GuildPlayer] low-priority stem prefetch yielded to mixer:', err.message);
          } else {
            console.warn('[GuildPlayer] low-priority stem prefetch failed:', err.message);
          }
          this.#stemPrefetchTracker.markFailed(videoId);
        })
        .finally(() => this.#lowPriorityStemPrefetch.delete(videoId));
    }).catch((err) => {
      console.warn('[GuildPlayer] stem prefetch cache check failed:', err.message);
    });
  }

  /**
   * Phase 9B: LOW-priority stem prefetch for next+1 (C). Mirrors
   * #scheduleAnalysis()'s own staged-copy dance (stage an independent copy
   * before separation so unrelated cleanup elsewhere can't delete the file
   * mid-Demucs-run, docs/mix-transition-phase8.md Step 8.5) but owns its
   * own short-lived download via #prefetchTrackFn, since — unlike A/B —
   * nothing else in the pipeline downloads C's audio at all outside this
   * method.
   *
   * Phase 9C (docs/mix-transition-phase9.md §5): routed through the
   * dedicated StemPreparationQueue (#stemQ()), not the realtime analysis
   * queue — this whole job (download + stage + Demucs) exists only to
   * prepare C's stems, same as #scheduleAnalysis()'s own separation step,
   * so it belongs on the same lane and must not be able to sit in front of
   * an unrelated track's BPM/phrase job. A mixer underrun still
   * SIGSTOPs/kills it exactly like every other queued job (§5.4 "Playback
   * Safety") — now via the stem queue's own pause/kill state, forwarded
   * from the realtime queue's underrun event (see #initMixerPipeline()).
   */
  async #runLowPriorityStemPrefetch(track) {
    return this.#stemQ().enqueue(async ({ spawnNice, signal } = {}) => {
      throwIfAborted(signal);
      // Codex review (PR #44, P2): recheck the stem cache now that this LOW
      // job has actually reached the front of the (possibly minutes-long,
      // serial) queue — #ensureStemPrefetch() only observed a miss back
      // when this job was first enqueued. If another guild's playback or
      // an earlier HIGH job separated this same track while this job
      // waited, the full download/trim/loudness/staging pipeline below is
      // pure waste; the real separateTrackStems() already rechecks the
      // cache too, but only after all of that expensive work is done.
      const alreadyCached = await this.#getCachedStemsFn(track.videoId).catch(() => null);
      if (alreadyCached) return alreadyCached;
      throwIfAborted(signal);
      // Codex review (PR #44, P1): without spawnFn, prefetchTrackFn's
      // default implementation (normalize.js's prefetchTrack) spawns
      // yt-dlp/ffmpeg via the module-level `spawn`, entirely untracked by
      // this queue's pause/kill machinery — a mixer underrun during this
      // download would have nothing to actually SIGSTOP. Passing spawnNice
      // routes those subprocesses through the same register()/children Set
      // every other job in this queue already uses.
      const downloaded = await this.#prefetchTrackFn(track, { spawnFn: spawnNice, signal });
      try {
        throwIfAborted(signal);
        const stagedPath = await this.#stageTempFileCopyFn(downloaded.filePath).catch((err) => {
          console.warn('[GuildPlayer] failed to stage file for low-priority stem prefetch:', err.message);
          return null;
        });
        if (!stagedPath) return null;
        throwIfAborted(signal);
        try {
          return await this.#separateTrackStemsFn(stagedPath, track.videoId, { spawnFn: spawnNice, signal });
        } finally {
          cleanupTempFile(stagedPath).catch(() => {});
        }
      } finally {
        await cleanupTempFile(downloaded.filePath);
      }
    // Codex review (PR #45, P1): explicit LOW priority so a HIGH (B) job
    // requested afterward can still jump ahead of this one in the pending
    // queue instead of only ever winning by coincidence of call order.
    }, { priority: 'low' });
  }

  #ensureFullPrefetch(track) {
    const key = this.prefetchKey(track);
    if (!key) return;
    const existing = this.#prefetchEntries.get(key);
    if (existing?.kind === 'full' && existing.track === track) return;
    if (existing) this.#discardPrefetchKey(key);

    this.#prefetchEntries.set(key, {
      kind: 'full',
      track,
      promise: this.#prefetchTrackFn(track).then(
        (value) => {
          this.#analysis.scheduleAnalysis(track, value.filePath);
          return { value };
        },
        (error) => ({ error }),
      ),
    });
  }

  #ensureAnalysisPrefetch(track) {
    const key = this.prefetchKey(track);
    if (!key) return;
    if (track.videoId && this.#analysis.analysisCache.has(track.videoId)) return;
    if (this.#prefetchEntries.has(key)) return;

    this.#prefetchEntries.set(key, {
      kind: 'analysis',
      track,
      promise: this.#analysisQ().enqueue(async ({ spawnNice, signal } = {}) => {
        const cached = await this.#analysis.lookupPersistentAnalysis(track);
        if (cached) return { analyzed: true };
        throwIfAborted(signal);
        const downloaded = await this.#prefetchTrackFn(track);
        try {
          throwIfAborted(signal);
          const probed = await probeDurationSec(downloaded.filePath).catch(() => null);
          if (track.videoId && probed != null) {
            this.#analysis.probedDurationCache.set(track.videoId, probed);
          }
          await this.#analysis.runAnalysis(track, downloaded.filePath, {
            spawnFn: spawnNice,
            signal,
            durationSec: probed,
          });
        } finally {
          await cleanupTempFile(downloaded.filePath);
        }
        return { analyzed: true };
      }).then((value) => ({ value }), (error) => {
        if (error?.code !== 'ANALYSIS_KILLED') {
          console.warn('[GuildPlayer] lookahead analysis failed:', error.message);
        }
        return { error };
      }),
    });
  }

  discardPrefetch(keepTrack = null) {
    const keepKey = keepTrack ? this.prefetchKey(keepTrack) : null;
    for (const key of [...this.#prefetchEntries.keys()]) {
      if (key === keepKey) continue;
      this.#discardPrefetchKey(key);
    }
  }

  #discardPrefetchKey(key) {
    const entry = this.#prefetchEntries.get(key);
    if (!entry) return;
    this.#prefetchEntries.delete(key);
    entry.promise.then((result) => {
      if (result.value?.filePath) {
        cleanupTempFile(result.value.filePath).catch((err) => {
          console.error('[GuildPlayer] prefetch cleanup error:', err);
        });
      }
    }).catch(() => {});
  }
}

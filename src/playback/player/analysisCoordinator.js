import { cleanupTempFile } from '../../audio/normalize.js';
import { ANALYSIS_VERSION, MIN_SERVED_ANALYSIS_VERSION, applyVocalActivity } from '../../audio/trackAnalysis.js';
import { getAnalysisQueue, getStemPreparationQueue } from '../../audio/analysisQueue.js';
import { StemPrefetchPriority } from '../../audio/stemPrefetch.js';
import { isBeatThisAvailable } from '../../audio/beatThis.js';
import { getLogger } from '../../logging/appLogger.js'

const log = getLogger('GuildPlayer')

/**
 * A cached analysis with no BPM is usually a run that failed part-way
 * (production had v4 rows stuck at bpm: null, reused forever because the
 * cache never expires). Re-analyze those once they are this old; the age
 * gate keeps a genuinely beatless track from being re-analyzed on every play.
 */
const BPM_LESS_ANALYSIS_RETRY_AFTER_SEC = 24 * 60 * 60;

export function isReusableAnalysis(cached, {
  nowSec = Math.floor(Date.now() / 1000),
  beatThisAvailable = isBeatThisAvailable(),
} = {}) {
  if (!cached) return false;
  const version = cached.version ?? 1;
  // v5 differs from v6 only in the beat tracker: re-analyze it only when
  // Beat This! can actually run, so a CPU-only host keeps its v5 rows.
  if (version < ANALYSIS_VERSION && !(version >= MIN_SERVED_ANALYSIS_VERSION && !beatThisAvailable)) return false;
  const stale = Number.isFinite(cached.analyzedAt) && nowSec - cached.analyzedAt >= BPM_LESS_ANALYSIS_RETRY_AFTER_SEC;
  if (cached.bpm == null && stale) return false;
  // An aubio fallback (GPU was down) is retried once Beat This! is back.
  if (version >= ANALYSIS_VERSION && cached.beatSource === 'aubio' && beatThisAvailable && stale) return false;
  return true;
}

const ANALYSIS_MISS_BACKOFF_MS = 30_000;

function analysisKilledError() {
  const err = new Error('analysis killed');
  err.code = 'ANALYSIS_KILLED';
  return err;
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw analysisKilledError();
}

/**
 * Owns the per-guild analysis pipeline behind GuildPlayer: dedup-guarded
 * background scheduling of track analysis + stem separation, the in-memory /
 * persistent analysis caches, and the probed-duration cache. Extracted from
 * GuildPlayer (player.js) so the player concentrates on playback
 * orchestration; the shared Maps/Sets are exposed as plain public fields
 * because the player's prefetch window pruning and tempo/duration reads still
 * consult them directly.
 *
 * @param {{
 *   analyzeTrackFileFn: Function | null,
 *   getTrackAnalysisFn: Function | null,
 *   putTrackAnalysisFn: Function | null,
 *   separateTrackStemsFn: Function | null,
 *   stageTempFileCopyFn: Function,
 *   stemPrefetchTracker: import('../../audio/stemPrefetch.js').StemPrefetchTracker,
 *   analysisQueue: object | null,
 *   stemQueue: object | null,
 *   applyAnalysisDuration: (track: object, analysis: object) => void,
 * }} deps
 */
export class AnalysisCoordinator {
  /** In-memory analysis results keyed by videoId (persistent store misses land here too). */
  analysisCache = new Map();
  /** Best-known true durations keyed by videoId — probe wins over metadata. */
  probedDurationCache = new Map();
  /**
   * Codex review (PR #44, P2): videoIds whose scheduleAnalysis() job has
   * already been retried once after an ANALYSIS_KILLED abort — caps the
   * retry to a single attempt per videoId so a guild under sustained CPU
   * pressure can't loop forever re-scheduling the same doomed job. Pruned
   * alongside stemPrefetchTracker in GuildPlayer#prefetchUpcoming() once a
   * videoId leaves the active prefetch window.
   */
  stemPrefetchRetriedAfterKill = new Set();

  #analysisMissAt = new Map();
  /**
   * videoId -> attempt token for the scheduleAnalysis() job currently in
   * flight for it (Codex, PR #39 round-15/16). #ensureFullPrefetch() and
   * #createPcmSource() both call scheduleAnalysis() for the same
   * prefetched file — the second, consuming that same prefetch entry
   * once the track actually starts — so without this guard every normalized
   * track gets staged and enqueued for stem separation twice. The first
   * attempt already populates the in-memory and persistent analysis/stem
   * caches everything else reads from, so the second is pure waste.
   *
   * A per-attempt token (not just presence in a Set) matters because
   * analysisQueue's kill()/noteUnderrun() rejects a job's promise via
   * Promise.race() the instant it's killed — independent of whether that
   * job's own callback (and its own finally) has actually finished
   * running. Without a token, a killed job A's delayed finally could run
   * AFTER a newer job B has already been scheduled for the same videoId
   * (started in the gap between A's immediate kill-rejection and A's
   * callback actually unwinding), and A's cleanup would then delete B's
   * still-active guard entry — letting a third job start concurrently
   * with B. Only deleting when the stored token still matches the
   * attempt that's settling closes that gap.
   */
  #scheduledAnalysisTokens = new Map();

  #analyzeTrackFileFn;
  #getTrackAnalysisFn;
  #putTrackAnalysisFn;
  #separateTrackStemsFn;
  #stageTempFileCopyFn;
  #stemPrefetchTracker;
  #analysisQueue;
  #stemQueue;
  /** videoId -> whether a queued stem job for it is still worth running (current / next / next+1). */
  #isStemJobRelevant;
  /** Feature switch + circuit breaker gate (stemCache.js isStemSeparationAvailable). */
  #isStemSeparationAvailableFn;
  /** vocalActivity.js analyzeVocalActivityFromStems; null keeps the in-analysis Demucs pass. */
  #analyzeVocalFromStemsFn;
  /** STEM_SEPARATION_ENABLED only (not the circuit breaker). */
  #isStemSeparationEnabledFn;
  /** stemCache.js getCachedStems — lets enrichment use stems already on disk. */
  #getCachedStemsFn;
  /** Called after a tracked stem prefetch settles (player re-runs prefetchUpcoming). */
  #onStemPrefetchSettled;
  /** Routes a settled analysis result back to the player's duration/tempo apply step. */
  #applyAnalysisDuration;

  constructor({
    analyzeTrackFileFn,
    getTrackAnalysisFn,
    putTrackAnalysisFn,
    separateTrackStemsFn,
    stageTempFileCopyFn,
    stemPrefetchTracker,
    analysisQueue = null,
    stemQueue = null,
    applyAnalysisDuration,
    isStemJobRelevant = () => true,
    isStemSeparationAvailableFn = () => true,
    analyzeVocalFromStemsFn = null,
    isStemSeparationEnabledFn = () => true,
    getCachedStemsFn = null,
    onStemPrefetchSettled = null,
  }) {
    this.#analyzeTrackFileFn = analyzeTrackFileFn;
    this.#getTrackAnalysisFn = getTrackAnalysisFn;
    this.#putTrackAnalysisFn = putTrackAnalysisFn;
    this.#separateTrackStemsFn = separateTrackStemsFn;
    this.#stageTempFileCopyFn = stageTempFileCopyFn;
    this.#stemPrefetchTracker = stemPrefetchTracker;
    this.#analysisQueue = analysisQueue;
    this.#stemQueue = stemQueue;
    this.#applyAnalysisDuration = applyAnalysisDuration;
    this.#isStemJobRelevant = isStemJobRelevant;
    this.#isStemSeparationAvailableFn = isStemSeparationAvailableFn;
    this.#analyzeVocalFromStemsFn = analyzeVocalFromStemsFn;
    this.#isStemSeparationEnabledFn = isStemSeparationEnabledFn;
    this.#getCachedStemsFn = getCachedStemsFn;
    this.#onStemPrefetchSettled = onStemPrefetchSettled;
  }

  #analysisQ() {
    return this.#analysisQueue ?? getAnalysisQueue();
  }

  /** Phase 9C (docs/mix-transition-phase9.md §5): the dedicated StemPreparationQueue — kept separate from #analysisQueue so a long-running Demucs job can never sit in front of realtime analysis. */
  #stemQ() {
    return this.#stemQueue ?? getStemPreparationQueue();
  }

  scheduleAnalysis(track, filePath) {
    if (!track?.videoId || !filePath || !this.#analyzeTrackFileFn) return;
    // Codex (PR #39 round-15/16): #ensureFullPrefetch() and
    // #createPcmSource() both call scheduleAnalysis() for the same
    // prefetched file — the second, consuming that same prefetch entry
    // once the track actually starts — so without this guard every
    // normalized track gets staged and enqueued for stem separation
    // twice. Skip while a prior attempt for this exact videoId is still
    // in flight; that first attempt already populates the in-memory and
    // persistent analysis/stem caches everything else reads from, so a
    // second is pure waste. The token (not just videoId presence) guards
    // against a killed job's delayed cleanup clobbering a newer job's
    // entry — see #scheduledAnalysisTokens's own docstring.
    if (this.#scheduledAnalysisTokens.has(track.videoId)) return;
    const analysisToken = {};
    this.#scheduledAnalysisTokens.set(track.videoId, analysisToken);
    // Phase 8 (Codex, PR #39 round-14): stage an independent copy of
    // filePath for stem separation NOW, before this job is even enqueued —
    // several unrelated call sites (track promotion/stop/skip/prefetch
    // discard) can delete filePath at any point once this method returns,
    // including the entire time this job sits waiting its turn on a shared
    // queue (which a single full-track Demucs job can occupy for minutes —
    // docs/mix-transition-phase8.md §9, mitigated but not eliminated by
    // Phase 9C's queue split below). Copying later, e.g. as the first
    // statement inside the enqueued callback, would already be too late in
    // exactly that scenario. Best-effort: if staging fails, separation for
    // this track is simply skipped below.
    const stagedPathPromise = this.#stageTempFileCopyFn(filePath).catch((err) => {
      log.warn({ event: 'playback.failed_to_stage_file_for_stem_separation', err }, 'ステム分離用ファイルの配置に失敗');
      return null;
    });

    // Phase 9C (docs/mix-transition-phase9.md §5): releases
    // #scheduledAnalysisTokens's dedup guard and cleans up the staged
    // copy. Whichever branch below actually owns the staged file's
    // lifetime for this attempt — "no separation dispatched" (aborted, or
    // staging itself failed) vs. "separation dispatched on the stem
    // queue" — calls this exactly once, so the guard/cleanup logic isn't
    // duplicated per branch. Same compare-and-delete rationale as before
    // the split (Codex): analysisQueue.kill()/noteUnderrun() rejects via
    // Promise.race() the instant a job is killed, possibly before this
    // ever runs; if a newer attempt for this videoId already replaced the
    // token in that gap, leave it alone.
    const finishAnalysisAttempt = (stagedPath) => {
      if (stagedPath) cleanupTempFile(stagedPath).catch(() => {});
      if (this.#scheduledAnalysisTokens.get(track.videoId) === analysisToken) {
        this.#scheduledAnalysisTokens.delete(track.videoId);
        // The whole attempt (including any kill retry) is over only here —
        // this, not the earlier tracker settle, is what lets C proceed.
        this.#onStemPrefetchSettled?.();
      }
    };

    this.#analysisQ().enqueue(async ({ spawnNice, signal } = {}) => {
      // CodeRabbit (PR #39 round-15): the staged copy must be cleaned up
      // whether analysis succeeds, fails at any step, or is cancelled —
      // lookupPersistentAnalysis()/runAnalysis() rejecting (including an
      // ANALYSIS_KILLED abort) must not skip cleanup. The try/catch below
      // routes every exit path through finishAnalysisAttempt() exactly
      // once (either here, on failure/no-dispatch, or later inside the
      // stem-queue job's own .finally() once separation settles).
      //
      // Codex (PR #39 round-17): runAnalysis() itself must also read from
      // the staged copy, not the original filePath — the whole reason
      // filePath got staged in the first place is that it can be deleted
      // by unrelated cleanup at any point once this job is enqueued,
      // runAnalysis() is just as exposed to that as separation was.
      // Awaited once up front (already-settled by the time this callback
      // runs, in the overwhelming majority of cases) so both steps below
      // share the same value; falls back to filePath only if staging
      // itself failed, matching this job's existing best-effort posture.
      const stagedPath = await stagedPathPromise;
      try {
        const cached = await this.lookupPersistentAnalysis(track);
        const analysis = cached ?? await this.runAnalysis(track, stagedPath ?? filePath, { spawnFn: spawnNice, signal });
        // Best-effort: a failure here just means this track never becomes
        // stem-mix eligible, the existing beatmix/phrase-crossfade/legacy
        // ladder is untouched either way.
        // Skip rather than start a many-minute Demucs run against a job
        // the (realtime) queue already decided to cancel (e.g. a mixer
        // underrun killed this job right as runAnalysis finished).
        // Stems already on disk (separated earlier, or by C's LOW prefetch):
        // use them now instead of queueing a job that would only find them
        // in the cache after waiting behind a running Demucs (~4 min seen in
        // production).
        const cachedStems = !signal?.aborted && this.#getCachedStemsFn
          ? await this.#getCachedStemsFn(track.videoId).catch(() => null)
          : null;
        if (cachedStems) {
          this.#settleStemPrefetch(track.videoId, true);
          this.enrichVocalFromStems(track, cachedStems).catch((err) => {
            log.warn({ event: 'playback.vocal_analysis_from_stems_failed', trackId: track.videoId, err }, 'ステムからのボーカル解析に失敗');
          });
          finishAnalysisAttempt(stagedPath);
          return analysis;
        }
        if (!signal?.aborted && stagedPath && this.#isStemSeparationAvailableFn()) {
          // Phase 9C (docs/mix-transition-phase9.md §5): dispatch the
          // heavy full-track Demucs step on the dedicated
          // StemPreparationQueue instead of this (realtime) queue —
          // deliberately NOT awaited here. Awaiting would keep this
          // realtime job "running" for as long as Demucs takes, blocking
          // BPM/downbeat/phrase/key/vocal-activity analysis for the next
          // queued track behind it — exactly the §9 problem this phase
          // fixes. The stem job's own .finally() below owns
          // cleanup/token-release for this attempt once separation
          // actually settles; this realtime job returns immediately.
          // Codex review (PR #45, P1): give this a real priority instead of
          // implicit call-order-only FIFO — B (HIGH, tracked by
          // stemPrefetchTracker) must not sit behind an already-pending
          // LOW (C) job. A (the currently-playing track, untracked here —
          // §4.2 deliberately keeps A outside stemPrefetchTracker) stays
          // at the default 'normal' priority, unchanged from pre-9C
          // behavior.
          const stemJobPriority = this.#stemPrefetchTracker.get(track.videoId)?.priority === StemPrefetchPriority.HIGH
            ? 'high'
            : 'normal';
          // Codex review (PR #45, P2, round 2): retry directly from THIS
          // staged copy instead of re-staging from `filePath` via a fresh
          // scheduleAnalysis(track, filePath) call — by the time a
          // stem-queue-level kill happens, `filePath` (the original
          // normalized file) may already be gone via track promotion/end
          // cleanup, since the split stem queue can now hold this job
          // independently for minutes. `runSeparation` is recursive so the
          // one retry it allows reuses the exact same still-on-disk staged
          // file rather than depending on anything that could have been
          // cleaned up in between. Cleanup of `stagedPath` and release of
          // this attempt's #scheduledAnalysisTokens entry are decoupled:
          // the former only happens once every attempt (original + at most
          // one retry) has truly settled, the latter happens exactly once
          // regardless of how many attempts ran.
          // Codex review (PR #45, P2, round 3): stemCache.js's default
          // separateTrackStems() dedups per-videoId via its own module-level
          // `inFlight` Map, cleared only once that specific call's own
          // promise settles — the stem queue's kill only rejects the OUTER
          // race in analysisQueue.js's pump(), it does not cancel or clear
          // this inner call. `currentAttemptSeparation` captures that inner
          // promise so a retry can await it settling (swallowing whatever
          // it resolves/rejects to — it's about to be discarded either way)
          // before dispatching the replacement attempt; otherwise
          // separateTrackStems()'s own dedup check would just hand the
          // retry back this same doomed (killed → resolves null) promise,
          // silently burning the one retry for nothing.
          let currentAttemptSeparation = null;
          const runSeparation = (allowRetry) => this.#stemQ().enqueue(async ({ spawnNice: stemSpawnNice, signal: stemSignal, pausedMs: stemPausedMs } = {}) => {
            if (stemSignal?.aborted) return null;
            // Plan Phase 1 #2: the stem queue is serial and a job can wait
            // minutes for its turn. By then the track may have been played,
            // skipped or removed — separating it would only delay the jobs
            // for tracks that are still coming up.
            if (!this.#isStemJobRelevant(track.videoId)) {
              log.debug({ event: 'playback.stem_job_stale', trackId: track.videoId }, '不要になったステム分離ジョブを破棄');
              return null;
            }
            currentAttemptSeparation = this.#separateTrackStemsFn(stagedPath, track.videoId, { spawnFn: stemSpawnNice, signal: stemSignal, getPausedMs: stemPausedMs });
            return currentAttemptSeparation;
          }, { priority: stemJobPriority }).then(
            (stems) => {
              // Phase 9B: this is the one place that actually learns when a
              // HIGH-priority (B) stem prefetch finishes — #ensureStemPrefetch()
              // itself only re-polls getCachedStemsFn() on the NEXT
              // #prefetchUpcoming() checkpoint, which for B may not come
              // again before it becomes the current track and drops out of
              // that method's purview entirely. Only touches the tracker if
              // this videoId is actually being tracked (#ensureStemPrefetch()
              // was called for it) — scheduleAnalysis() runs for every
              // normalized track, current (A) included, and A must stay
              // untouched by this (§4.2: 9B doesn't change #ensureOutgoingStemPrep()'s
              // existing treatment of A).
              if (this.#stemPrefetchTracker.get(track.videoId)) {
                if (stems) this.#settleStemPrefetch(track.videoId, true);
                else this.#settleStemPrefetch(track.videoId, false);
              }
              if (stems) {
                this.enrichVocalFromStems(track, stems).catch((err) => {
                  log.warn({ event: 'playback.vocal_analysis_from_stems_failed', trackId: track.videoId, err }, 'ステムからのボーカル解析に失敗');
                });
              }
            },
            (err) => {
              log.warn({ event: 'playback.stem_separation_failed', err }, 'ステム分離に失敗');
              if (this.#stemPrefetchTracker.get(track.videoId)) {
                this.#settleStemPrefetch(track.videoId, false);
              }
              // Codex review (PR #45, P2): a stem-queue-level ANALYSIS_KILLED
              // (this queue's own pause/kill machinery preempting the job,
              // e.g. maxPauses exceeded during a sustained underrun) rejects
              // here, one level below the realtime #analysisQ() job that
              // dispatched it — that job already resolved by the time this
              // rejects (the dispatch above is deliberately not awaited), so
              // the outer .catch()'s own ANALYSIS_KILLED retry (below) is
              // never reached for this kind of kill. Same bounded-once-per-
              // videoId retry as that outer catch.
              if (
                allowRetry
                && err?.code === 'ANALYSIS_KILLED'
                && this.#stemPrefetchTracker.get(track.videoId)
                && !this.stemPrefetchRetriedAfterKill.has(track.videoId)
              ) {
                this.stemPrefetchRetriedAfterKill.add(track.videoId);
                return (currentAttemptSeparation ?? Promise.resolve()).catch(() => {}).then(() => runSeparation(false));
              }
            },
          );
          runSeparation(true).finally(() => finishAnalysisAttempt(stagedPath));
          return analysis;
        } else {
          // Separation is off or the circuit breaker is open: no new stems,
          // but ones already on disk can still fill a deferred analysis.
          if (!signal?.aborted && analysis && this.#getCachedStemsFn) {
            this.#getCachedStemsFn(track.videoId)
              .then((stems) => (stems ? this.enrichVocalFromStems(track, stems) : null))
              .catch((err) => {
                log.warn({ event: 'playback.vocal_analysis_from_stems_failed', trackId: track.videoId, err }, 'ステムからのボーカル解析に失敗');
              });
          }
        }
        // Reaching here means separation was not dispatched (the branch
        // above returns), so the tracker entry would otherwise stay stuck.
        if (this.#stemPrefetchTracker.get(track.videoId)) {
          // Codex review (PR #44, carried into Phase 9C's stem-queue
          // restructure): staging failed (stagedPath null), or this job
          // was aborted before separation was even attempted — either way
          // it's exiting without ever reaching the stem-queue dispatch
          // above, so the markReady/markFailed pair there never runs. Mark
          // it failed here instead of leaving the tracked entry stuck
          // reporting PROCESSING forever (prune() deliberately never
          // collects a PROCESSING/QUEUED entry) — a later
          // #prefetchUpcoming() checkpoint will retry it.
          this.#settleStemPrefetch(track.videoId, false);
        }
        finishAnalysisAttempt(stagedPath);
        return analysis;
      } catch (err) {
        finishAnalysisAttempt(stagedPath);
        throw err;
      }
    }).catch((err) => {
      // Belt-and-suspenders: the finally above already removes this on
      // every path through the callback body. This only matters if
      // enqueue() itself rejects without ever invoking that callback.
      if (this.#scheduledAnalysisTokens.get(track.videoId) === analysisToken) {
        this.#scheduledAnalysisTokens.delete(track.videoId);
      }
      // Codex review (PR #44): lookupPersistentAnalysis()/runAnalysis()
      // throwing (including an ANALYSIS_KILLED abort) before ever reaching
      // the separation step above means neither markReady/markFailed branch
      // there ran either — same "don't leave it stuck at PROCESSING
      // forever" reasoning.
      const tracked = this.#stemPrefetchTracker.get(track.videoId);
      if (tracked) {
        this.#settleStemPrefetch(track.videoId, false);
      }
      if (err?.code === 'ANALYSIS_KILLED') {
        log.warn({ event: 'playback.analysis_yielded_to_mixer', err }, '解析をミキサーに譲渡');
        // Codex review (PR #44, P2): specifically an ANALYSIS_KILLED abort
        // (a real-time-pressure preemption, e.g. a mixer underrun stopping
        // this job mid-run) is the transient case worth retrying — unlike
        // separateTrackStemsFn() resolving a clean `null` (a genuine "this
        // track has no separable stems" outcome the existing Phase 8 tests
        // rely on staying a one-shot attempt), a kill says nothing about
        // whether the track is actually separable. filePath is still the
        // one this call was given, not a staged copy — the file this HIGH
        // track's full-prefetch download resolved to, still present since
        // it hasn't been promoted/consumed yet. Retried at most once per
        // videoId (stemPrefetchRetriedAfterKill) to avoid looping forever
        // against a guild that's continuously CPU-starved.
        if (tracked && !this.stemPrefetchRetriedAfterKill.has(track.videoId)) {
          this.stemPrefetchRetriedAfterKill.add(track.videoId);
          this.scheduleAnalysis(track, filePath);
        }
        return;
      }
      log.warn({ event: 'playback.analysis_failed', err }, '解析に失敗');
    });
  }

  async lookupPersistentAnalysis(track) {
    if (!track?.videoId) return null;
    if (this.analysisCache.has(track.videoId)) {
      const cached = this.analysisCache.get(track.videoId);
      this.#applyAnalysisDuration(track, cached);
      return cached;
    }
    if (!this.#getTrackAnalysisFn) return null;
    const cached = await this.#getTrackAnalysisFn(track.videoId);
    if (isReusableAnalysis(cached)) {
      this.#analysisMissAt.delete(track.videoId);
      this.analysisCache.set(track.videoId, cached);
      this.#applyAnalysisDuration(track, cached);
      return cached;
    }
    return null;
  }

  async getCachedAnalysis(track) {
    if (!track) return null;
    if (track.videoId && this.analysisCache.has(track.videoId)) {
      const cached = this.analysisCache.get(track.videoId);
      this.#applyAnalysisDuration(track, cached);
      return cached;
    }
    if (track.videoId && this.#getTrackAnalysisFn) {
      const missedAt = this.#analysisMissAt.get(track.videoId);
      if (missedAt != null && Date.now() - missedAt < ANALYSIS_MISS_BACKOFF_MS) {
        return null;
      }
      const cached = await this.#getTrackAnalysisFn(track.videoId);
      if (isReusableAnalysis(cached)) {
        this.#analysisMissAt.delete(track.videoId);
        this.analysisCache.set(track.videoId, cached);
        this.#applyAnalysisDuration(track, cached);
        return cached;
      }
      this.#analysisMissAt.set(track.videoId, Date.now());
    }
    return null;
  }

  async runAnalysis(track, filePath, { spawnFn, signal, durationSec } = {}) {
    throwIfAborted(signal);
    if (!filePath || !this.#analyzeTrackFileFn) return null;
    const probedDuration = durationSec
      ?? (track.videoId ? this.probedDurationCache.get(track.videoId) : null)
      ?? null;
    const analysis = await this.#analyzeTrackFileFn(filePath, {
      videoId: track.videoId,
      durationSec: probedDuration,
      spawnFn,
      signal,
      // Vocal activity comes from the stems once separation finishes
      // (enrichVocalFromStems below). Running Demucs here, single-threaded on
      // the realtime queue, took ~300 s and timed out for most tracks — so
      // BPM/phrase data was routinely not ready by the time the track hit
      // its transition.
      // Only while stem separation is switched on: with it disabled no stems
      // will ever arrive, so keep the in-analysis pass (slow, but the only
      // source of vocal data then). A merely open circuit breaker still
      // defers — falling back to single-threaded Demucs would bring the
      // ~300 s analysis stall right back.
      vocalActivity: this.#analyzeVocalFromStemsFn && this.#isStemSeparationEnabledFn() ? 'deferred' : 'demucs',
    });
    throwIfAborted(signal);
    if (!analysis) return null;
    if (track.videoId) {
      this.analysisCache.set(track.videoId, analysis);
      this.#putTrackAnalysisFn?.(track.videoId, analysis);
      if (analysis.durationSec != null) {
        this.probedDurationCache.set(track.videoId, analysis.durationSec);
      }
    }
    this.#applyAnalysisDuration(track, analysis);
    return analysis;
  }

  /**
   * Fills a deferred analysis' vocal fields from freshly separated (or
   * already cached) stems. Runs on the realtime analysis queue — it is only
   * a few ffmpeg level passes, no Demucs.
   * @returns {Promise<object|null>} the updated analysis, or null when nothing changed
   */
  async enrichVocalFromStems(track, stems) {
    if (!this.#analyzeVocalFromStemsFn || !track?.videoId || !stems) return null;
    const before = this.analysisCache.get(track.videoId) ?? await this.lookupPersistentAnalysis(track);
    if (!before || before.analysisSource === 'demucs' || !(before.durationSec > 0)) return null;
    const vocal = await this.#analysisQ().enqueue(({ spawnNice } = {}) => this.#analyzeVocalFromStemsFn(stems, {
      durationSec: before.durationSec,
      spawnFn: spawnNice,
    }));
    if (!vocal?.ok) {
      log.info({ event: 'playback.vocal_analysis_from_stems_failed', trackId: track.videoId }, 'ステムからのボーカル解析に失敗');
      return null;
    }
    // A re-analysis may have replaced the entry while the queue job ran;
    // apply onto whatever is current so it is not silently reverted.
    const current = this.analysisCache.get(track.videoId) ?? before;
    if (current.analysisSource === 'demucs') return null;
    // Vocal boundaries were computed against before.durationSec; a
    // re-analysis that changed the length would misplace them.
    if (current.durationSec !== before.durationSec) return null;
    const enriched = applyVocalActivity(current, vocal);
    this.analysisCache.set(track.videoId, enriched);
    this.#putTrackAnalysisFn?.(track.videoId, enriched);
    log.info({
      event: 'playback.vocal_analysis_from_stems',
      trackId: track.videoId,
      firstVocalStartSec: enriched.firstVocalStartSec,
      lastVocalEndSec: enriched.lastVocalEndSec,
      vocalConfidence: enriched.vocalConfidence,
    }, 'ステムからボーカル解析を反映');
    return enriched;
  }

  /** Marks a tracked (B/C) stem prefetch as done. C is released separately, in finishAnalysisAttempt. */
  #settleStemPrefetch(videoId, ok) {
    if (!this.#stemPrefetchTracker.get(videoId)) return;
    if (ok) this.#stemPrefetchTracker.markReady(videoId);
    else this.#stemPrefetchTracker.markFailed(videoId);
  }

  /** Whether an analysis → separation attempt (incl. a pending retry) for this track is still running. */
  isStemAttemptInFlight(videoId) {
    return Boolean(videoId) && this.#scheduledAnalysisTokens.has(videoId);
  }

  async resolveAnalysis(track, filePath = null) {
    const cached = await this.getCachedAnalysis(track);
    if (cached) return cached;
    if (!filePath) return null;
    return this.runAnalysis(track, filePath);
  }
}

import { cleanupTempFile } from '../../audio/normalize.js';
import { ANALYSIS_VERSION } from '../../audio/trackAnalysis.js';
import { getAnalysisQueue, getStemPreparationQueue } from '../../audio/analysisQueue.js';
import { StemPrefetchPriority } from '../../audio/stemPrefetch.js';

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
      console.warn('[GuildPlayer] failed to stage file for stem separation:', err.message);
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
        if (!signal?.aborted && stagedPath) {
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
          const runSeparation = (allowRetry) => this.#stemQ().enqueue(async ({ spawnNice: stemSpawnNice, signal: stemSignal } = {}) => {
            if (stemSignal?.aborted) return null;
            currentAttemptSeparation = this.#separateTrackStemsFn(stagedPath, track.videoId, { spawnFn: stemSpawnNice, signal: stemSignal });
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
                if (stems) this.#stemPrefetchTracker.markReady(track.videoId);
                else this.#stemPrefetchTracker.markFailed(track.videoId);
              }
            },
            (err) => {
              console.warn('[GuildPlayer] stem separation failed:', err.message);
              if (this.#stemPrefetchTracker.get(track.videoId)) {
                this.#stemPrefetchTracker.markFailed(track.videoId);
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
        } else if (this.#stemPrefetchTracker.get(track.videoId)) {
          // Codex review (PR #44, carried into Phase 9C's stem-queue
          // restructure): staging failed (stagedPath null), or this job
          // was aborted before separation was even attempted — either way
          // it's exiting without ever reaching the stem-queue dispatch
          // above, so the markReady/markFailed pair there never runs. Mark
          // it failed here instead of leaving the tracked entry stuck
          // reporting PROCESSING forever (prune() deliberately never
          // collects a PROCESSING/QUEUED entry) — a later
          // #prefetchUpcoming() checkpoint will retry it.
          this.#stemPrefetchTracker.markFailed(track.videoId);
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
        this.#stemPrefetchTracker.markFailed(track.videoId);
      }
      if (err?.code === 'ANALYSIS_KILLED') {
        console.warn('[GuildPlayer] analysis yielded to mixer:', err.message);
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
      console.warn('[GuildPlayer] analysis failed:', err.message);
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
    if (cached && (cached.version ?? 1) >= ANALYSIS_VERSION) {
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
      if (cached && (cached.version ?? 1) >= ANALYSIS_VERSION) {
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

  async resolveAnalysis(track, filePath = null) {
    const cached = await this.getCachedAnalysis(track);
    if (cached) return cached;
    if (!filePath) return null;
    return this.runAnalysis(track, filePath);
  }
}

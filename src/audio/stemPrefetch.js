/**
 * Phase 9B (docs/mix-transition-phase9.md §4): per-track bookkeeping for
 * stem prefetch ahead of the current track. This module is deliberately
 * pure/synchronous — it never spawns anything and never touches the
 * filesystem. It only remembers, per videoId, what player.js's own
 * #ensureStemPrefetch() last learned about that track's stem-separation
 * progress, so the actual scheduling/dedup keeps living where it already
 * does (stemCache.js's per-videoId in-flight map, player.js's
 * #scheduledAnalysisTokens / #prefetchEntries, and the shared
 * analysisQueue). §5's dedicated priority-lane StemPreparationQueue
 * (RealtimeAnalysisQueue vs StemPreparationQueue, concurrency=1,
 * CPU-pressure pause) is explicitly Phase 9C's job, not this module's.
 */

/** §4.3's exact values. */
export const StemPreparationState = Object.freeze({
  NONE: 'none',
  QUEUED: 'queued',
  PROCESSING: 'processing',
  READY: 'ready',
  FAILED: 'failed',
});

/**
 * §4.2's two prefetch lanes: B (next) is HIGH, C (next+1) is LOW. Not a
 * real scheduling priority (no dedicated queue exists yet, §5.3/§5.4 are
 * Phase 9C) — today it only labels *why* a track is being prefetched, and
 * lets a later HIGH request escalate an already-queued LOW entry for the
 * same videoId (e.g. C is promoted to B after a skip). Actual ordering
 * between concurrently-prefetched tracks, to the extent any exists this
 * round, falls out of plain call order into the shared analysisQueue.
 */
export const StemPrefetchPriority = Object.freeze({
  HIGH: 'high',
  LOW: 'low',
});

/**
 * @typedef {object} StemPrefetchEntry
 * @property {string} videoId
 * @property {string} priority one of StemPrefetchPriority
 * @property {string} state one of StemPreparationState
 * @property {number} queuedAt epoch ms
 * @property {number|null} startedAt epoch ms
 * @property {number|null} completedAt epoch ms (set on READY or FAILED)
 */

export class StemPrefetchTracker {
  /** @type {Map<string, StemPrefetchEntry>} */
  #entries = new Map();

  /** @returns {StemPrefetchEntry|null} */
  get(videoId) {
    return this.#entries.get(videoId) ?? null;
  }

  /**
   * Registers intent to prefetch this videoId's stems, or returns the
   * existing entry unchanged (state/timestamps preserved) if one is
   * already tracked — except a HIGH request always wins on priority, so a
   * track that was queued as C (LOW) and is then promoted to B (HIGH,
   * e.g. after a skip) gets relabeled without losing its in-flight state.
   * @param {string} videoId
   * @param {string} priority
   * @returns {StemPrefetchEntry|null}
   */
  queue(videoId, priority) {
    if (!videoId) return null;
    const existing = this.#entries.get(videoId);
    if (existing) {
      if (priority === StemPrefetchPriority.HIGH && existing.priority !== StemPrefetchPriority.HIGH) {
        existing.priority = priority;
      }
      return existing;
    }
    const entry = {
      videoId,
      priority,
      state: StemPreparationState.QUEUED,
      queuedAt: Date.now(),
      startedAt: null,
      completedAt: null,
    };
    this.#entries.set(videoId, entry);
    return entry;
  }

  markProcessing(videoId) {
    const entry = this.#entries.get(videoId);
    if (!entry) return;
    if (entry.state !== StemPreparationState.PROCESSING) {
      entry.startedAt = Date.now();
    }
    entry.state = StemPreparationState.PROCESSING;
  }

  markReady(videoId) {
    const entry = this.#entries.get(videoId);
    if (!entry) return;
    entry.state = StemPreparationState.READY;
    entry.completedAt = Date.now();
  }

  markFailed(videoId) {
    const entry = this.#entries.get(videoId);
    if (!entry) return;
    entry.state = StemPreparationState.FAILED;
    entry.completedAt = Date.now();
  }

  /**
   * Drops tracked entries for videoIds that fell out of the prefetch
   * window (reorder/skip/remove moved them out of next/next+1, or they
   * simply left the queue) — mirrors player.js's own #stemMixUnavailableKey
   * / #stemCacheHit staleness-by-key pattern, just keyed per-track instead
   * of per-(current,next)-pair since this module tracks several tracks at
   * once. An entry still QUEUED/PROCESSING is left alone even if it's no
   * longer in the active set: there is no cancellation API for an
   * in-flight Demucs run yet, so the best this can do is let it finish
   * (or fail) naturally and get pruned on a later call once it reaches a
   * terminal state.
   * @param {Iterable<string>} activeVideoIds
   */
  prune(activeVideoIds) {
    const keep = new Set([...activeVideoIds].filter(Boolean));
    for (const [videoId, entry] of this.#entries) {
      if (keep.has(videoId)) continue;
      if (entry.state === StemPreparationState.QUEUED || entry.state === StemPreparationState.PROCESSING) continue;
      this.#entries.delete(videoId);
    }
  }

  /** @returns {Record<string, number>} counts per StemPreparationState, for observability. */
  counts() {
    const out = {
      [StemPreparationState.NONE]: 0,
      [StemPreparationState.QUEUED]: 0,
      [StemPreparationState.PROCESSING]: 0,
      [StemPreparationState.READY]: 0,
      [StemPreparationState.FAILED]: 0,
    };
    for (const entry of this.#entries.values()) {
      out[entry.state] = (out[entry.state] ?? 0) + 1;
    }
    return out;
  }

  /** @returns {StemPrefetchEntry[]} a snapshot array, for tests/observability. */
  snapshot() {
    return [...this.#entries.values()].map((entry) => ({ ...entry }));
  }
}

/**
 * Aggregates MixStream underruns into periodic log lines (plan Phase 1 #8).
 *
 * MixStream emits 'underrun' for every 20 ms silence frame it pads in and
 * one 'underrunClear' when real audio resumes. Logging each frame would
 * flood the log, and logging nothing (the previous state) left no way to
 * tell whether stem separation was starving playback of CPU. This keeps a
 * running tally and hands back a summary at most once per `flushEveryMs`,
 * at the moment an underrun episode ends.
 */
export class UnderrunStats {
  #clock;
  #flushEveryMs;
  #episodeStart = null;
  #episodes = 0;
  #totalMs = 0;
  #maxMs = 0;
  #windowStart;

  constructor({ clock = () => Date.now(), flushEveryMs = 60_000 } = {}) {
    this.#clock = clock;
    this.#flushEveryMs = flushEveryMs;
    this.#windowStart = clock();
  }

  noteUnderrun() {
    if (this.#episodeStart != null) return;
    this.#episodeStart = this.#clock();
    this.#episodes += 1;
  }

  /** @returns {{ episodes: number, totalMs: number, maxMs: number, windowMs: number } | null} a summary when one is due */
  noteCleared() {
    if (this.#episodeStart == null) return null;
    const now = this.#clock();
    const ms = Math.max(0, now - this.#episodeStart);
    this.#episodeStart = null;
    this.#totalMs += ms;
    this.#maxMs = Math.max(this.#maxMs, ms);
    if (now - this.#windowStart < this.#flushEveryMs) return null;
    const summary = { episodes: this.#episodes, totalMs: this.#totalMs, maxMs: this.#maxMs, windowMs: now - this.#windowStart };
    this.#episodes = 0;
    this.#totalMs = 0;
    this.#maxMs = 0;
    this.#windowStart = now;
    return summary;
  }
}

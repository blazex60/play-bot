export const LoopMode = Object.freeze({ OFF: 'off', TRACK: 'track', QUEUE: 'queue' });

export function createTrack({ title, webpageUrl, duration, requestedBy, requestedById = null, thumbnail, videoId = null, channel = null }) {
  return { title, webpageUrl, duration, requestedBy, requestedById, thumbnail, videoId, channel };
}

/** Stable identity for snapshot checks during async optimize. */
export function trackIdentity(track) {
  if (track?.videoId) return `vid:${track.videoId}`;
  if (track?.webpageUrl) return `url:${track.webpageUrl}`;
  return `title:${track?.title ?? ''}`;
}

/**
 * @param {object[]} tracks
 * @param {string[]} snapshotIds from trackIdentity at optimize start
 * @returns {boolean}
 */
export function sameTrackSnapshot(tracks, snapshotIds) {
  if (!Array.isArray(tracks) || !Array.isArray(snapshotIds)) return false;
  if (tracks.length !== snapshotIds.length) return false;
  for (let i = 0; i < tracks.length; i += 1) {
    if (trackIdentity(tracks[i]) !== snapshotIds[i]) return false;
  }
  return true;
}

export class GuildQueue {
  #tracks = [];
  #currentIndex = 0;
  loopMode = LoopMode.OFF;

  get current() {
    if (!this.#tracks.length || this.#currentIndex >= this.#tracks.length) return null;
    return this.#tracks[this.#currentIndex];
  }

  get isEmpty() {
    return this.#tracks.length === 0;
  }

  add(track) {
    this.#tracks.push(track);
  }

  clear() {
    this.#tracks = [];
    this.#currentIndex = 0;
  }

  shuffle() {
    const start = this.#currentIndex + 1;
    if (start >= this.#tracks.length) return;
    for (let i = this.#tracks.length - 1; i > start; i--) {
      const j = start + Math.floor(Math.random() * (i - start + 1));
      [this.#tracks[i], this.#tracks[j]] = [this.#tracks[j], this.#tracks[i]];
    }
  }

  cycleLoop() {
    const modes = [LoopMode.OFF, LoopMode.TRACK, LoopMode.QUEUE];
    const idx = modes.indexOf(this.loopMode);
    this.loopMode = modes[(idx + 1) % modes.length];
    return this.loopMode;
  }

  next({ forceAdvance = false } = {}) {
    if (!this.#tracks.length) return null;
    if (this.loopMode === LoopMode.TRACK && !forceAdvance) {
      return this.#tracks[this.#currentIndex];
    }
    this.#currentIndex += 1;
    if (this.#currentIndex >= this.#tracks.length) {
      if (this.loopMode === LoopMode.QUEUE) {
        this.#currentIndex = 0;
      } else {
        this.#tracks = [];
        this.#currentIndex = 0;
        return null;
      }
    }
    return this.#tracks[this.#currentIndex];
  }

  upcoming() {
    if (!this.#tracks.length) return [];
    return this.#tracks.slice(this.#currentIndex + 1);
  }

  /**
   * Like upcoming(), but in QUEUE loop mode wraps around to the front of
   * the queue once upcoming() runs out — mirroring what next() actually
   * does at the boundary. Codex review (PR #44): a plain upcoming().slice()
   * gave the last track no lookahead at all, and the penultimate track a
   * truncated one, even though QUEUE loop mode means both DO have a real
   * next track. Never re-includes the current track (stops before a full
   * lap), so a 1-track QUEUE-loop queue returns [] here just like
   * upcoming() does.
   * @param {number} count
   */
  wrappedUpcoming(count) {
    const tail = this.upcoming();
    if (tail.length >= count || this.loopMode !== LoopMode.QUEUE) {
      return tail.slice(0, count);
    }
    const window = [...tail];
    for (let i = 0; i < this.#tracks.length && window.length < count; i += 1) {
      if (i === this.#currentIndex) break;
      window.push(this.#tracks[i]);
    }
    return window;
  }

  #upcomingToAbsolute(upcomingIndex) {
    const abs = this.#currentIndex + 1 + upcomingIndex;
    if (upcomingIndex < 0 || abs >= this.#tracks.length) return null;
    return abs;
  }

  removeUpcoming(upcomingIndex) {
    const abs = this.#upcomingToAbsolute(upcomingIndex);
    if (abs === null) return false;
    this.#tracks.splice(abs, 1);
    return true;
  }

  moveUpcoming(fromIndex, toIndex) {
    const len = this.upcoming().length;
    if (fromIndex < 0 || fromIndex >= len || toIndex < 0 || toIndex >= len || fromIndex === toIndex) return false;
    const absFrom = this.#upcomingToAbsolute(fromIndex);
    const absTo = this.#upcomingToAbsolute(toIndex);
    const [track] = this.#tracks.splice(absFrom, 1);
    this.#tracks.splice(absTo, 0, track);
    return true;
  }

  /**
   * Reorder upcoming tracks by a full permutation of upcoming indices.
   * @param {number[]} order upcoming-relative indices 0..upcoming().length-1
   * @returns {boolean}
   */
  reorderUpcoming(order) {
    const upcoming = this.upcoming();
    const len = upcoming.length;
    if (len === 0) return false;
    if (len === 1 && order.length === 1 && order[0] === 0) return true;
    if (!Array.isArray(order) || order.length !== len) return false;
    const seen = new Set();
    for (const idx of order) {
      if (!Number.isInteger(idx) || idx < 0 || idx >= len || seen.has(idx)) return false;
      seen.add(idx);
    }
    const reordered = order.map((idx) => upcoming[idx]);
    for (let i = 0; i < len; i += 1) {
      this.#tracks[this.#currentIndex + 1 + i] = reordered[i];
    }
    return true;
  }

  /**
   * Apply an optimize permutation only if upcoming still matches the pre-request snapshot.
   * @param {number[]} order
   * @param {string[]} snapshotIds
   * @returns {boolean}
   */
  reorderUpcomingIfUnchanged(order, snapshotIds) {
    if (!sameTrackSnapshot(this.upcoming(), snapshotIds)) return false;
    return this.reorderUpcoming(order);
  }

}

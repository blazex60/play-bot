export const LoopMode = Object.freeze({ OFF: 'off', TRACK: 'track', QUEUE: 'queue' });

export function createTrack({ title, webpageUrl, duration, requestedBy, thumbnail }) {
  return { title, webpageUrl, duration, requestedBy, thumbnail };
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
    const absFrom = this.#currentIndex + 1 + fromIndex;
    const absTo = this.#currentIndex + 1 + toIndex;
    const [track] = this.#tracks.splice(absFrom, 1);
    this.#tracks.splice(absTo, 0, track);
    return true;
  }

}

/**
 * In-process application service: the single entry point callers use to
 * operate playback. Adapters (Discord commands, the loopback bot API, the
 * local CLI, autoplay continuations) go through this facade instead of
 * combining `session.player` and `session.queue` themselves — most notably
 * the repeated "enqueue tracks, then start playback only if the queue was
 * empty" pattern that used to live in every call site.
 *
 * This is deliberately NOT a process/network boundary: it is a plain
 * JavaScript module wrapping the session's GuildPlayer + GuildQueue.
 *
 * Sessions are looked up through an injected `getSession(guildId)` thunk so
 * this module never imports sessions.js — sessions.js wires the shared
 * `playback` singleton and exports `playbackFor(map)` for callers handed a
 * sessions Map (tests inject their own).
 */

export class PlaybackService {
  #getSession;
  #onStop;

  /**
   * @param {{ getSession: (guildId: string) => object|undefined,
   *            onStop?: (guildId: string) => void }} deps
   *   onStop runs after every stop(): sessions.js wires it to plan-token
   *   invalidation + pending-recommendation cancellation, which is what
   *   "stop playback" means at the application level (a stale autoplay
   *   continuation or pickable prompt must not resurrect playback).
   */
  constructor({ getSession, onStop = null }) {
    if (typeof getSession !== 'function') throw new Error('PlaybackService requires getSession');
    this.#getSession = getSession;
    this.#onStop = onStop;
  }

  hasSession(guildId) {
    return Boolean(this.#getSession(guildId));
  }

  /**
   * Read-only snapshot of a guild's playback state for display/serialization.
   * Never exposes the GuildPlayer/GuildQueue objects themselves. Track
   * objects are plain data (createTrack) frozen at creation — every track in
   * the queue is immutable — so callers can't corrupt queue internals by
   * mutating what this returns.
   * @returns {{ active: true, current, upcoming, isEmpty, loopMode, status, positionSec }
   *         | { active: false, isEmpty: true }}
   */
  getState(guildId) {
    const session = this.#getSession(guildId);
    if (!session) return { active: false, isEmpty: true };
    return {
      active: true,
      current: session.queue.current,
      upcoming: session.queue.upcoming(),
      isEmpty: session.queue.isEmpty,
      loopMode: session.queue.loopMode,
      status: session.player?.status ?? 'unknown',
      // Position on the track's own (native) timeline — the value the
      // now-playing views and the local CLI display.
      positionSec: session.player?.trackPositionSec ?? 0,
    };
  }

  queueIsEmpty(guildId) {
    return this.getState(guildId).isEmpty;
  }

  /**
   * Adds tracks to the guild's queue and starts playback if it was empty.
   * @param {object[]} tracks
   * @param {{ onEnqueued?: (info: { wasEmpty: boolean }) => Promise<void>|void,
   *           awaitStart?: boolean,
   *           expectedSession?: object }} [options]
   *   onEnqueued runs after the adds but before playNext is started/awaited —
   *   callers use it for their "added to queue" confirmation so the reply
   *   ordering matches the old inline pattern.
   *   awaitStart: false starts playback without awaiting it (for the
   *   time-bounded queue-exhaustion continuation, where playNext must not
   *   block the handler).
   *   expectedSession pins this enqueue to one session object: it must still
   *   be the live session for the guild both at entry and after the
   *   onEnqueued await, or the call is abandoned. Stale continuations
   *   (autoplay planning that captured a session before /leave + rejoin)
   *   pass the session they planned against so they cannot add tracks to a
   *   replacement session.
   * @returns {Promise<{ wasEmpty: boolean, started: boolean } | null>}
   *   null when the guild has no session. On an expectedSession mismatch at
   *   entry returns { wasEmpty: false, started: false } without touching the
   *   queue or player. When the session is destroyed or swapped during the
   *   onEnqueued await, returns { wasEmpty, started: false } — the tracks
   *   were added to the (now-stale) session's queue but playback is not
   *   started and the live session is left alone.
   */
  async enqueue(guildId, tracks, { onEnqueued = null, awaitStart = true, expectedSession = null } = {}) {
    const session = this.#getSession(guildId);
    if (!session || !Array.isArray(tracks)) return null;
    if (expectedSession && session !== expectedSession) {
      return { wasEmpty: false, started: false };
    }
    const wasEmpty = session.queue.isEmpty;
    for (const track of tracks) session.queue.add(track);
    if (onEnqueued) await onEnqueued({ wasEmpty });
    // The await above is an open async window: /leave may have destroyed or
    // replaced the session and /stop may have cleared the queue. Never touch
    // a session that is no longer the live one — a stale enqueue must not
    // revive playback post-leave or act on a replacement session.
    if (this.#getSession(guildId) !== session) {
      return { wasEmpty, started: false };
    }
    let started = false;
    if (wasEmpty && tracks.length > 0) {
      // A stop() during the await cleared our tracks out (queue.clear), and
      // a rival enqueue may since have re-filled the queue. Only the enqueue
      // whose track still sits at the head may start playback — otherwise
      // both the cleared enqueue and the rival would call playNext and
      // double-start the rival's track.
      if (tracks.includes(session.queue.current)) {
        started = true;
        if (awaitStart) {
          await session.player.playNext();
        } else {
          // Fire-and-forget: callers in a bounded continuation can't afford to
          // await mixer startup (download + loudnorm can take tens of seconds).
          session.player.playNext().catch((err) => {
            console.error('[playback] playNext failed:', err?.message ?? err);
          });
        }
      }
    }
    return { wasEmpty, started };
  }

  pause(guildId) {
    const session = this.#getSession(guildId);
    return session ? session.player.pause() : null;
  }

  resume(guildId) {
    const session = this.#getSession(guildId);
    return session ? session.player.resume() : null;
  }

  async skip(guildId) {
    const session = this.#getSession(guildId);
    if (!session) return false;
    await session.player.skip();
    return true;
  }

  async stop(guildId) {
    const session = this.#getSession(guildId);
    if (!session) return false;
    await session.player.stop();
    this.#onStop?.(guildId);
    return true;
  }

  /**
   * @returns {Promise<number|false|null>} the applied (clamped) position,
   *   false when the seek was rejected, null when there is no session.
   */
  async seekTo(guildId, targetSec) {
    const session = this.#getSession(guildId);
    if (!session) return null;
    return session.player.seekTo(targetSec);
  }

  shuffle(guildId) {
    const session = this.#getSession(guildId);
    if (!session) return false;
    session.queue.shuffle();
    return true;
  }

  /** @returns {string|null} the new LoopMode, or null when there is no session. */
  cycleLoop(guildId) {
    const session = this.#getSession(guildId);
    return session ? session.queue.cycleLoop() : null;
  }

  removeUpcoming(guildId, upcomingIndex) {
    const session = this.#getSession(guildId);
    return session ? session.queue.removeUpcoming(upcomingIndex) : false;
  }

  moveUpcoming(guildId, fromIndex, toIndex) {
    const session = this.#getSession(guildId);
    return session ? session.queue.moveUpcoming(fromIndex, toIndex) : false;
  }

  reorderUpcomingIfUnchanged(guildId, order, snapshotIds) {
    const session = this.#getSession(guildId);
    return session ? session.queue.reorderUpcomingIfUnchanged(order, snapshotIds) : false;
  }
}

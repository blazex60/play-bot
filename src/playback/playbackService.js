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
  #onStopStart;

  /**
   * @param {{ getSession: (guildId: string) => object|undefined,
   *            onStopStart?: (guildId: string, session: object) => void,
   *            onStop?: (guildId: string, session: object) => void }} deps
   *   onStopStart runs BEFORE the player's async teardown, against the
   *   session captured at entry: sessions.js wires it to plan-token
   *   invalidation + pending-recommendation cancellation, so an in-flight
   *   recommend plan is dead from the first tick of stop() and cannot
   *   enqueue during the teardown window. Being session-bound, it lands
   *   on the session being stopped even if the map entry is later
   *   replaced (leave + rejoin mid-stop).
   *   onStop runs after stop() resolves, but only while the stopped
   *   session is still the live one — a leave + rejoin during the stop
   *   await must not let the old stop bump the NEW session's planToken
   *   or cancel ITS recommendations.
   */
  constructor({ getSession, onStop = null, onStopStart = null }) {
    if (typeof getSession !== 'function') throw new Error('PlaybackService requires getSession');
    this.#getSession = getSession;
    this.#onStop = onStop;
    this.#onStopStart = onStopStart;
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
   * @returns {{ active: true, current, upcoming, isEmpty, loopMode, status, positionSec, revision, queueId }
   *         | { active: false, isEmpty: true }}
   *   revision is the queue's optimistic-concurrency token — index-based
   *   mutators (the queue editor's move/remove buttons) embed it and pass
   *   it back via the *IfRevision methods so an operation submitted against
   *   an older render is rejected instead of hitting the wrong track.
   *   queueId is the queue's restart-safe identity (GuildQueue#id — a
   *   random UUID string): the revision restarts at 0 for every new
   *   session's queue, so the *IfRevision methods also require the queueId
   *   to match — a token minted against a destroyed session's queue (or a
   *   previous process's queue) can never mutate its replacement.
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
      revision: session.queue.revision ?? 0,
      queueId: session.queue.id ?? null,
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
   *
   *   Stop-lifecycle contract: playback is started only when no stop()
   *   was in flight at enqueue entry AND the player's stopGeneration is
   *   unchanged since entry. A mid-stop enqueue (or one a fresh stop
   *   overtakes mid-await) still lands its tracks on the live session's
   *   queue but reports started:false and never calls playNext — nothing
   *   here revives playback on top of, or right after, a stop. A stop
   *   that completed before entry does not block a fresh start.
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
    // Stop-lifecycle snapshot (see the contract above): a stop already in
    // flight, or one that begins during the awaits below, always wins.
    const stopInFlightAtEntry = session.player.isStopping === true;
    const stopGeneration = session.player.stopGeneration ?? 0;
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
      if (
        !stopInFlightAtEntry &&
        (session.player.stopGeneration ?? 0) === stopGeneration &&
        tracks.includes(session.queue.current)
      ) {
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
    // Stop-start invalidation fires BEFORE the async teardown: a
    // recommend plan or autoplay continuation resolving during stop()'s
    // cleanup window must already see a bumped planToken / cancelled
    // prompts, not only after teardown completes. It runs against the
    // session captured here, so a later session replacement can't
    // redirect it.
    this.#onStopStart?.(guildId, session);
    await session.player.stop();
    // The session may have been destroyed and replaced (leave + rejoin)
    // while stop's async cleanup was in flight — the completion hook must
    // not bump the NEW session's planToken or cancel ITS recommendations.
    if (this.#getSession(guildId) === session) {
      this.#onStop?.(guildId, session);
    }
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

  /**
   * Revision- and identity-checked variants for index-based UI operations:
   * the caller passes the revision AND queue id (a UUID string) embedded in
   * the rendered message, and the op applies only if both still match the
   * live queue. A missing, legacy-numeric, or foreign expectedQueueId can
   * never equal the live UUID, so it resolves 'stale'. Without the revision
   * check, a track removed ahead of the index between render and click
   * shifts every later index and the operation silently hits the wrong
   * track. Without the queueId check, a message rendered under a destroyed
   * session or a previous process could collide with the replacement
   * queue's revision (which restarts at 0) and mutate a session it never
   * saw.
   * @param {string|null} expectedQueueId
   * @returns {'stale'|true|false} 'stale' on a queueId or revision mismatch
   *   (nothing changed), true/false the underlying op's result, false when
   *   there is no session.
   */
  removeUpcomingIfRevision(guildId, upcomingIndex, expectedRevision, expectedQueueId) {
    const session = this.#getSession(guildId);
    if (!session) return false;
    if (session.queue.id !== expectedQueueId || session.queue.revision !== expectedRevision) return 'stale';
    return session.queue.removeUpcoming(upcomingIndex);
  }

  moveUpcomingIfRevision(guildId, fromIndex, toIndex, expectedRevision, expectedQueueId) {
    const session = this.#getSession(guildId);
    if (!session) return false;
    if (session.queue.id !== expectedQueueId || session.queue.revision !== expectedRevision) return 'stale';
    return session.queue.moveUpcoming(fromIndex, toIndex);
  }

}

import { LoopMode } from '../queue.js';

/**
 * Tracks a stem-mix transition can still involve: the one playing (its tail
 * window) and the next two (B's head now, C's once B plays). Mirrors
 * SourcePreparer.prefetchUpcoming(): QUEUE loop wraps to the front, TRACK
 * loop only ever transitions the current track into itself.
 * @param {import('../queue.js').GuildQueue} queue
 */
export function stemRelevantTracks(queue) {
  const ahead = queue.loopMode === LoopMode.TRACK ? [] : queue.wrappedUpcoming(2);
  return [queue.current, ...ahead].filter(Boolean);
}

/**
 * @param {{ currentRemainingSec?: number|null, minRemainingSec?: number }} [opts]
 *   The current track is only worth separating if the job can finish before
 *   it ends (its tail stems are for ITS exit); a track that is also one of
 *   the next two (QUEUE loop with a short queue) stays relevant regardless.
 */
export function isStemJobRelevantFor(queue, videoId, { currentRemainingSec = null, minRemainingSec = 0 } = {}) {
  if (!videoId) return false;
  const [current, ...ahead] = stemRelevantTracks(queue);
  if (ahead.some((t) => t.videoId === videoId)) return true;
  if (current?.videoId !== videoId) return false;
  return !(Number.isFinite(currentRemainingSec) && currentRemainingSec < minRemainingSec);
}

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

export function isStemJobRelevantFor(queue, videoId) {
  return Boolean(videoId) && stemRelevantTracks(queue).some((t) => t.videoId === videoId);
}

/**
 * Simulates the end of the currently playing track by emitting MixStream trackend.
 * GuildPlayer advances on trackend, not AudioPlayer Idle.
 */
export function triggerTrackEnd({ mixStream }) {
  if (!mixStream) {
    throw new Error('triggerTrackEnd requires mixStream');
  }
  mixStream.emit('trackend');
}

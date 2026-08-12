import { AudioPlayerStatus } from '@discordjs/voice';

/**
 * Simulates the end of the currently playing track.
 * Legacy path: fires the AudioPlayer Idle handler.
 * Mixer path (Phase 1+): will emit trackend on the MixStream instead.
 */
export function triggerTrackEnd({ audioPlayer, mixStream = null }) {
  if (mixStream) {
    mixStream.emit('trackend');
    return;
  }

  const idleHandler = audioPlayer.events?.get(AudioPlayerStatus.Idle);
  if (idleHandler) {
    idleHandler();
  }
}

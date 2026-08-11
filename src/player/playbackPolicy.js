export const RECONNECT_GRACE_MS = 5000;
export const SHORT_TRACK_THRESHOLD_SEC = 5;

export function isShortTrack(track) {
  return track?.duration != null && track.duration < SHORT_TRACK_THRESHOLD_SEC;
}

export function shouldReconnectRetry({ elapsedMs, track, hadError }) {
  return elapsedMs < RECONNECT_GRACE_MS && !isShortTrack(track) && !hadError;
}

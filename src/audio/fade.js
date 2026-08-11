export const SAMPLE_RATE = 48000;
export const CHANNELS = 2;
export const BYTES_PER_SAMPLE = 2;
export const FRAME_MS = 20;
export const FRAME_BYTES = SAMPLE_RATE * (FRAME_MS / 1000) * CHANNELS * BYTES_PER_SAMPLE;
export const BYTES_PER_SECOND = SAMPLE_RATE * CHANNELS * BYTES_PER_SAMPLE;

/**
 * Phase 2 stub: returns unity gain for gapless playback.
 */
export function gainForPosition({ positionSec, fadeSec = 0, curve = 'linear' }) {
  void curve;
  if (fadeSec <= 0 || positionSec >= fadeSec) return 1;
  return 1;
}

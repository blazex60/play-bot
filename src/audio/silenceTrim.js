/**
 * Leading/trailing silence trim for MIX crossfade.
 *
 * Applied offline on normalized downloads so remainingSec / analysis /
 * fade windows sit on audible audio rather than YouTube padding.
 */

/** Peak threshold for "silence" (digital padding / soft YouTube tails). */
export const SILENCE_TRIM_THRESHOLD_DB = -50;

/** Keep a tiny pad so attack/release are not clipped. */
export const SILENCE_TRIM_KEEP_SEC = 0.02;

/**
 * ffmpeg silenceremove filter: trim leading + trailing quiet sections.
 * stop_periods must be positive (1): negative values restart and strip
 * mid-track silence (ffmpeg docs), which we do not want for padding trim.
 */
export function buildSilenceTrimFilter({
  thresholdDb = SILENCE_TRIM_THRESHOLD_DB,
  keepSec = SILENCE_TRIM_KEEP_SEC,
} = {}) {
  const thr = `${thresholdDb}dB`;
  return [
    'silenceremove=',
    `start_periods=1:start_duration=0:start_threshold=${thr}:start_silence=${keepSec}:`,
    `stop_periods=1:stop_duration=0:stop_threshold=${thr}:stop_silence=${keepSec}:`,
    'detection=peak',
  ].join('');
}

export const SILENCE_TRIM_FILTER = buildSilenceTrimFilter();

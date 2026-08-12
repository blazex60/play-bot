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
 * ffmpeg filter chain: trim leading + trailing quiet sections only.
 *
 * Uses areverse + start_periods (never stop_periods). Even positive
 * stop_periods still drops mid-track silence in silenceremove's stream
 * mode, which would crush intentional pauses / bridges.
 */
export function buildSilenceTrimFilter({
  thresholdDb = SILENCE_TRIM_THRESHOLD_DB,
  keepSec = SILENCE_TRIM_KEEP_SEC,
} = {}) {
  const thr = `${thresholdDb}dB`;
  const lead = [
    'silenceremove=',
    `start_periods=1:start_duration=0:start_threshold=${thr}:start_silence=${keepSec}:`,
    'detection=peak',
  ].join('');
  return `areverse,${lead},areverse,${lead}`;
}

export const SILENCE_TRIM_FILTER = buildSilenceTrimFilter();
